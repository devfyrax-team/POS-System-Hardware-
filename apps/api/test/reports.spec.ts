import { auth, createApp, TestCtx } from './helpers';
import { addProduct, Ctx, openingStock, sell, setupShop, till } from './inv-helpers';

describe('profit reports and dashboard', () => {
  let t: TestCtx;
  let c: Ctx;
  let branch: string;
  let cashierTill: Awaited<ReturnType<typeof till>>;
  let mgrTill: Awaited<ReturnType<typeof till>>;

  const item = async (name: string, qty: string, cost: string, price: string, extra: any = {}) => {
    const p = await addProduct(t, c.owner, { name, price, ...extra });
    await openingStock(t, c.storekeeper, branch, [{ productId: p.id, qtyBase: qty, unitCost: cost }]);
    return p;
  };

  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t);
    branch = c.shop.defaultBranchId;
    cashierTill = await till(t, c, 'RP-T1');
    mgrTill = await till(t, c, 'RP-T2', 'manager');
  });
  afterAll(() => t.close());

  it('estimated gross profit = sales - returns - cost of goods sold (net of returned goods); voided sales are excluded', async () => {
    const shop = await setupShop(t);
    const a = await till(t, shop, 'GP-T1');
    const m = await till(t, shop, 'GP-T2', 'manager');
    const mk = async (name: string, cost: string, price: string) => {
      const p = await addProduct(t, shop.owner, { name, price, category: name.startsWith('Tool') ? 'Tools' : 'Fasteners' });
      await openingStock(t, shop.storekeeper, shop.shop.defaultBranchId, [{ productId: p.id, qtyBase: '100', unitCost: cost }]);
      return p;
    };
    const hammer = await mk('Tool Hammer', '600', '1000');
    const nails = await mk('Nails', '200', '300');
    const s1 = await sell(t, a.token, { lines: [{ productId: hammer.id, qty: '2' }, { productId: nails.id, qty: '3' }], payments: [{ method: 'cash', amount: '3000' }] }); // 2900, cogs 1800
    const s2 = await sell(t, a.token, { lines: [{ productId: hammer.id, qty: '1' }], payments: [{ method: 'cash', amount: '1000' }] }); // voided below
    await t.http().post(`/v1/sales/${s2.body.saleId}/void`).set(auth(m.token)).send({ reason: 'x' }).expect(200);
    await t.http().post('/v1/returns').set(auth(m.token)).send({ saleId: s1.body.saleId, lines: [{ saleLineId: s1.body.lines[0].lineId, qty: '1' }], reason: 'r', refundMethod: 'cash' }).expect(201); // 1 hammer back

    const r = (await t.http().get('/v1/reports/profit').set(auth(m.token))).body;
    expect(r).toMatchObject({ bills: 1, sales: '2900', returns: '1000', netSales: '1900', cogs: '1200', estimatedGrossProfit: '700', marginPct: '36.8' });

    const byItem = (await t.http().get('/v1/reports/profit/by/item').set(auth(m.token))).body;
    expect(byItem.find((x: any) => x.label === 'Tool Hammer')).toMatchObject({ revenue: '2000', cogs: '1200', profit: '800' });
    const byCat = (await t.http().get('/v1/reports/profit/by/category').set(auth(m.token))).body;
    expect(byCat.map((x: any) => x.label).sort()).toEqual(['Fasteners', 'Tools']);
    const byCashier = (await t.http().get('/v1/reports/profit/by/cashier').set(auth(m.token))).body;
    expect(byCashier).toHaveLength(1);
    expect((await t.http().get('/v1/reports/profit/by/nonsense').set(auth(m.token))).status).toBe(400);
  });

  it('repricing, a new delivery at a higher cost and a costing-method change never rewrite past profit', async () => {
    const p = await item('Stable Profit', '10', '50', '100');
    await sell(t, cashierTill.token, { lines: [{ productId: p.id, qty: '2' }], payments: [{ method: 'cash', amount: '200' }] });
    const before = (await t.http().get('/v1/reports/profit/by/item').set(auth(mgrTill.token))).body.find((x: any) => x.label === 'Stable Profit');
    await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.owner)).send({ price: '999' }).expect(200);
    await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId: (await t.http().post('/v1/suppliers').set(auth(c.manager)).send({ name: 'RP Supplier' })).body.id, lines: [{ productId: p.id, qty: '10', unitCost: '90' }] }).expect(201);
    await t.http().patch('/v1/shop/settings').set(auth(c.owner)).send({ costing_method: 'average' }).expect(200);
    const after = (await t.http().get('/v1/reports/profit/by/item').set(auth(mgrTill.token))).body.find((x: any) => x.label === 'Stable Profit');
    expect(after).toEqual(before);
    expect(after).toMatchObject({ revenue: '200', cogs: '100', profit: '100' });
  });

  it('profit and cost are visible only to owner and manager, never cashier or storekeeper', async () => {
    for (const path of ['/v1/reports/profit', '/v1/reports/profit/by/item', '/v1/reports/cost-flags']) {
      expect((await t.http().get(path).set(auth(c.cashier))).status).toBe(403);
      expect((await t.http().get(path).set(auth(c.storekeeper))).status).toBe(403);
      expect((await t.http().get(path).set(auth(c.manager))).status).toBe(200);
      expect((await t.http().get(path).set(auth(c.owner))).status).toBe(200);
    }
    expect((await t.http().get('/v1/reports/dashboard').set(auth(c.cashier))).status).toBe(403);
  });

  it('quiet flags: sold below cost, missing cost, replacement-cost margin; none of them blocks anything', async () => {
    const low = await item('Flag Below', '90', '95', '100');
    const nocost = await addProduct(t, c.owner, { name: 'Flag NoCost', price: '40' });
    await openingStock(t, c.storekeeper, branch, [{ productId: nocost.id, qtyBase: '5' }]);
    await sell(t, mgrTill.token, { lines: [{ productId: low.id, qty: '1', priceOverride: '60' }], payments: [{ method: 'cash', amount: '60' }] });
    const f = (await t.http().get('/v1/reports/cost-flags').set(auth(c.manager))).body;
    expect(f.soldBelowCost.map((x: any) => x.name)).toContain('Flag Below');
    expect(f.missingCost.map((x: any) => x.name)).toContain('Flag NoCost');
    const m = f.replacementMargin.find((x: any) => x.name === 'Flag Below');
    expect(m).toMatchObject({ price: '100', replacementCost: '95' });
    await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId: (await t.http().post('/v1/suppliers').set(auth(c.manager)).send({ name: 'Flag Supplier' })).body.id, lines: [{ productId: low.id, qty: '1', unitCost: '130' }] }).expect(201);
    const f2 = (await t.http().get('/v1/reports/cost-flags').set(auth(c.manager))).body;
    expect(Number(f2.replacementMargin.find((x: any) => x.name === 'Flag Below').marginPct)).toBeLessThan(0); // supplier increase squeezed the margin
  });

  it('dashboard: today, takings by method, low/out stock, overdue credit and cheques due; profit lines only for profit.view', async () => {
    const shop = await setupShop(t);
    const tl = await till(t, shop, 'DB-T1');
    const p = await addProduct(t, shop.owner, { name: 'Dash Item', price: '100', minLevel: '5' });
    await openingStock(t, shop.storekeeper, shop.shop.defaultBranchId, [{ productId: p.id, qtyBase: '6', unitCost: '40' }]);
    await sell(t, tl.token, { lines: [{ productId: p.id, qty: '2' }], payments: [{ method: 'cash', amount: '100' }, { method: 'card', amount: '100' }] });
    const cu = (await t.http().post('/v1/customers').set(auth(shop.owner)).send({ name: 'Dash Cust', creditLimit: '1000' })).body;
    await sell(t, tl.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '1' }], payments: [{ method: 'credit', amount: '100' }] });
    await t.db.admin((tx) => tx.query(`UPDATE credit_entry SET due_date = current_date - 40 WHERE customer_id=$1`, [cu.id]));
    await t.http().post('/v1/customers/' + cu.id + '/payments').set(auth(shop.owner)).send({ amount: '0.01', method: 'cheque', cheque: { chequeNo: '1', chequeDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) } }).expect(201);

    const owner = (await t.http().get('/v1/reports/dashboard').set(auth(shop.owner))).body;
    expect(owner.today).toMatchObject({ bills: 2, sales: '300', cogs: '120', estimatedGrossProfit: '180' });
    expect(owner.byMethod.map((x: any) => [x.method, x.net])).toEqual([['card', '100'], ['cash', '100'], ['credit', '100']]);
    expect(owner.lowStockItems).toBe(1); // 3 left, minimum 5
    expect(owner.overdueCredit).toMatchObject({ customers: 1 });
    expect(owner.chequesDueThisWeek.count).toBe(1);

    // a role with report.view but without profit.view sees the day but not profit
    const role = await t.http().post('/v1/roles').set(auth(shop.owner)).send({ name: 'Supervisor', permissions: ['report.view'] });
    const sup = await t.http().post('/v1/users').set(auth(shop.owner)).send({ email: `sup${Date.now()}@t.lk`, name: 'Sup', roleId: role.body.id, branchId: shop.shop.defaultBranchId, password: 'Passw0rd!x' });
    const { login } = await import('./helpers');
    const supTok = await login(t, sup.body.email);
    const dash = (await t.http().get('/v1/reports/dashboard').set(auth(supTok))).body;
    expect(dash.today.sales).toBe('300');
    expect(dash.today).not.toHaveProperty('estimatedGrossProfit');
    expect(dash.today).not.toHaveProperty('cogs');
  });
});
