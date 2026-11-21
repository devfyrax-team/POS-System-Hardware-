import { D } from '@pos/money';
import { auth, createApp, TestCtx } from './helpers';
import { addProduct, balance, Ctx, ledgerDiffs, sell, setupShop, till } from './inv-helpers';

const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe('paint: colour tinting and damaged tins', () => {
  let t: TestCtx;
  let c: Ctx;
  let branch: string;
  let tl: Awaited<ReturnType<typeof till>>;
  let supplierId: string;

  const buy = (productId: string, qty: string, unitCost: string, extra: any = {}) =>
    t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId, lines: [{ productId, qty, unitCost, ...extra }] }).expect(201);
  const mixBody = (base: string, colorants: { productId: string; ml: string }[], extra: any = {}) => ({ baseProductId: base, baseQty: '4', colourCode: 'ab-12', colourName: 'Sea Blue', colorants, ...extra });

  let base: { id: string };
  let blue: { id: string };
  let red: { id: string };

  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t, { shopType: 'paint' });
    branch = c.shop.defaultBranchId;
    tl = await till(t, c, 'PT-T1');
    supplierId = (await t.http().post('/v1/suppliers').set(auth(c.manager)).send({ name: 'Paint Co' })).body.id;
  });
  afterAll(() => t.close());

  beforeEach(async () => {
    const n = Math.random().toString(36).slice(2, 7);
    base = await addProduct(t, c.owner, { name: `Base White ${n}`, baseUnit: 'L', decimalQty: true, price: '1500', category: 'Paint', trackBatches: true, shelfLifeDays: 730 });
    blue = await addProduct(t, c.owner, { name: `Colorant Blue ${n}`, baseUnit: 'ml', decimalQty: true, category: 'Colorant' });
    red = await addProduct(t, c.owner, { name: `Colorant Red ${n}`, baseUnit: 'ml', decimalQty: true, category: 'Colorant' });
    await buy(base.id, '40', '1000', { batchNo: `W-${n}`, expiryDate: days(300) });
    await buy(blue.id, '500', '2'); // Rs 2 per ml
    await buy(red.id, '500', '3');
  });

  it('a mix consumes base paint and colorant, produces a tinted tin priced like the base, costed at the sum of what went in', async () => {
    const res = await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '60' }, { productId: red.id, ml: '20' }]));
    expect(res.status).toBe(201);
    expect(res.body.qty).toBe('4');
    // cost: 4 L x 1000 + 60 ml x 2 + 20 ml x 3 = 4180 -> 1045 per litre
    expect(res.body.unitCost).toBe('1045');
    expect(await balance(t, branch, base.id)).toBe('36');
    expect(await balance(t, branch, blue.id)).toBe('440');
    expect(await balance(t, branch, red.id)).toBe('480');
    expect(await balance(t, branch, res.body.tintedProductId)).toBe('4');
    const price = (await t.http().get('/v1/products/search').query({ q: 'AB-12' }).set(auth(tl.token))).body[0];
    expect(price).toMatchObject({ id: res.body.tintedProductId, price: '1500.0000', stock: '4.0000' });
    const mv = (await t.db.admin((tx) => tx.query(`SELECT type, qty_base FROM stock_movement WHERE ref_type='tint' AND ref_id='AB-12' AND product_id = ANY($1) ORDER BY id`, [[base.id, blue.id, red.id, res.body.tintedProductId]]))).rows;
    expect(mv.map((m) => m.type).sort()).toEqual(['tint_in', 'tint_out', 'tint_out', 'tint_out']);
    expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    // the tin sells at its mixed cost, so profit is visible and correct
    const sale = await sell(t, tl.token, { lines: [{ productId: res.body.tintedProductId, qty: '1' }], payments: [{ method: 'cash', amount: '1500' }] });
    expect(D((await t.db.admin((tx) => tx.query(`SELECT cogs FROM sale_line WHERE sale_id=$1`, [sale.body.saleId]))).rows[0].cogs).toString()).toBe('1045');
  });

  it('mixing the same colour again reuses the tinted product', async () => {
    const a = await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '60' }]));
    const b = await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '60' }]));
    expect(b.body.tintedProductId).toBe(a.body.tintedProductId);
    expect(await balance(t, branch, a.body.tintedProductId)).toBe('8');
  });

  it('is all-or-nothing: if a colorant is short nothing is consumed or produced', async () => {
    const res = await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '60' }, { productId: red.id, ml: '999' }]));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STOCK_SHORT');
    expect(await balance(t, branch, base.id)).toBe('40');
    expect(await balance(t, branch, blue.id)).toBe('500');
    expect(await balance(t, branch, red.id)).toBe('500');
    expect((await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM tint_job WHERE base_product_id=$1`, [base.id]))).rows[0].c).toBe(0);
  });

  it('two counters mixing at once cannot drive a colorant negative', async () => {
    const mix = () => t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '300' }], { colourCode: `RACE-${Math.random().toString(36).slice(2, 6)}` }));
    const rs = await Promise.all([mix(), mix()]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await balance(t, branch, blue.id)).toBe('200');
    expect(await balance(t, branch, base.id)).toBe('36');
    expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
  });

  it('can use one chosen base batch so the colour matches across a job', async () => {
    const n = Math.random().toString(36).slice(2, 6);
    await buy(base.id, '10', '1100', { batchNo: `W2-${n}`, expiryDate: days(500) });
    const batches = (await t.http().get('/v1/batches').query({ productId: base.id }).set(auth(c.manager))).body;
    const later = batches.find((b: any) => b.batch_no === `W2-${n}`);
    await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '10' }], { preferredBatchId: later.id })).expect(201);
    const after = (await t.http().get('/v1/batches').query({ productId: base.id }).set(auth(c.manager))).body;
    expect(D(after.find((b: any) => b.id === later.id).qty_remaining).toString()).toBe('6');
    expect(D(after.find((b: any) => b.id !== later.id).qty_remaining).toString()).toBe('40');
  });

  describe('formulas and reorders', () => {
    it('the formula is saved against the customer; a reorder scales it to the new quantity', async () => {
      const cu = (await t.http().post('/v1/customers').set(auth(tl.token)).send({ name: 'Painter Silva' })).body;
      await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '60' }, { productId: red.id, ml: '20' }], { customerId: cu.id })).expect(201);
      const f = (await t.http().get(`/v1/tint/formulas/${cu.id}`).set(auth(tl.token))).body;
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ colour_code: 'AB-12', colour_name: 'Sea Blue' });
      expect(f[0].colorants.map((x: any) => D(x.mlPerUnit).toString()).sort()).toEqual(['15', '5']); // per litre
      const re = await t.http().post('/v1/tint/reorder').set(auth(tl.token)).send({ customerId: cu.id, colourCode: 'ab-12', baseQty: '10' });
      expect(re.status).toBe(201);
      expect(await balance(t, branch, blue.id)).toBe('290'); // 500 - 60 - 150
      expect(await balance(t, branch, red.id)).toBe('430'); // 500 - 20 - 50
      expect(await balance(t, branch, re.body.tintedProductId)).toBe('14');
      expect((await t.http().post('/v1/tint/reorder').set(auth(tl.token)).send({ customerId: cu.id, colourCode: 'NOPE', baseQty: '1' })).status).toBe(404);
      expect((await t.http().get('/v1/tint/jobs').query({ customerId: cu.id }).set(auth(tl.token))).body).toHaveLength(2);
    });
  });

  it('tinted paint is non-returnable', async () => {
    const mixed = await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '30' }]));
    const sale = await sell(t, tl.token, { lines: [{ productId: mixed.body.tintedProductId, qty: '1' }], payments: [{ method: 'cash', amount: '1500' }] });
    const m = await till(t, c, `PT-M${Math.random().toString(36).slice(2, 6).toUpperCase()}`, 'manager');
    const ret = await t.http().post('/v1/returns').set(auth(m.token)).send({ saleId: sale.body.saleId, lines: [{ saleLineId: sale.body.lines[0].lineId, qty: '1' }], reason: 'colour wrong', refundMethod: 'cash' });
    expect(ret.status).toBe(400);
    expect(ret.body.message).toMatch(/cannot be returned/);
  });

  it('tinting is a paint-shop feature: hardware-only shops never get it; roles without tint.mix are refused', async () => {
    const hw = await setupShop(t, { shopType: 'hardware', plan: 'enterprise' });
    const tlh = await till(t, hw, 'HW-T1');
    const r = await t.http().post('/v1/tint/mix').set(auth(tlh.token)).send(mixBody('00000000-0000-0000-0000-000000000000', [{ productId: '00000000-0000-0000-0000-000000000000', ml: '1' }]));
    expect(r.body.code).toBe('FEATURE_NOT_ENABLED');
    await t.http().put(`/v1/admin/shops/${hw.shop.shopId}/features`).set(auth(await (await import('./helpers')).platformToken(t))).send({ key: 'colour_tinting', enabled: true }).expect(204);
    expect((await t.http().post('/v1/tint/mix').set(auth(tlh.token)).send(mixBody('00000000-0000-0000-0000-000000000000', [{ productId: '00000000-0000-0000-0000-000000000000', ml: '1' }]))).body.code).toBe('FEATURE_NOT_ENABLED'); // shop type still blocks it

    const role = await t.http().post('/v1/roles').set(auth(c.owner)).send({ name: `NoTint${Math.random().toString(36).slice(2, 6)}`, permissions: ['sale.create'] });
    const { createUser, login } = await import('./helpers');
    const u = await createUser(t, c.owner, { roleId: role.body.id, branchId: branch });
    const tok = await login(t, u.email);
    expect((await t.http().post('/v1/tint/mix').set(auth(tok)).send(mixBody(base.id, [{ productId: blue.id, ml: '1' }]))).status).toBe(403);
  });

  it('rejects empty or invalid mixes', async () => {
    expect((await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, []))).status).toBe(400);
    expect((await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '-5' }]))).status).toBe(400);
    expect((await t.http().post('/v1/tint/mix').set(auth(tl.token)).send(mixBody(base.id, [{ productId: blue.id, ml: '5' }], { baseQty: '0' }))).status).toBe(400);
  });

  describe('damaged tins', () => {
    it('a damaged return stays out of sellable stock; a manager re-lists it at a discount and it sells like any item', async () => {
      const tin = await addProduct(t, c.owner, { name: `Tin ${Math.random().toString(36).slice(2, 6)}`, price: '2000' });
      await buy(tin.id, '10', '1200');
      const sale = await sell(t, tl.token, { lines: [{ productId: tin.id, qty: '2' }], payments: [{ method: 'cash', amount: '4000' }] });
      const m = await till(t, c, `PT-D${Math.random().toString(36).slice(2, 6).toUpperCase()}`, 'manager');
      await t.http().post('/v1/returns').set(auth(m.token)).send({ saleId: sale.body.saleId, lines: [{ saleLineId: sale.body.lines[0].lineId, qty: '1', disposition: 'damaged' }], reason: 'dented', refundMethod: 'cash' }).expect(201);
      expect(await balance(t, branch, tin.id)).toBe('8');
      const dmg = (await t.http().get('/v1/damaged-stock').set(auth(c.manager))).body.find((r: any) => r.product_id === tin.id);
      expect(D(dmg.damaged_qty).toString()).toBe('1');
      expect((await t.http().post('/v1/damaged-stock/relist').set(auth(c.storekeeper)).send({ productId: tin.id, qty: '1', price: '1000' })).status).toBe(403);
      const re = await t.http().post('/v1/damaged-stock/relist').set(auth(c.manager)).send({ productId: tin.id, qty: '1', price: '1000' });
      expect(re.status).toBe(200);
      expect((await t.http().post('/v1/damaged-stock/relist').set(auth(c.manager)).send({ productId: tin.id, qty: '1', price: '1000' })).status).toBe(400); // nothing left to re-list
      expect(await balance(t, branch, re.body.productId)).toBe('1');
      const s2 = await sell(t, tl.token, { lines: [{ productId: re.body.productId, qty: '1' }], payments: [{ method: 'cash', amount: '1000' }] });
      expect(s2.body.total).toBe('1000');
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });
  });
});
