import { Pool } from 'pg';
import { INTEGRITY_CHECK_NAMES, checkIntegrity } from '../src/db/integrity';
import { migrate } from '../src/db/migrate';
import { seedPlatformData } from '../src/db/seed';
import { auth, createApp, TestCtx, uniq } from './helpers';
import { addProduct, Ctx, openingStock, sell, setupShop, till } from './inv-helpers';

describe('database integrity and migrations', () => {
  let t: TestCtx;
  let c: Ctx;
  let pool: Pool;
  beforeAll(async () => {
    t = await createApp();
    pool = t.db.adminPool;
    c = await setupShop(t);
    // a realistic mix of activity so every invariant has something to check
    const tl = await till(t, c, 'IN-T1');
    const p = await addProduct(t, c.owner, { name: 'Integrity Item', price: '100' });
    await openingStock(t, c.storekeeper, c.shop.defaultBranchId, [{ productId: p.id, qtyBase: '50', unitCost: '40' }]);
    const sup = (await t.http().post('/v1/suppliers').set(auth(c.owner)).send({ name: uniq('S') })).body.id;
    await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId: sup, lines: [{ productId: p.id, qty: '20', unitCost: '45' }] }).expect(201);
    const cu = (await t.http().post('/v1/customers').set(auth(c.owner)).send({ name: 'Int Cust', creditLimit: '5000' })).body;
    const s1 = await sell(t, tl.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '5' }], payments: [{ method: 'credit', amount: '500' }] });
    await sell(t, tl.token, { lines: [{ productId: p.id, qty: '3' }], payments: [{ method: 'cash', amount: '300' }, { method: 'card', amount: '0.01' }].slice(0, 1) });
    const m = await till(t, c, 'IN-T2', 'manager');
    await t.http().post('/v1/returns').set(auth(m.token)).send({ saleId: s1.body.saleId, lines: [{ saleLineId: s1.body.lines[0].lineId, qty: '2' }], reason: 'r', refundMethod: 'account_credit' }).expect(201);
    await t.http().post(`/v1/sales/${(await sell(t, tl.token, { lines: [{ productId: p.id, qty: '1' }], payments: [{ method: 'cash', amount: '100' }] })).body.saleId}/void`).set(auth(m.token)).send({ reason: 'x' }).expect(200);
  });
  afterAll(() => t.close());

  it('every invariant holds across all the suites\' activity', async () => {
    expect(await checkIntegrity(pool)).toEqual([]);
    expect(INTEGRITY_CHECK_NAMES.length).toBeGreaterThanOrEqual(10);
  });

  describe('corruption is detected', () => {
    const corrupt = async (sql: string, undo: string, expectName: RegExp) => {
      await pool.query(sql);
      try {
        const v = await checkIntegrity(pool);
        expect(v.map((x) => x.check).join('|')).toMatch(expectName);
      } finally {
        await pool.query(undo);
      }
      expect(await checkIntegrity(pool)).toEqual([]);
    };

    it('a stock balance that no longer matches its ledger', () =>
      corrupt(`UPDATE stock_balance SET quantity = quantity + 1 WHERE shop_id='${c.shop.shopId}'`, `UPDATE stock_balance SET quantity = quantity - 1 WHERE shop_id='${c.shop.shopId}'`, /stock balance equals/));

    it('a customer balance that no longer matches the credit entries', () =>
      corrupt(`UPDATE customer SET balance = balance + 5 WHERE shop_id='${c.shop.shopId}'`, `UPDATE customer SET balance = balance - 5 WHERE shop_id='${c.shop.shopId}'`, /customer balance/));

    it('a sale whose total no longer matches its lines or payments', () =>
      corrupt(`UPDATE sale SET total = total + 1 WHERE id = (SELECT id FROM sale WHERE shop_id='${c.shop.shopId}' LIMIT 1)`, `UPDATE sale SET total = total - 1 WHERE id = (SELECT id FROM sale WHERE shop_id='${c.shop.shopId}' ORDER BY total DESC LIMIT 0) OR false; UPDATE sale SET total = total - 1 WHERE id = (SELECT id FROM sale WHERE shop_id='${c.shop.shopId}' LIMIT 1)`, /sale total/));

    it('a gap in a terminal\'s invoice numbers', () =>
      corrupt(`UPDATE invoice_sequence SET next = next + 1 WHERE shop_id='${c.shop.shopId}'`, `UPDATE invoice_sequence SET next = next - 1 WHERE shop_id='${c.shop.shopId}'`, /invoice numbers/));

    it('layers or batches holding more than the stock balance', () =>
      corrupt(`UPDATE cost_layer SET qty_remaining = qty_remaining + 1 WHERE id = (SELECT max(id) FROM cost_layer WHERE shop_id='${c.shop.shopId}' AND qty_remaining > 0)`, `UPDATE cost_layer SET qty_remaining = qty_remaining - 1 WHERE id = (SELECT max(id) FROM cost_layer WHERE shop_id='${c.shop.shopId}' AND qty_remaining > 0)`, /cost layers/));
  });

  describe('migrations', () => {
    const base = process.env.TEST_PG_BASE ?? 'postgres://postgres:postgres@localhost:5433';

    it('re-running migrations is a no-op', async () => {
      expect(await migrate(`${base}/pos_test`)).toEqual([]);
      const done = (await pool.query(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((r) => r.name);
      expect(done[0]).toBe('001_foundation.sql');
      expect(done.length).toBeGreaterThanOrEqual(7);
    });

    it('upgrading a database that already has data applies only the new migrations and keeps the data', async () => {
      const root = new Pool({ connectionString: `${base}/postgres`, max: 1 });
      await root.query('DROP DATABASE IF EXISTS pos_upgrade_test WITH (FORCE)');
      await root.query('CREATE DATABASE pos_upgrade_test');
      await root.end();
      const url = `${base}/pos_upgrade_test`;
      const first = await migrate(url, 'pos_app', 'pos_app', { limit: 4 });
      expect(first).toHaveLength(4);
      const p = new Pool({ connectionString: url, max: 1 });
      await seedPlatformData(p);
      const plan = (await p.query(`SELECT id FROM plan WHERE code='pro'`)).rows[0].id;
      const shop = (await p.query(`INSERT INTO shop(name, shop_type) VALUES ('Old Shop','hardware') RETURNING id`)).rows[0].id;
      await p.query(`INSERT INTO subscription(shop_id, plan_id) VALUES ($1,$2)`, [shop, plan]);
      const branch = (await p.query(`INSERT INTO branch(shop_id, name) VALUES ($1,'Main') RETURNING id`, [shop])).rows[0].id;
      const prod = (await p.query(`INSERT INTO product(shop_id, sku, name, base_unit) VALUES ($1,'SKU-1','Legacy Item','pcs') RETURNING id`, [shop])).rows[0].id;
      await p.query(`INSERT INTO stock_balance(shop_id, branch_id, product_id, quantity) VALUES ($1,$2,$3,7)`, [shop, branch, prod]);
      await p.query(`INSERT INTO stock_movement(shop_id, branch_id, product_id, type, qty_base) VALUES ($1,$2,$3,'opening',7)`, [shop, branch, prod]);

      const rest = await migrate(url);
      expect(rest.length).toBeGreaterThanOrEqual(3);
      expect(rest[0]).toBe('005_expiry.sql');
      expect((await p.query(`SELECT quantity FROM stock_balance WHERE product_id=$1`, [prod])).rows[0].quantity).toBe('7.0000');
      expect(await checkIntegrity(p)).toEqual([]);
      // the restricted application role still works after the upgrade
      const app = new Pool({ connectionString: url.replace('postgres:postgres@', 'pos_app:pos_app@'), max: 1 });
      const c2 = await app.connect();
      await c2.query('BEGIN');
      await c2.query(`select set_config('app.shop_id', $1, true)`, [shop]);
      expect((await c2.query(`SELECT count(*)::int c FROM product`)).rows[0].c).toBe(1);
      await c2.query('ROLLBACK');
      c2.release();
      await app.end();
      await p.end();
    });
  });
});
