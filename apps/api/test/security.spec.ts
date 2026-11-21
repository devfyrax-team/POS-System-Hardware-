import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { TokenService } from '../src/auth/token.service';
import { auth, createApp, TestCtx, uniq } from './helpers';
import { addProduct, newKey, openingStock, sell, setupShop, till, Ctx } from './inv-helpers';

describe('security hardening', () => {
  let t: TestCtx;
  let A: Ctx;
  let B: Ctx;
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createApp();
    A = await setupShop(t);
    B = await setupShop(t);
    const tl = await till(t, A, 'SEC-T1');
    const p = await addProduct(t, A.owner, { name: 'Secret Product', price: '100' });
    await openingStock(t, A.storekeeper, A.shop.defaultBranchId, [{ productId: p.id, qtyBase: '10', unitCost: '40' }]);
    const sale = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '1' }], payments: [{ method: 'cash', amount: '100' }] });
    const cust = (await t.http().post('/v1/customers').set(auth(A.owner)).send({ name: 'Secret Customer' })).body;
    const sup = (await t.http().post('/v1/suppliers').set(auth(A.owner)).send({ name: uniq('Secret Supplier') })).body;
    const pur = (await t.http().post('/v1/purchases').set(auth(A.manager)).send({ supplierId: sup.id, lines: [{ productId: p.id, qty: '1', unitCost: '10' }] })).body;
    const quote = (await t.http().post('/v1/quotations').set(auth(tl.token)).send({ lines: [{ productId: p.id, qty: '1' }] })).body;
    const imp = (await t.http().post('/v1/imports').set(auth(A.owner)).send({ rows: [{ name: 'x' }] })).body;
    const br = (await t.http().post('/v1/branches').set(auth(A.owner)).send({ name: 'Secret Branch' })).body;
    const role = (await t.http().post('/v1/roles').set(auth(A.owner)).send({ name: 'Secret Role', permissions: ['sale.create'] })).body;
    const term = (await t.http().get('/v1/terminals').set(auth(A.owner))).body[0];
    const st = (await t.http().post('/v1/stocktakes').set(auth(A.owner)).send({ branchId: A.shop.defaultBranchId, productIds: [p.id] })).body;
    ids = { product: p.id, sale: sale.body.saleId, customer: cust.id, supplier: sup.id, purchase: pur.purchaseId, quote: quote.id, import: imp.batchId, branch: br.id, role: role.id, terminal: term.id, user: A.users.cashier, stocktake: st.id };
  });
  afterAll(() => t.close());

  describe('tenant isolation over HTTP (guessing another shop\'s ids)', () => {
    // paths are built lazily: ids exist only after beforeAll
    const reads: [string, () => string][] = [
      ['product', () => `/v1/products/${ids.product}`], ['sale', () => `/v1/sales/${ids.sale}`], ['receipt', () => `/v1/sales/${ids.sale}/receipt`], ['customer', () => `/v1/customers/${ids.customer}`],
      ['customer statement', () => `/v1/customers/${ids.customer}/statement`], ['supplier', () => `/v1/suppliers/${ids.supplier}`], ['supplier statement', () => `/v1/suppliers/${ids.supplier}/statement`],
      ['purchase', () => `/v1/purchases/${ids.purchase}`], ['quotation', () => `/v1/quotations/${ids.quote}`], ['import batch', () => `/v1/imports/${ids.import}`], ['stocktake', () => `/v1/stocktakes/${ids.stocktake}/review`],
      ['delivery status', () => `/v1/delivery-notes/sale/${ids.sale}`], ['price history', () => `/v1/products/${ids.product}/prices/history`],
    ];

    it.each(reads)("%s of another shop is not readable", async (_name, pathOf) => {
      const asB = await t.http().get(pathOf()).set(auth(B.owner));
      expect([403, 404]).toContain(asB.status);
      expect(JSON.stringify(asB.body)).not.toMatch(/Secret/);
    });

    it('writes against another shop\'s records never succeed', async () => {
      const tlB = await till(t, B, 'SEC-B1');
      const attempts = await Promise.all([
        t.http().patch(`/v1/products/${ids.product}`).set(auth(B.owner)).send({ version: 1, name: 'pwned' }),
        t.http().put(`/v1/products/${ids.product}/prices`).set(auth(B.owner)).send({ price: '1' }),
        t.http().post(`/v1/sales/${ids.sale}/void`).set(auth(B.manager)).send({ reason: 'x' }),
        t.http().post(`/v1/customers/${ids.customer}/payments`).set(auth(B.owner)).send({ amount: '1', method: 'cash' }),
        t.http().patch(`/v1/customers/${ids.customer}`).set(auth(B.owner)).send({ version: 1, name: 'pwned' }),
        t.http().post(`/v1/suppliers/${ids.supplier}/payments`).set(auth(B.owner)).send({ amount: '1', method: 'cash' }),
        t.http().post(`/v1/quotations/${ids.quote}/convert`).set(auth(tlB.token)).send({ payments: [] }),
        t.http().delete(`/v1/branches/${ids.branch}`).set(auth(B.owner)),
        t.http().patch(`/v1/roles/${ids.role}`).set(auth(B.owner)).send({ name: 'pwned' }),
        t.http().delete(`/v1/terminals/${ids.terminal}`).set(auth(B.owner)),
        t.http().post(`/v1/users/${ids.user}/deactivate`).set(auth(B.owner)),
        t.http().post(`/v1/imports/${ids.import}/confirm`).set(auth(B.owner)),
        t.http().put(`/v1/stocktakes/${ids.stocktake}/counts`).set(auth(B.storekeeper)).send({ productId: ids.product, qty: '1' }),
      ]);
      for (const r of attempts) expect(r.status).toBeGreaterThanOrEqual(400);
      expect(attempts.filter((r) => r.status >= 500)).toEqual([]);
      const p = (await t.http().get(`/v1/products/${ids.product}`).set(auth(A.owner))).body;
      expect(p.name).toBe('Secret Product');
      expect((await t.http().get(`/v1/sales/${ids.sale}`).set(auth(A.owner))).body.voided).toBe(false);
    });

    it('lists only ever contain the caller\'s own shop', async () => {
      for (const path of ['/v1/products', '/v1/customers', '/v1/suppliers', '/v1/purchases', '/v1/sales', '/v1/stock', '/v1/users', '/v1/branches', '/v1/roles', '/v1/audit-log']) {
        const r = await t.http().get(path).set(auth(B.owner));
        expect(JSON.stringify(r.body)).not.toMatch(/Secret/);
      }
    });

    it('a shop id (or any id) in the request body is ignored: rows land in the caller\'s own shop', async () => {
      const res = await t.http().post('/v1/products').set(auth(B.owner)).send({ name: 'Injected Shop Id', baseUnit: 'pcs', shop_id: A.shop.shopId, shopId: A.shop.shopId, branchId: A.shop.defaultBranchId });
      expect(res.status).toBe(201);
      const row = (await t.db.admin((tx) => tx.query(`SELECT shop_id FROM product WHERE id=$1`, [res.body.id]))).rows[0];
      expect(row.shop_id).toBe(B.shop.shopId);
      // and a user of shop B cannot post stock into shop A's branch
      expect((await t.http().post('/v1/stock/opening').set(auth(B.storekeeper)).send({ branchId: A.shop.defaultBranchId, lines: [{ productId: res.body.id, qtyBase: '5' }] })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('authentication tampering', () => {
    const forge = (claims: object, ttl = 600) => t.app.get(TokenService).sign({ typ: 'access', ...claims }, ttl);

    it('rejects tokens with a changed payload, a wrong signature, no signature, or expired', async () => {
      const real = (await t.http().post('/v1/auth/login').set('x-token-mode', 'body').send({ email: B.shop.ownerEmail, password: 'Passw0rd!x' })).body.accessToken as string;
      const [body, sig] = real.split('.');
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      const tampered = `${Buffer.from(JSON.stringify({ ...claims, sid: A.shop.shopId })).toString('base64url')}.${sig}`;
      for (const token of [tampered, `${body}.AAAA`, body, `${body}.`, '', 'a.b.c']) {
        expect((await t.http().get('/v1/auth/me').set(auth(token))).status).toBe(401);
      }
      const expired = forge({ uid: B.shop.ownerUserId, sid: B.shop.shopId }, -60);
      expect((await t.http().get('/v1/auth/me').set(auth(expired))).status).toBe(401);
    });

    it('a signed token for a user who does not exist, or who was deactivated, grants nothing', async () => {
      const ghost = forge({ uid: '11111111-1111-4111-8111-111111111111', sid: B.shop.shopId });
      expect([401, 403]).toContain((await t.http().get('/v1/auth/me').set(auth(ghost))).status);
      expect((await t.http().get('/v1/products').set(auth(ghost))).status).toBeGreaterThanOrEqual(400);
      const u = A.users.cashier;
      const tok = A.cashier;
      expect((await t.http().get('/v1/auth/me').set(auth(tok))).status).toBe(200);
      await t.http().post(`/v1/users/${u}/deactivate`).set(auth(A.owner)).expect(204);
      expect((await t.http().get('/v1/auth/me').set(auth(tok))).status).toBe(401); // existing token dies with the account
    });

    it('a shop token never works on admin routes and vice versa; a tampered platform flag fails', async () => {
      const real = (await t.http().post('/v1/auth/login').set('x-token-mode', 'body').send({ email: B.shop.ownerEmail, password: 'Passw0rd!x' })).body.accessToken as string;
      const [body, sig] = real.split('.');
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      const promoted = `${Buffer.from(JSON.stringify({ ...claims, plat: true, aid: claims.uid })).toString('base64url')}.${sig}`;
      expect((await t.http().get('/v1/admin/shops').set(auth(promoted))).status).toBe(401);
      expect((await t.http().get('/v1/admin/shops').set(auth(real))).status).toBe(403);
    });
  });

  describe('input handling', () => {
    it('SQL injection strings are treated as plain text everywhere we search', async () => {
      const evil = ["'; DROP TABLE product; --", "' OR '1'='1", '%', '_', '\\', '"; SELECT pg_sleep(5); --', '\u0000'];
      for (const q of evil) {
        for (const path of ['/v1/products/search', '/v1/customers/search', '/v1/master/products']) {
          const r = await t.http().get(path).query({ q }).set(auth(B.owner));
          expect(r.status).toBeLessThan(500);
        }
      }
      expect((await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM product`))).rows[0].c).toBeGreaterThan(0);
      const odd = await t.http().post('/v1/products').set(auth(B.owner)).send({ name: "Robert'); DROP TABLE product;--", baseUnit: 'pcs' });
      expect(odd.status).toBe(201);
      expect(odd.body.name).toBe("Robert'); DROP TABLE product;--");
    });

    it('malformed ids and bodies are 4xx, never 500, and never leak SQL', async () => {
      const bad = await Promise.all([
        t.http().get('/v1/products/not-a-uuid').set(auth(B.owner)),
        t.http().get('/v1/sales/123').set(auth(B.owner)),
        t.http().post('/v1/sales').set(auth(B.owner)).set('Idempotency-Key', 'k'.repeat(12)).send('{"lines": "x"'),
        t.http().post('/v1/products').set(auth(B.owner)).send({ name: 123 }),
        t.http().post('/v1/products').set(auth(B.owner)).set('Content-Type', 'application/json').send('not json at all'),
      ]);
      for (const r of bad) {
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        expect(JSON.stringify(r.body)).not.toMatch(/syntax for type|SELECT|relation|stack|at Object/i);
      }
    });

    it('oversized bodies are refused (413)', async () => {
      const r = await t.http().post('/v1/products').set(auth(B.owner)).send({ name: 'x'.repeat(2 * 1024 * 1024), baseUnit: 'pcs' });
      expect(r.status).toBe(413);
    });

    it('money fields reject non-numeric and scientific values', async () => {
      const p = await addProduct(t, B.owner, { name: 'Money Check', price: '10' });
      for (const price of ['1e3', '1,5', 'NaN', '--1', '0x10', '']) {
        expect((await t.http().put(`/v1/products/${p.id}/prices`).set(auth(B.owner)).send({ price })).status).toBe(400);
      }
      void newKey;
    });
  });

  describe('transport, headers and data exposure', () => {
    it('sends security headers, hides the framework, echoes a request id, and never caches API responses', async () => {
      const r = await t.http().get('/v1/auth/me').set(auth(B.owner)).set('X-Request-Id', 'req-123');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect(r.headers['x-request-id']).toBe('req-123');
    });

    it('never returns password hashes, PINs or tokens from user endpoints', async () => {
      const txt = JSON.stringify([(await t.http().get('/v1/users').set(auth(B.owner))).body, (await t.http().get('/v1/auth/me').set(auth(B.owner))).body, (await t.http().get('/v1/audit-log').set(auth(B.owner))).body]);
      expect(txt).not.toMatch(/argon2|password_hash|pin_hash|"token_hash"/i);
    });

    it('unknown routes return JSON, not a stack trace', async () => {
      const r = await t.http().get('/v1/definitely/not/here').set(auth(B.owner));
      expect(r.status).toBe(404);
      expect(r.headers['content-type']).toMatch(/json/);
    });

    it('CORS: only configured origins get credentials; others are refused on preflight', async () => {
      const ok = await createApp({ corsOrigins: ['https://app.example.lk'] });
      const pre = await ok.http().options('/v1/products').set('Origin', 'https://app.example.lk').set('Access-Control-Request-Method', 'POST');
      expect(pre.status).toBe(204);
      expect(pre.headers['access-control-allow-origin']).toBe('https://app.example.lk');
      expect(pre.headers['access-control-allow-credentials']).toBe('true');
      expect((await ok.http().options('/v1/products').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST')).status).toBe(403);
      const simple = await ok.http().get('/health').set('Origin', 'https://evil.example');
      expect(simple.headers['access-control-allow-origin']).toBeUndefined();
      await ok.close();
    });

    it('rate limiting: a burst from one address is cut off with 429 (health checks exempt)', async () => {
      const lim = await createApp({ rateLimitPerMin: 8 });
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await lim.http().get('/v1/auth/me')).status);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(4);
      expect((await lim.http().get('/health')).status).toBe(200);
      await lim.close();
    });

    it('readiness probe checks the database; metrics are for the platform team only', async () => {
      expect((await t.http().get('/health/ready')).body.status).toBe('ready');
      expect((await t.http().get('/v1/admin/metrics').set(auth(B.owner))).status).toBe(403);
      const admin = await (await import('./helpers')).platformToken(t);
      const m = await t.http().get('/v1/admin/metrics').set(auth(admin));
      expect(m.text).toMatch(/pos_requests_total \d+/);
      expect(m.text).toMatch(/pos_errors_total\{class="5xx"\}/);
    });

    it('OpenAPI document lists the API (versioned, documented)', async () => {
      const doc = SwaggerModule.createDocument(t.app, new DocumentBuilder().setTitle('t').build());
      expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/v1/sales', '/v1/products/search', '/v1/transfers', '/v1/tint/mix', '/v1/admin/shops']));
      expect(Object.keys(doc.paths).length).toBeGreaterThan(120);
    });
  });
});
