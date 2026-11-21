import { D } from '@pos/money';
import { auth, createApp, createUser, login, PASSWORD, TestCtx, uniq } from './helpers';
import { addProduct, balance, Ctx, drainOutbox, ledgerDiffs, openingStock, sell, setupShop } from './inv-helpers';

const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe('multi-branch: isolation, transfers, branch reports', () => {
  let t: TestCtx;
  let c: Ctx;
  let main: string;
  let b2: string;
  let mgr1: string; // manager at Main (till session)
  let mgr2: string; // manager at B2 (till session)
  let supplierId: string;

  const terminal = async (branchId: string, prefix: string) => (await t.http().post('/v1/terminals').set(auth(c.owner)).send({ branchId, name: prefix, prefix })).body.id as string;
  const bal = (branchId: string, productId: string) => balance(t, branchId, productId);
  const stockAt = async (branchId: string, productId: string, qty: string, cost: string, extra: any = {}) => {
    // receive via a purchase in that branch (needs a branch-bound session)
    const tok = branchId === main ? mgr1 : mgr2;
    await t.http().post('/v1/purchases').set(auth(tok)).send({ supplierId, lines: [{ productId, qty, unitCost: cost, ...extra }] }).expect(201);
  };
  const item = (name: string, extra: any = {}) => addProduct(t, c.owner, { name: `${name} ${uniq('i')}`, price: '300', ...extra });

  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t);
    main = c.shop.defaultBranchId;
    b2 = (await t.http().post('/v1/branches').set(auth(c.owner)).send({ name: 'Galle' })).body.id;
    const m1 = await terminal(main, 'MN-T1');
    const m2 = await terminal(b2, 'GL-T1');
    mgr1 = await login(t, c.emails.manager, PASSWORD, m1);
    const u2 = await createUser(t, c.owner, { roleId: c.shop.roleIds.manager, branchId: b2 });
    mgr2 = await login(t, u2.email, PASSWORD, m2);
    supplierId = (await t.http().post('/v1/suppliers').set(auth(c.owner)).send({ name: uniq('Sup') })).body.id;
  });
  afterAll(() => t.close());

  describe('branch isolation', () => {
    it('a branch manager sees and changes only their own branch; the owner sees all', async () => {
      const p = await item('Iso');
      await stockAt(main, p.id, '10', '50');
      await stockAt(b2, p.id, '4', '50');
      expect((await t.http().get('/v1/stock').query({ productId: p.id }).set(auth(mgr1))).body.map((r: any) => r.branch_id)).toEqual([main]);
      expect((await t.http().get('/v1/stock').query({ productId: p.id }).set(auth(mgr2))).body.map((r: any) => r.branch_id)).toEqual([b2]);
      expect((await t.http().get('/v1/stock').query({ productId: p.id, branchId: b2 }).set(auth(mgr1))).status).toBe(403);
      expect((await t.http().get('/v1/stock').query({ productId: p.id, branchId: 'all' }).set(auth(mgr1))).status).toBe(403);
      expect((await t.http().get('/v1/stock').query({ productId: p.id, branchId: 'all' }).set(auth(c.owner))).body).toHaveLength(2);
      // writes against the other branch are refused
      expect((await t.http().post('/v1/stock/opening').set(auth(mgr1)).send({ branchId: b2, lines: [{ productId: p.id, qtyBase: '5' }] })).status).toBe(403);
      expect((await t.http().post('/v1/adjustments').set(auth(mgr1)).send({ branchId: b2, reason: 'x', lines: [{ productId: p.id, qtyDelta: '-1' }] })).status).toBe(403);
      expect((await t.http().post('/v1/stocktakes').set(auth(mgr1)).send({ branchId: b2 })).status).toBe(403);
      expect((await t.http().get('/v1/reports/profit').query({ branchId: b2 }).set(auth(mgr1))).status).toBe(403);
      expect(await bal(b2, p.id)).toBe('4');
    });

    it('a branch manager cannot manage users or roles in the other branch', async () => {
      const res = await t.http().post('/v1/users').set(auth(mgr1)).send({ email: `${uniq('x')}@t.lk`, name: 'X', roleId: c.shop.roleIds.cashier, branchId: b2, password: PASSWORD });
      expect(res.status).toBe(403);
    });

    it('single-branch UI mode switches to multi once a second branch exists', async () => {
      const me = (await t.http().get('/v1/auth/me').set(auth(c.owner))).body;
      expect(me.branchMode.mode).toBe('multi');
      const one = await setupShop(t, { plan: 'basic' });
      expect((await t.http().get('/v1/auth/me').set(auth(one.owner))).body.branchMode).toMatchObject({ mode: 'single', singleBranchId: one.shop.defaultBranchId });
    });
  });

  describe('transfers', () => {
    it('request -> approve (sender) -> dispatch -> receive: stock moves, cost travels, nothing is double counted', async () => {
      const p = await item('Trf');
      await stockAt(main, p.id, '10', '100');
      await stockAt(main, p.id, '10', '140');
      const tr = await t.http().post('/v1/transfers').set(auth(mgr2)).send({ fromBranchId: main, toBranchId: b2, lines: [{ productId: p.id, qty: '15' }] });
      expect(tr.status).toBe(201);
      expect(tr.body.status).toBe('requested');
      expect((await t.http().post(`/v1/transfers/${tr.body.id}/approve`).set(auth(mgr2))).status).toBe(403); // only the sending branch approves
      expect((await t.http().post(`/v1/transfers/${tr.body.id}/dispatch`).set(auth(mgr1))).status).toBe(409); // not approved yet
      await t.http().post(`/v1/transfers/${tr.body.id}/approve`).set(auth(mgr1)).expect(200);
      const dispatched = await t.http().post(`/v1/transfers/${tr.body.id}/dispatch`).set(auth(mgr1)).send({});
      expect(dispatched.body.status).toBe('in_transit');
      expect(await bal(main, p.id)).toBe('5');
      expect(await bal(b2, p.id)).toBe('0'); // in transit: in neither branch
      const view = (await t.http().get(`/v1/transfers/${tr.body.id}`).set(auth(mgr1))).body;
      expect(view.lines[0]).toMatchObject({ qty_requested: '15.0000', qty_dispatched: '15.0000', qty_received: '0.0000' });
      expect((await t.http().post(`/v1/transfers/${tr.body.id}/receive`).set(auth(mgr1)).send({ lines: [{ lineId: view.lines[0].id, qty: '15' }] })).status).toBe(403); // only the receiving branch
      const rcv = await t.http().post(`/v1/transfers/${tr.body.id}/receive`).set(auth(mgr2)).send({ lines: [{ lineId: view.lines[0].id, qty: '15' }] });
      expect(rcv.body.status).toBe('received');
      expect(await bal(b2, p.id)).toBe('15');
      // cost inherited: (10 x 100 + 5 x 140) / 15
      const layer = (await t.db.admin((tx) => tx.query(`SELECT unit_cost FROM cost_layer WHERE branch_id=$1 AND product_id=$2`, [b2, p.id]))).rows[0];
      expect(D(layer.unit_cost).toString()).toBe('113.3333');
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
      // selling at the receiving branch uses the inherited cost
      const m2tok = await login(t, (await createUser(t, c.owner, { roleId: c.shop.roleIds.cashier, branchId: b2 })).email, PASSWORD, (await t.http().get('/v1/terminals').query({ branchId: b2 }).set(auth(c.owner))).body[0].id);
      const sale = await sell(t, m2tok, { lines: [{ productId: p.id, qty: '3' }], payments: [{ method: 'cash', amount: '900' }] });
      expect(D((await t.db.admin((tx) => tx.query(`SELECT cogs FROM sale_line WHERE sale_id=$1`, [sale.body.saleId]))).rows[0].cogs).toString()).toBe('339.9999'); // 3 x 113.3333 (cost layers keep 4 decimals)
    });

    it('partial receiving: the rest stays in transit until closed; the shortfall is reported with its value', async () => {
      const p = await item('Partial');
      await stockAt(main, p.id, '20', '200');
      const tr = (await t.http().post('/v1/transfers').set(auth(mgr1)).send({ fromBranchId: main, toBranchId: b2, lines: [{ productId: p.id, qty: '10' }] })).body;
      await t.http().post(`/v1/transfers/${tr.id}/approve`).set(auth(mgr1)).expect(200);
      await t.http().post(`/v1/transfers/${tr.id}/dispatch`).set(auth(mgr1)).send({}).expect(200);
      const lineId = (await t.http().get(`/v1/transfers/${tr.id}`).set(auth(mgr1))).body.lines[0].id;
      const r1 = await t.http().post(`/v1/transfers/${tr.id}/receive`).set(auth(mgr2)).send({ lines: [{ lineId, qty: '6' }] });
      expect(r1.body.status).toBe('in_transit');
      expect((await t.http().post(`/v1/transfers/${tr.id}/receive`).set(auth(mgr2)).send({ lines: [{ lineId, qty: '5' }] })).status).toBe(400); // only 4 still expected
      await t.http().post(`/v1/transfers/${tr.id}/receive`).set(auth(mgr2)).send({ lines: [{ lineId, qty: '3' }] }).expect(200);
      const closed = await t.http().post(`/v1/transfers/${tr.id}/close`).set(auth(mgr2)).expect(200);
      expect(closed.body).toMatchObject({ status: 'closed', discrepancies: [{ productId: p.id, missing: '1', value: '200' }] });
      expect(await bal(b2, p.id)).toBe('9');
      expect(await bal(main, p.id)).toBe('10');
      await drainOutbox(t);
      expect((await t.http().get('/v1/notifications').set(auth(c.owner))).body.some((n: any) => n.type === 'transfer.discrepancy')).toBe(true);
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('dispatch fails cleanly when the source lacks stock; the transfer stays approved', async () => {
      const p = await item('NoStock');
      await stockAt(main, p.id, '2', '10');
      const tr = (await t.http().post('/v1/transfers').set(auth(mgr2)).send({ fromBranchId: main, toBranchId: b2, lines: [{ productId: p.id, qty: '5' }] })).body;
      await t.http().post(`/v1/transfers/${tr.id}/approve`).set(auth(mgr1)).expect(200);
      const d = await t.http().post(`/v1/transfers/${tr.id}/dispatch`).set(auth(mgr1)).send({});
      expect(d.body.code).toBe('STOCK_SHORT');
      expect(await bal(main, p.id)).toBe('2');
      expect((await t.http().get(`/v1/transfers/${tr.id}`).set(auth(mgr1))).body.status).toBe('approved');
      // the sender can dispatch fewer units than requested
      const lineId = (await t.http().get(`/v1/transfers/${tr.id}`).set(auth(mgr1))).body.lines[0].id;
      await t.http().post(`/v1/transfers/${tr.id}/dispatch`).set(auth(mgr1)).send({ lines: [{ lineId, qty: '2' }] }).expect(200);
      expect(await bal(main, p.id)).toBe('0');
    });

    it('batches and expiry travel with the stock and are recreated at the destination', async () => {
      const p = await item('Batch Trf', { trackBatches: true, shelfLifeDays: 365 });
      await stockAt(main, p.id, '6', '900', { batchNo: 'X-1', expiryDate: days(100) });
      const tr = (await t.http().post('/v1/transfers').set(auth(mgr2)).send({ fromBranchId: main, toBranchId: b2, lines: [{ productId: p.id, qty: '4' }] })).body;
      await t.http().post(`/v1/transfers/${tr.id}/approve`).set(auth(mgr1)).expect(200);
      await t.http().post(`/v1/transfers/${tr.id}/dispatch`).set(auth(mgr1)).send({}).expect(200);
      const lineId = (await t.http().get(`/v1/transfers/${tr.id}`).set(auth(mgr1))).body.lines[0].id;
      await t.http().post(`/v1/transfers/${tr.id}/receive`).set(auth(mgr2)).send({ lines: [{ lineId, qty: '4' }] }).expect(200);
      const rows = (await t.db.admin((tx) => tx.query(`SELECT branch_id, batch_no, expiry_date::text e, qty_remaining FROM stock_batch WHERE product_id=$1 ORDER BY branch_id`, [p.id]))).rows;
      const at = (b: string) => rows.find((r) => r.branch_id === b);
      expect(at(main)).toMatchObject({ batch_no: 'X-1', e: days(100) });
      expect(D(at(main).qty_remaining).toString()).toBe('2');
      expect(at(b2)).toMatchObject({ batch_no: 'X-1', e: days(100) });
      expect(D(at(b2).qty_remaining).toString()).toBe('4');
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('rejected transfers move nothing; a transfer is a plan feature and needs transfer.manage', async () => {
      const p = await item('Rej');
      await stockAt(main, p.id, '3', '10');
      const tr = (await t.http().post('/v1/transfers').set(auth(mgr2)).send({ fromBranchId: main, toBranchId: b2, lines: [{ productId: p.id, qty: '2' }] })).body;
      await t.http().post(`/v1/transfers/${tr.id}/reject`).set(auth(mgr1)).expect(204);
      expect((await t.http().post(`/v1/transfers/${tr.id}/approve`).set(auth(mgr1))).status).toBe(409);
      expect(await bal(main, p.id)).toBe('3');
      expect((await t.http().post('/v1/transfers').set(auth(c.cashier)).send({ fromBranchId: main, toBranchId: b2, lines: [{ productId: p.id, qty: '1' }] })).status).toBe(403);
      expect((await t.http().post('/v1/transfers').set(auth(mgr1)).send({ fromBranchId: main, toBranchId: main, lines: [{ productId: p.id, qty: '1' }] })).status).toBe(400);
      const basic = await setupShop(t, { plan: 'basic' });
      expect((await t.http().get('/v1/transfers').set(auth(basic.owner))).body.code).toBe('FEATURE_NOT_ENABLED');
    });
  });

  it('branch report compares branches; stock value only for roles that may see cost', async () => {
    const shop = await setupShop(t);
    const second = (await t.http().post('/v1/branches').set(auth(shop.owner)).send({ name: 'Second' })).body.id;
    const tid = (await t.http().post('/v1/terminals').set(auth(shop.owner)).send({ branchId: shop.shop.defaultBranchId, name: 'T', prefix: uniq('R').toUpperCase().slice(0, 8) })).body.id;
    const tok = await login(t, shop.emails.cashier, PASSWORD, tid);
    const p = await addProduct(t, shop.owner, { name: 'Rep Item', price: '100' });
    await openingStock(t, shop.storekeeper, shop.shop.defaultBranchId, [{ productId: p.id, qtyBase: '10', unitCost: '40' }]);
    await sell(t, tok, { lines: [{ productId: p.id, qty: '2' }], payments: [{ method: 'cash', amount: '200' }] });
    const rep = (await t.http().get('/v1/reports/branches').set(auth(shop.owner))).body;
    expect(rep.map((r: any) => r.branch).sort()).toEqual(['Main', 'Second']);
    expect(rep.find((r: any) => r.branch === 'Main')).toMatchObject({ bills: 1, sales: '200', unitsInStock: '8', stockValue: '320' });
    expect(rep.find((r: any) => r.branchId === second)).toMatchObject({ bills: 0, sales: '0' });
    // a role with report.view but no cost.view
    const role = (await t.http().post('/v1/roles').set(auth(shop.owner)).send({ name: 'Viewer', permissions: ['report.view'] })).body;
    const u = await createUser(t, shop.owner, { roleId: role.id, branchId: null });
    const v = (await t.http().get('/v1/reports/branches').set(auth(await login(t, u.email)))).body;
    expect(v[0]).not.toHaveProperty('stockValue');
  });
});
