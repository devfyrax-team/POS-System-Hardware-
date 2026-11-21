import { D } from '@pos/money';
import { ExpiryService } from '../src/inventory/expiry.module';
import { auth, createApp, TestCtx } from './helpers';
import { addProduct, balance, Ctx, drainOutbox, ledgerDiffs, sell, setupShop, till } from './inv-helpers';

const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

describe('batches and expiry (paint)', () => {
  let t: TestCtx;
  let c: Ctx;
  let branch: string;
  let tl: Awaited<ReturnType<typeof till>>;
  let tl2: Awaited<ReturnType<typeof till>>;
  let supplierId: string;

  const tin = (name: string, extra: any = {}) => addProduct(t, c.owner, { name, baseUnit: 'pcs', trackBatches: true, shelfLifeDays: 730, price: '5000', category: 'Paint', ...extra });
  const receive = async (productId: string, qty: string, batchNo: string, expiryDate?: string, mfgDate?: string) => {
    const r = await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId, lines: [{ productId, qty, unitCost: '3000', batchNo, expiryDate, mfgDate }] });
    if (r.status !== 201) throw new Error(`receive ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const batchQty = async (productId: string) =>
    (await t.db.admin((tx) => tx.query(`SELECT batch_no, qty_remaining FROM stock_batch WHERE product_id=$1 ORDER BY expiry_date NULLS LAST`, [productId]))).rows.map((r) => [r.batch_no, D(r.qty_remaining).toString()]);
  const batchesMatchBalance = async () =>
    (
      await t.db.admin((tx) =>
        tx.query(
          `SELECT p.name FROM product p JOIN stock_balance sb ON sb.product_id=p.id
           WHERE p.shop_id=$1 AND p.track_batches AND sb.quantity <> coalesce((SELECT sum(qty_remaining) FROM stock_batch b WHERE b.product_id=p.id AND b.branch_id=sb.branch_id),0)`,
          [c.shop.shopId],
        ),
      )
    ).rows;

  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t, { shopType: 'paint' });
    branch = c.shop.defaultBranchId;
    tl = await till(t, c, 'EX-T1');
    tl2 = await till(t, c, 'EX-T2');
    supplierId = (await t.http().post('/v1/suppliers').set(auth(c.manager)).send({ name: 'Paint Distributors', returnTerms: 'Returnable until 30 days before expiry' })).body.id;
  });
  afterAll(() => t.close());

  describe('batch allocation at the till', () => {
    it('sells the earliest-expiring batch first and keeps batch totals equal to the balance', async () => {
      const p = await tin('Emulsion White 4L');
      await receive(p.id, '5', 'LATE', days(300));
      await receive(p.id, '5', 'EARLY', days(40));
      const sale = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '3' }], payments: [{ method: 'cash', amount: '15000' }] });
      expect(sale.status).toBe(201);
      expect(sale.body.lines[0].batchNo).toBe('EARLY');
      expect(await batchQty(p.id)).toEqual([['EARLY', '2'], ['LATE', '5']]);
      expect(await batchesMatchBalance()).toEqual([]);
      const line = (await t.db.admin((tx) => tx.query(`SELECT batch_id FROM sale_line WHERE sale_id=$1`, [sale.body.saleId]))).rows[0];
      expect(line.batch_id).toBeTruthy();
    });

    it('a line larger than one batch splits across batches (earliest first); cost comes from each batch', async () => {
      const p = await tin('Enamel Black 1L');
      await receive(p.id, '4', 'B1', days(30));
      await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId, lines: [{ productId: p.id, qty: '6', unitCost: '3600', batchNo: 'B2', expiryDate: days(90) }] }).expect(201);
      const sale = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '7' }], payments: [{ method: 'cash', amount: '35000' }] });
      expect(sale.status).toBe(201);
      expect(await batchQty(p.id)).toEqual([['B1', '0'], ['B2', '3']]);
      const cogs = (await t.db.admin((tx) => tx.query(`SELECT cogs FROM sale_line WHERE sale_id=$1`, [sale.body.saleId]))).rows[0].cogs;
      expect(D(cogs).toString()).toBe('4*3000 + 3*3600'.split('+').map((x) => x.split('*').map(Number).reduce((a, b) => a * b)).reduce((a, b) => a + b).toString()); // 12000 + 10800
      expect(await batchesMatchBalance()).toEqual([]);
    });

    it('the cashier can choose a batch so one job uses tins of the same colour batch', async () => {
      const p = await tin('Weather Shield 10L');
      await receive(p.id, '5', 'COLOUR-A', days(60));
      await receive(p.id, '5', 'COLOUR-B', days(200));
      const batches = (await t.http().get('/v1/batches').query({ productId: p.id }).set(auth(tl.token))).body;
      const b = batches.find((x: any) => x.batch_no === 'COLOUR-B');
      const sale = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '2', batchId: b.id }], payments: [{ method: 'cash', amount: '10000' }] });
      expect(sale.body.lines[0].batchNo).toBe('COLOUR-B');
      expect(await batchQty(p.id)).toEqual([['COLOUR-A', '5'], ['COLOUR-B', '3']]);
      const tooMany = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '9', batchId: b.id }], payments: [{ method: 'cash', amount: '45000' }] });
      expect(tooMany.status).toBe(409);
      const wrong = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '1', batchId: '00000000-0000-0000-0000-000000000000' }], payments: [{ method: 'cash', amount: '5000' }] });
      expect(wrong.status).toBe(400);
    });

    it('two tills racing for one small batch never drive it negative', async () => {
      const p = await tin('Primer Race');
      await receive(p.id, '10', 'ONLY', days(100));
      const rs = await Promise.all([tl, tl2, tl, tl2].map((x) => sell(t, x.token, { lines: [{ productId: p.id, qty: '4' }], payments: [{ method: 'cash', amount: '20000' }] })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
      expect(await batchQty(p.id)).toEqual([['ONLY', '2']]);
      expect(await balance(t, branch, p.id)).toBe('2');
      expect(await batchesMatchBalance()).toEqual([]);
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('voiding or returning a batch sale puts the stock back into the SAME batch', async () => {
      const p = await tin('Return Batch');
      await receive(p.id, '5', 'RB-1', days(50));
      await receive(p.id, '5', 'RB-2', days(150));
      const sale = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '3' }], payments: [{ method: 'cash', amount: '15000' }] });
      expect(await batchQty(p.id)).toEqual([['RB-1', '2'], ['RB-2', '5']]);
      const m = await till(t, c, 'EX-MGR', 'manager');
      await t.http().post(`/v1/sales/${sale.body.saleId}/void`).set(auth(m.token)).send({ reason: 'x' }).expect(200);
      expect(await batchQty(p.id)).toEqual([['RB-1', '5'], ['RB-2', '5']]);
      expect(await batchesMatchBalance()).toEqual([]);
    });

    it('untracked items are unaffected', async () => {
      const p = await addProduct(t, c.owner, { name: 'Plain Brush', price: '300' });
      await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId, lines: [{ productId: p.id, qty: '5', unitCost: '100' }] }).expect(201);
      const sale = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '2' }], payments: [{ method: 'cash', amount: '600' }] });
      expect(sale.status).toBe(201);
      expect(sale.body.lines[0].batchNo).toBeUndefined();
    });
  });

  describe('expired stock policy (shop setting)', () => {
    const setPolicy = (v: 'block' | 'warn' | 'allow') => t.http().patch('/v1/shop/settings').set(auth(c.owner)).send({ expired_stock_policy: v }).expect(200);
    const expire = (productId: string, batchNo: string) => t.db.admin((tx) => tx.query(`UPDATE stock_batch SET expiry_date = current_date - 5 WHERE product_id=$1 AND batch_no=$2`, [productId, batchNo]));

    it('warn (default): good batches are sold first; expired ones go last and are flagged', async () => {
      await setPolicy('warn');
      const p = await tin('Policy Warn');
      await receive(p.id, '3', 'OLD', days(10));
      await receive(p.id, '3', 'FRESH', days(200));
      await expire(p.id, 'OLD');
      const s1 = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '2' }], payments: [{ method: 'cash', amount: '10000' }] });
      expect(s1.body.lines[0]).toMatchObject({ batchNo: 'FRESH' });
      expect(s1.body.lines[0].expired).toBeUndefined();
      const s2 = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '3' }], payments: [{ method: 'cash', amount: '15000' }] }); // 1 fresh + 2 expired
      expect(s2.status).toBe(201);
      expect(s2.body.lines[0].expired).toBe(true);
    });

    it('block: expired batches cannot be sold, even if chosen; allow: sold normally', async () => {
      const p = await tin('Policy Block');
      await receive(p.id, '3', 'DEAD', days(10));
      await expire(p.id, 'DEAD');
      await setPolicy('block');
      const blocked = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '1' }], payments: [{ method: 'cash', amount: '5000' }] });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('STOCK_SHORT');
      const id = (await t.http().get('/v1/batches').query({ productId: p.id }).set(auth(tl.token))).body[0].id;
      expect((await sell(t, tl.token, { lines: [{ productId: p.id, qty: '1', batchId: id }], payments: [{ method: 'cash', amount: '5000' }] })).status).toBe(400);
      await setPolicy('allow');
      expect((await sell(t, tl.token, { lines: [{ productId: p.id, qty: '1' }], payments: [{ method: 'cash', amount: '5000' }] })).status).toBe(201);
      await setPolicy('warn');
    });
  });

  describe('expiry alerts and reports', () => {
    it('daily scan alerts once per window (180/90/30 for paint), again when a tighter window is reached, and 0 when expired', async () => {
      const scan = () => t.db.tenant({ shopId: c.shop.shopId }, (tx) => t.app.get(ExpiryService).scan(tx, c.shop.shopId));
      await scan(); // flush alerts raised by batches from the earlier tests
      const p = await tin('Alert Paint');
      await receive(p.id, '4', 'AL-1', days(150));
      const inbox = async () => (await t.http().get('/v1/notifications').set(auth(c.storekeeper))).body.filter((n: any) => n.payload?.batchNo === 'AL-1');
      expect(await scan()).toBe(1); // inside 180
      expect(await scan()).toBe(0); // nothing new
      await drainOutbox(t);
      expect((await inbox()).map((n: any) => n.type)).toEqual(['stock.expiring']);
      await t.db.admin((tx) => tx.query(`UPDATE stock_batch SET expiry_date = current_date + 80 WHERE batch_no='AL-1' AND product_id=$1`, [p.id]));
      expect(await scan()).toBe(1); // tightened to 90
      await t.db.admin((tx) => tx.query(`UPDATE stock_batch SET expiry_date = current_date + 20 WHERE batch_no='AL-1' AND product_id=$1`, [p.id]));
      expect(await scan()).toBe(1); // 30
      await t.db.admin((tx) => tx.query(`UPDATE stock_batch SET expiry_date = current_date - 1 WHERE batch_no='AL-1' AND product_id=$1`, [p.id]));
      expect(await scan()).toBe(1); // expired
      await drainOutbox(t);
      const notes = await inbox();
      expect(notes.map((n: any) => n.payload.band)).toEqual([0, 30, 90, 180]);
      expect(notes[0]).toMatchObject({ type: 'stock.expired' });
      expect((await t.http().get('/v1/notifications').set(auth(c.cashier))).body.filter((n: any) => n.payload?.batchNo === 'AL-1')).toHaveLength(0);
    });

    it('windows are configurable per category', async () => {
      await t.http().patch('/v1/shop/settings').set(auth(c.owner)).send({ expiry_windows_by_category: { Cement: [14] } }).expect(200);
      const cement = await tin('Cement Bag', { category: 'Cement' });
      const paint = await tin('Paint Cat', { category: 'Paint' });
      await receive(cement.id, '10', 'CM-1', days(60));
      await receive(paint.id, '10', 'PT-1', days(60));
      const out = await t.db.tenant({ shopId: c.shop.shopId }, async (tx) => {
        const svc = t.app.get(ExpiryService);
        const settings = (await tx.query(`SELECT settings FROM shop WHERE id=$1`, [c.shop.shopId])).rows[0].settings;
        return { cement: svc.bandFor(60, svc.windowsFor(settings, 'Cement')), paint: svc.bandFor(60, svc.windowsFor(settings, 'Paint')), tight: svc.bandFor(10, svc.windowsFor(settings, 'Cement')) };
      });
      expect(out).toEqual({ cement: null, paint: 90, tight: 14 });
    });

    it('near-expiry report: stock value at cost by branch and supplier, with next steps', async () => {
      const p = await tin('Report Paint');
      await receive(p.id, '5', 'RP-1', days(45));
      const r = (await t.http().get('/v1/reports/near-expiry').query({ withinDays: 60 }).set(auth(c.storekeeper))).body;
      const item = r.items.find((i: any) => i.batchNo === 'RP-1');
      expect(item).toMatchObject({ qty: '5', value: '15000', supplier: 'Paint Distributors', actions: expect.arrayContaining(['mark_down', 'return_to_supplier']) });
      expect(D(r.totalValue).gte(15000)).toBe(true);
      expect(r.bySupplier.find((s: any) => s.supplier === 'Paint Distributors')).toBeTruthy();
      const prop = (await t.http().get('/v1/reports/supplier-returns').set(auth(c.manager))).body.find((g: any) => g.supplier === 'Paint Distributors');
      expect(prop.returnTerms).toMatch(/30 days/);
      expect(prop.batches.map((b: any) => b.batchNo)).toContain('RP-1');
      expect((await t.http().get('/v1/reports/near-expiry').set(auth(c.cashier))).status).toBe(403);
    });

    it('expired stock is written off through the ledger by an authorized user; only expired batches', async () => {
      const p = await tin('Writeoff Paint');
      await receive(p.id, '6', 'WO-1', days(100));
      await receive(p.id, '4', 'WO-2', days(100));
      const batches = (await t.http().get('/v1/batches').query({ productId: p.id }).set(auth(c.manager))).body;
      const wo1 = batches.find((b: any) => b.batch_no === 'WO-1').id;
      expect((await t.http().post('/v1/batches/write-off').set(auth(c.manager)).send({ batchIds: [wo1] })).status).toBe(409); // not expired
      await t.db.admin((tx) => tx.query(`UPDATE stock_batch SET expiry_date = current_date - 3 WHERE id=$1`, [wo1]));
      expect((await t.http().post('/v1/batches/write-off').set(auth(c.storekeeper)).send({ batchIds: [wo1] })).status).toBe(403);
      const res = await t.http().post('/v1/batches/write-off').set(auth(c.manager)).send({ batchIds: [wo1], reason: 'expired on shelf' });
      expect(res.body).toEqual({ qty: '6', value: '18000' });
      expect(await balance(t, branch, p.id)).toBe('4');
      const mv = (await t.db.admin((tx) => tx.query(`SELECT type, qty_base FROM stock_movement WHERE product_id=$1 AND type='expired'`, [p.id]))).rows;
      expect(mv).toHaveLength(1);
      expect(await batchesMatchBalance()).toEqual([]);
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });
  });

  it('batch and expiry tracking is a plan feature', async () => {
    const basic = await setupShop(t, { plan: 'basic' });
    expect((await t.http().get('/v1/reports/near-expiry').set(auth(basic.owner))).body.code).toBe('FEATURE_NOT_ENABLED');
    expect((await t.http().get('/v1/batches').set(auth(basic.owner))).body.code).toBe('FEATURE_NOT_ENABLED');
  });
});
