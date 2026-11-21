import { auth, createApp, createUser, login, PASSWORD, platformToken, provisionShop, TestCtx } from './helpers';
import { addProduct, drainOutbox, openingStock, sell, setupShop, till } from './inv-helpers';

describe('subscriptions, platform billing, export and analytics', () => {
  let t: TestCtx;
  let admin: string;
  beforeAll(async () => {
    t = await createApp();
    admin = await platformToken(t);
  });
  afterAll(() => t.close());

  const sub = async (shopId: string) => (await t.db.admin((tx) => tx.query(`SELECT status, grace_until, current_period_end, trial_ends_at FROM subscription WHERE shop_id=$1`, [shopId]))).rows[0];
  const lifecycle = () => t.http().post('/v1/admin/subscriptions/run-lifecycle').set(auth(admin)).expect(200);

  describe('platform invoices', () => {
    it('invoice -> partial payment keeps it open -> full payment marks it paid and extends the subscription', async () => {
      const shop = await provisionShop(t, { plan: 'pro' });
      const owner = await login(t, shop.ownerEmail);
      const inv = (await t.http().post(`/v1/admin/shops/${shop.shopId}/invoices`).set(auth(admin)).send({ period: 'monthly' })).body;
      expect(inv.amount).toBe('7500.00');
      expect(inv.number).toMatch(/^PINV-\d{4}-\d{5}$/);
      const p1 = await t.http().post(`/v1/admin/invoices/${inv.id}/payments`).set(auth(admin)).send({ amount: '5000', method: 'bank_transfer', reference: 'T1' });
      expect(p1.body).toMatchObject({ status: 'open', balance: '2500' });
      expect((await t.http().post(`/v1/admin/invoices/${inv.id}/payments`).set(auth(admin)).send({ amount: '3000', method: 'cash' })).status).toBe(400);
      const before = await sub(shop.shopId);
      const p2 = await t.http().post(`/v1/admin/invoices/${inv.id}/payments`).set(auth(admin)).send({ amount: '2500', method: 'cash' });
      expect(p2.body.status).toBe('paid');
      const after = await sub(shop.shopId);
      expect(after.status).toBe('active');
      expect(new Date(after.current_period_end).getTime()).toBeGreaterThan(new Date(before.current_period_end).getTime());
      expect((await t.http().post(`/v1/admin/invoices/${inv.id}/payments`).set(auth(admin)).send({ amount: '1', method: 'cash' })).status).toBe(409);
      // the shop sees only its own invoices, read-only
      const mine = (await t.http().get('/v1/billing/invoices').set(auth(owner))).body;
      expect(mine.map((i: any) => i.number)).toEqual([inv.number]);
      const other = await provisionShop(t);
      expect((await t.http().get('/v1/billing/invoices').set(auth(await login(t, other.ownerEmail)))).body).toEqual([]);
      expect((await t.http().post(`/v1/admin/shops/${shop.shopId}/invoices`).set(auth(owner)).send({})).status).toBe(403);
    });

    it('platform billing is separate from the shop: nothing lands in the shop\'s sales, customers or payments', async () => {
      const shop = await provisionShop(t, { plan: 'pro' });
      const inv = (await t.http().post(`/v1/admin/shops/${shop.shopId}/invoices`).set(auth(admin)).send({})).body;
      await t.http().post(`/v1/admin/invoices/${inv.id}/payments`).set(auth(admin)).send({ amount: inv.amount, method: 'cash' }).expect(201);
      const counts = (await t.db.admin((tx) => tx.query(`SELECT (SELECT count(*)::int FROM payment WHERE shop_id=$1) p, (SELECT count(*)::int FROM sale WHERE shop_id=$1) s, (SELECT count(*)::int FROM customer WHERE shop_id=$1) c`, [shop.shopId]))).rows[0];
      expect(counts).toEqual({ p: 0, s: 0, c: 0 });
    });
  });

  describe('lifecycle: trial / paid period ends -> past due (grace) -> restricted (read-only) -> cancelled', () => {
    it('walks a shop through every stage; owners are notified; paying brings it back', async () => {
      const shop = await setupShop(t, { plan: 'pro' });
      const tl = await till(t, shop, 'LC-T1');
      const p = await addProduct(t, shop.owner, { name: 'Lifecycle Item', price: '100' });
      await openingStock(t, shop.storekeeper, shop.shop.defaultBranchId, [{ productId: p.id, qtyBase: '50', unitCost: '40' }]);
      const sellOne = () => sell(t, tl.token, { lines: [{ productId: p.id, qty: '1' }], payments: [{ method: 'cash', amount: '100' }] });
      expect((await sellOne()).status).toBe(201);

      // paid period ran out
      await t.db.admin((tx) => tx.query(`UPDATE subscription SET current_period_end = now() - interval '1 day' WHERE shop_id=$1`, [shop.shop.shopId]));
      expect((await lifecycle()).body.toPastDue).toBeGreaterThanOrEqual(1);
      let s = await sub(shop.shop.shopId);
      expect(s.status).toBe('past_due');
      expect(new Date(s.grace_until).getTime()).toBeGreaterThan(Date.now());
      const warn = await sellOne();
      expect(warn.status).toBe(201); // still selling during the grace period...
      expect(warn.headers['x-subscription-warning']).toBe('past_due'); // ...with a warning header

      await drainOutbox(t);
      const note = (await t.http().get('/v1/notifications').set(auth(shop.owner))).body.find((n: any) => n.type === 'subscription.past_due');
      expect(note).toBeTruthy();

      // grace over -> restricted: read-only
      await t.db.admin((tx) => tx.query(`UPDATE subscription SET grace_until = now() - interval '1 hour' WHERE shop_id=$1`, [shop.shop.shopId]));
      expect((await lifecycle()).body.toRestricted).toBeGreaterThanOrEqual(1);
      const blocked = await sellOne();
      expect(blocked.status).toBe(402);
      expect(blocked.body.code).toBe('SUBSCRIPTION_RESTRICTED');
      expect((await t.http().get('/v1/products/search').query({ q: 'lifecycle' }).set(auth(tl.token))).status).toBe(200); // reading still works
      expect((await t.http().get('/v1/export').set(auth(shop.owner))).status).toBe(200); // data export always available

      // restricted for too long -> cancelled; export is still there
      await t.db.admin((tx) => tx.query(`UPDATE subscription SET updated_at = now() - interval '31 days' WHERE shop_id=$1`, [shop.shop.shopId]));
      expect((await lifecycle()).body.toCancelled).toBeGreaterThanOrEqual(1);
      expect((await sub(shop.shop.shopId)).status).toBe('cancelled');
      expect((await t.http().get('/v1/export').set(auth(shop.owner))).status).toBe(200);
      expect((await sellOne()).status).toBe(402);

      // paying the invoice brings the shop back
      const inv = (await t.http().post(`/v1/admin/shops/${shop.shop.shopId}/invoices`).set(auth(admin)).send({})).body;
      await t.http().post(`/v1/admin/invoices/${inv.id}/payments`).set(auth(admin)).send({ amount: inv.amount, method: 'bank_transfer' }).expect(201);
      expect((await sub(shop.shop.shopId)).status).toBe('active');
      expect((await sellOne()).status).toBe(201);
    });

    it('an expired trial moves to past due; paid-up shops are left alone', async () => {
      const trial = await provisionShop(t, { plan: 'basic' });
      await t.db.admin((tx) => tx.query(`UPDATE subscription SET status='trial', trial_ends_at = now() - interval '1 day' WHERE shop_id=$1`, [trial.shopId]));
      const healthy = await provisionShop(t, { plan: 'pro' });
      await lifecycle();
      expect((await sub(trial.shopId)).status).toBe('past_due');
      expect((await sub(healthy.shopId)).status).toBe('active');
    });

    it('a suspended shop is blocked entirely, including export', async () => {
      const shop = await provisionShop(t);
      const owner = await login(t, shop.ownerEmail);
      await t.http().patch(`/v1/admin/shops/${shop.shopId}/status`).set(auth(admin)).send({ status: 'suspended' }).expect(200);
      expect((await t.http().get('/v1/export').set(auth(owner))).status).toBe(402);
    });
  });

  describe('data export', () => {
    it('contains the shop\'s own products, sales, customers, suppliers and stock history, and nothing from other shops', async () => {
      const shop = await setupShop(t);
      const other = await setupShop(t);
      const tl = await till(t, shop, 'EXP-T1');
      const p = await addProduct(t, shop.owner, { name: 'Export Item', price: '100' });
      await addProduct(t, other.owner, { name: 'Other Shop Item', price: '1' });
      await openingStock(t, shop.storekeeper, shop.shop.defaultBranchId, [{ productId: p.id, qtyBase: '5', unitCost: '40' }]);
      await sell(t, tl.token, { lines: [{ productId: p.id, qty: '2' }], payments: [{ method: 'cash', amount: '200' }] });
      await t.http().post('/v1/customers').set(auth(shop.owner)).send({ name: 'Export Cust' });
      await t.http().post('/v1/suppliers').set(auth(shop.manager)).send({ name: 'Export Supplier' });
      const res = await t.http().get('/v1/export').set(auth(shop.owner));
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      const dump = res.body;
      expect(dump.products.map((x: any) => x.name)).toContain('Export Item');
      expect(dump.products.map((x: any) => x.name)).not.toContain('Other Shop Item');
      expect(dump.sales).toHaveLength(1);
      expect(dump.saleLines[0]).toMatchObject({ qty_unit: '2.0000', line_total: '200.00' });
      expect(dump.customers.map((x: any) => x.name)).toEqual(['Export Cust']);
      expect(dump.suppliers.map((x: any) => x.name)).toEqual(['Export Supplier']);
      expect(dump.stockMovements.map((m: any) => m.type)).toEqual(expect.arrayContaining(['opening', 'sale']));
      expect(JSON.stringify(dump)).not.toMatch(/password|pin_hash|token/i);
      expect((await t.http().get('/v1/export').set(auth(shop.cashier))).status).toBe(403);
      expect((await t.http().get('/v1/audit-log?action=shop.exported').set(auth(shop.owner))).body.length).toBe(1);
    });
  });

  describe('Super Admin analytics and health', () => {
    it('aggregate counts only: no shop sales detail is exposed', async () => {
      await provisionShop(t, { plan: 'pro' });
      const a = (await t.http().get('/v1/admin/analytics').set(auth(admin))).body;
      expect(a.shops_total).toBeGreaterThan(0);
      expect(Object.keys(a).sort()).toEqual(['active_terminals', 'active_users', 'branches', 'plan_mix', 'shops_by_status', 'shops_total', 'signups_by_month', 'subscriptions_by_status']);
      expect(a.plan_mix.pro).toBeGreaterThan(0);
      const owner = await login(t, (await provisionShop(t)).ownerEmail);
      expect((await t.http().get('/v1/admin/analytics').set(auth(owner))).status).toBe(403);
    });

    it('system health shows queue and event backlog', async () => {
      const h = (await t.http().get('/v1/admin/system-health').set(auth(admin))).body;
      expect(h).toHaveProperty('jobs');
      expect(h).toHaveProperty('outboxBacklog');
      expect(Array.isArray(h.deadJobs)).toBe(true);
      void createUser; void PASSWORD;
    });
  });
});
