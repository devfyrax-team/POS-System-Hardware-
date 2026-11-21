/**
 * Load test: many tills billing at once against a real database.
 *   TILLS=20 SALES=30 npm run load -w apps/api
 * Boots the API in-process on a scratch database (pos_load), provisions a shop, then runs two scenarios:
 *   1. spread: every till sells random items from a catalogue
 *   2. hot item: every till fights for the same limited item (only the available stock may sell)
 * Afterwards it checks the database invariants. Exits non-zero if any invariant breaks or any sale errors unexpectedly.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate';
import { seedPlatformData } from '../src/db/seed';
import { checkIntegrity } from '../src/db/integrity';

const BASE = process.env.TEST_PG_BASE ?? 'postgres://postgres:postgres@localhost:5433';
const TILLS = Number(process.env.TILLS ?? 20);
const SALES = Number(process.env.SALES ?? 30);
const PRODUCTS = Number(process.env.PRODUCTS ?? 40);

const pct = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];

async function main() {
  const root = new Pool({ connectionString: `${BASE}/postgres`, max: 1 });
  await root.query('DROP DATABASE IF EXISTS pos_load WITH (FORCE)');
  await root.query('CREATE DATABASE pos_load');
  await root.end();
  const adminUrl = `${BASE}/pos_load`;
  await migrate(adminUrl);
  const admin = new Pool({ connectionString: adminUrl, max: 4 });
  await seedPlatformData(admin);
  process.env.ADMIN_DATABASE_URL = adminUrl;
  process.env.DATABASE_URL = `postgres://pos_app:pos_app@${BASE.replace(/^postgres:\/\/[^@]+@/, '')}/pos_load`;
  process.env.JWT_SECRET = 'load-test';

  const { AppModule } = await import('../src/app.module');
  const { configureApp } = await import('../src/common/bootstrap');
  const { ShopProvisioningService } = await import('../src/platform/provisioning.service');
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error'] });
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready', 'docs'] });
  configureApp(app, { rateLimitPerMin: 10_000_000, swagger: false });
  await app.listen(0);
  const url = (await app.getUrl()).replace('[::1]', 'localhost');

  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const t0 = performance.now();
    const res = await fetch(`${url}/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-token-mode': 'body', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const ms = performance.now() - t0;
    return { status: res.status, body: await res.json().catch(() => ({})), ms };
  };

  const shop = await app.get(ShopProvisioningService).create({ name: 'Load Shop', shopType: 'both', planCode: 'enterprise', ownerName: 'Owner', ownerEmail: 'owner@load.lk', ownerPassword: 'Passw0rd!x' });
  const owner = (await call('POST', '/auth/login', undefined, { email: 'owner@load.lk', password: 'Passw0rd!x' })).body.accessToken;
  const branchId = shop.defaultBranchId;

  console.log(`Setting up: ${TILLS} tills, ${PRODUCTS} products ...`);
  const tills: string[] = [];
  for (let i = 0; i < TILLS; i++) {
    const term = await call('POST', '/terminals', owner, { branchId, name: `Till ${i}`, prefix: `LD-T${i}` });
    tills.push((await call('POST', '/auth/login', undefined, { email: 'owner@load.lk', password: 'Passw0rd!x', terminalId: term.body.id })).body.accessToken);
  }
  const products: string[] = [];
  for (let i = 0; i < PRODUCTS; i++) {
    const p = await call('POST', '/products', owner, { name: `Load Item ${i}`, baseUnit: 'pcs', price: String(50 + i) });
    products.push(p.body.id);
  }
  await call('POST', '/stock/opening', owner, { branchId, lines: products.map((id) => ({ productId: id, qtyBase: '100000', unitCost: '30' })) });
  const hot = (await call('POST', '/products', owner, { name: 'Hot Item', baseUnit: 'pcs', price: '100' })).body.id;
  const HOT_STOCK = Math.floor((TILLS * SALES) / 2);
  await call('POST', '/stock/opening', owner, { branchId, lines: [{ productId: hot, qtyBase: String(HOT_STOCK), unitCost: '60' }] });

  const run = async (name: string, mk: (till: number, n: number) => unknown) => {
    const lat: number[] = [];
    const codes: Record<number, number> = {};
    const t0 = performance.now();
    await Promise.all(
      tills.map(async (token, ti) => {
        for (let n = 0; n < SALES; n++) {
          const r = await call('POST', '/sales', token, mk(ti, n), { 'idempotency-key': `${name}-${ti}-${n}-${Date.now()}` });
          lat.push(r.ms);
          codes[r.status] = (codes[r.status] ?? 0) + 1;
        }
      }),
    );
    const secs = (performance.now() - t0) / 1000;
    console.log(`\n[${name}] ${lat.length} requests in ${secs.toFixed(1)}s = ${(lat.length / secs).toFixed(0)} sales/s`);
    console.log(`  latency ms: p50 ${pct(lat, 50).toFixed(0)}  p95 ${pct(lat, 95).toFixed(0)}  p99 ${pct(lat, 99).toFixed(0)}  max ${Math.max(...lat).toFixed(0)}`);
    console.log(`  responses: ${JSON.stringify(codes)}`);
    return codes;
  };

  const rnd = (seed: number) => products[(seed * 7919) % products.length];
  const spread = await run('spread', (ti, n) => ({
    lines: [{ productId: rnd(ti * 31 + n), qty: '1' }, { productId: rnd(ti * 17 + n * 3 + 1), qty: '2' }],
    payments: [{ method: 'cash', amount: '1000' }],
  }));
  const hotCodes = await run('hot-item', () => ({ lines: [{ productId: hot, qty: '1' }], payments: [{ method: 'cash', amount: '100' }] }));

  const bad: string[] = [];
  if (Object.keys(spread).some((c) => c !== '201')) bad.push(`spread had non-201 responses: ${JSON.stringify(spread)}`);
  if ((hotCodes[201] ?? 0) !== HOT_STOCK) bad.push(`hot item sold ${hotCodes[201] ?? 0}, expected exactly ${HOT_STOCK}`);
  const left = (await admin.query(`SELECT quantity FROM stock_balance WHERE product_id=$1`, [hot])).rows[0].quantity;
  if (Number(left) !== 0) bad.push(`hot item balance is ${left}, expected 0`);
  const v = await checkIntegrity(admin);
  for (const x of v) bad.push(`INTEGRITY: ${x.check} (${x.count})`);
  console.log(`\nIntegrity: ${v.length ? 'FAILED' : 'all invariants hold'}`);
  await app.close();
  await admin.end();
  if (bad.length) {
    console.error('\nLOAD TEST FAILED:\n - ' + bad.join('\n - '));
    process.exit(1);
  }
  console.log('LOAD TEST PASSED');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
