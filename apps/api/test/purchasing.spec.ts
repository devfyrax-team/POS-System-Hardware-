import { D } from '@pos/money';
import { CreditService } from '../src/customers/credit.service';
import { auth, createApp, TestCtx } from './helpers';
import { addProduct, balance, Ctx, ledgerDiffs, newKey, openingStock, sell, setupShop, till } from './inv-helpers';

describe('purchasing and suppliers', () => {
  let t: TestCtx;
  let c: Ctx;
  let branch: string;
  let supplierId: string;

  const supplier = async (name: string, extra: any = {}) => (await t.http().post('/v1/suppliers').set(auth(c.manager)).send({ name, ...extra })).body.id as string;
  const receive = (body: any, token = c.storekeeper) => t.http().post('/v1/purchases').set(auth(token)).send({ supplierId, ...body });
  const owed = async (id = supplierId) => D((await t.http().get(`/v1/suppliers/${id}`).set(auth(c.manager))).body.balance).toString();

  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t);
    branch = c.shop.defaultBranchId;
    supplierId = await supplier('Lanka Hardware Traders', { paymentTermsDays: 14, returnTerms: 'Expiring stock returnable 60 days before expiry' });
  });
  afterAll(() => t.close());

  it('suppliers: unique name, version-checked edits, return terms kept; only purchasing roles manage them', async () => {
    expect((await t.http().post('/v1/suppliers').set(auth(c.manager)).send({ name: 'lanka hardware traders' })).status).toBe(409);
    const s = (await t.http().get(`/v1/suppliers/${supplierId}`).set(auth(c.manager))).body;
    expect(s.return_terms).toMatch(/Expiring/);
    expect((await t.http().patch(`/v1/suppliers/${supplierId}`).set(auth(c.manager)).send({ version: s.version, phone: '0112223334' })).status).toBe(200);
    expect((await t.http().patch(`/v1/suppliers/${supplierId}`).set(auth(c.manager)).send({ version: s.version, phone: '0' })).status).toBe(409);
    expect((await t.http().post('/v1/suppliers').set(auth(c.cashier)).send({ name: 'Nope' })).status).toBe(403);
    expect((await t.http().post('/v1/suppliers').set(auth(c.storekeeper)).send({ name: 'Nope' })).status).toBe(403);
    expect((await t.http().get('/v1/suppliers').set(auth(c.storekeeper))).status).toBe(200); // can pick a supplier when receiving
  });

  describe('receiving goods', () => {
    it('one receipt: stock, ledger, cost layers, supplier payable and price history; landed cost spread by value', async () => {
      const a = await addProduct(t, c.owner, { name: 'Rcv A' });
      const b = await addProduct(t, c.owner, { name: 'Rcv B' });
      const res = await receive({
        supplierInvoiceNo: 'INV-1001',
        lines: [{ productId: a.id, qty: '10', unitCost: '100' }, { productId: b.id, qty: '5', unitCost: '200' }], // 1000 + 1000
        landedCosts: [{ label: 'transport', amount: '100' }],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ subtotal: '2000', landedCost: '100', total: '2100' });
      expect(await balance(t, branch, a.id)).toBe('10');
      const lines = (await t.db.admin((tx) => tx.query(`SELECT product_id, landed_alloc, unit_cost_base FROM purchase_line WHERE purchase_id=$1 ORDER BY line_cost, product_id`, [res.body.purchaseId]))).rows;
      expect(lines.map((l) => [D(l.landed_alloc).toString(), D(l.unit_cost_base).toString()]).sort()).toEqual([['50', '105'], ['50', '210']]); // (1000+50)/10 and (1000+50)/5
      expect(await owed()).toBe('2100');
      const layer = (await t.db.admin((tx) => tx.query(`SELECT unit_cost, estimated FROM cost_layer WHERE product_id=$1`, [a.id]))).rows[0];
      expect(D(layer.unit_cost).toString()).toBe('105');
      expect(layer.estimated).toBe(false);
      expect((await t.http().get(`/v1/products/${a.id}/purchase-history`).set(auth(c.manager))).body).toHaveLength(1);
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('landed cost rounding: the last line takes the remainder so the total always matches', async () => {
      const ps = await Promise.all([1, 2, 3].map((i) => addProduct(t, c.owner, { name: `Landed ${i}` })));
      const res = await receive({ lines: ps.map((p) => ({ productId: p.id, qty: '3', unitCost: '10' })), landedCosts: [{ label: 'x', amount: '100' }] });
      const sum = (await t.db.admin((tx) => tx.query(`SELECT sum(landed_alloc) s FROM purchase_line WHERE purchase_id=$1`, [res.body.purchaseId]))).rows[0].s;
      expect(D(sum).toString()).toBe('100');
    });

    it('converts selling units (box -> pieces) and costs per base unit', async () => {
      const p = await addProduct(t, c.owner, { name: 'Box Item', units: [{ unit: 'box', factor: '12' }] });
      const res = await receive({ lines: [{ productId: p.id, unit: 'box', qty: '5', unitCost: '1200' }] }); // 6000 for 60 pcs
      expect(res.status).toBe(201);
      expect(await balance(t, branch, p.id)).toBe('60');
      expect(D((await t.db.admin((tx) => tx.query(`SELECT unit_cost_base FROM purchase_line WHERE purchase_id=$1`, [res.body.purchaseId]))).rows[0].unit_cost_base).toString()).toBe('100');
    });

    it('cost-change notices (first receipt, rise, no change); the receipt is never blocked and nothing is repriced automatically', async () => {
      const p = await addProduct(t, c.owner, { name: 'Notice Item', price: '150' });
      const r1 = await receive({ lines: [{ productId: p.id, qty: '10', unitCost: '100' }] });
      expect(r1.body.costChangeNotices).toEqual([{ productId: p.id, name: 'Notice Item', previousCost: null, newCost: '100', changePct: null }]);
      const r2 = await receive({ lines: [{ productId: p.id, qty: '10', unitCost: '120' }] });
      expect(r2.status).toBe(201);
      expect(r2.body.costChangeNotices[0]).toMatchObject({ previousCost: '100', newCost: '120', changePct: '20' });
      const r3 = await receive({ lines: [{ productId: p.id, qty: '1', unitCost: '120' }] });
      expect(r3.body.costChangeNotices).toEqual([]);
      const price = (await t.http().get(`/v1/products/search`).query({ q: 'notice item' }).set(auth(c.cashier))).body[0].price;
      expect(price).toBe('150.0000'); // selling price untouched
    });

    it('FIFO: a price rise between deliveries is reflected exactly in the cost of goods sold', async () => {
      const p = await addProduct(t, c.owner, { name: 'Fifo Buy', price: '200' });
      await receive({ lines: [{ productId: p.id, qty: '10', unitCost: '100' }] });
      await receive({ lines: [{ productId: p.id, qty: '10', unitCost: '140' }] });
      const tl = await till(t, c, 'BUY-T1');
      const sale = await sell(t, tl.token, { lines: [{ productId: p.id, qty: '15' }], payments: [{ method: 'cash', amount: '3000' }] });
      const cogs = (await t.db.admin((tx) => tx.query(`SELECT cogs FROM sale_line WHERE sale_id=$1`, [sale.body.saleId]))).rows[0].cogs;
      expect(D(cogs).toString()).toBe('1700'); // 10x100 + 5x140
    });

    it('purchase orders: draft -> approved -> partial -> received; draft orders cannot be received', async () => {
      const p = await addProduct(t, c.owner, { name: 'PO Item' });
      const po = (await t.http().post('/v1/purchase-orders').set(auth(c.manager)).send({ supplierId, lines: [{ productId: p.id, qty: '100', unitCost: '10' }] })).body;
      expect(po.status).toBe('draft');
      const lineId = (await t.http().get(`/v1/purchase-orders/${po.id}`).set(auth(c.manager))).body.lines[0].id;
      expect((await receive({ poId: po.id, lines: [{ productId: p.id, qty: '10', unitCost: '10', poLineId: lineId }] })).status).toBe(409);
      expect((await t.http().post(`/v1/purchase-orders/${po.id}/approve`).set(auth(c.storekeeper))).status).toBe(403);
      await t.http().post(`/v1/purchase-orders/${po.id}/approve`).set(auth(c.manager)).expect(200);
      await receive({ poId: po.id, lines: [{ productId: p.id, qty: '40', unitCost: '10', poLineId: lineId }] }).then((r) => expect(r.status).toBe(201));
      expect((await t.http().get(`/v1/purchase-orders/${po.id}`).set(auth(c.manager))).body).toMatchObject({ status: 'partial' });
      await receive({ poId: po.id, lines: [{ productId: p.id, qty: '60', unitCost: '10', poLineId: lineId }] }).then((r) => expect(r.status).toBe(201));
      const done = (await t.http().get(`/v1/purchase-orders/${po.id}`).set(auth(c.manager))).body;
      expect(done.status).toBe('received');
      expect(done.lines[0].received_base).toBe('100.0000');
      expect(await balance(t, branch, p.id)).toBe('100');
    });

    it('cashiers cannot receive stock; invalid lines are rejected', async () => {
      const p = await addProduct(t, c.owner, { name: 'Perm Item' });
      expect((await receive({ lines: [{ productId: p.id, qty: '1', unitCost: '1' }] }, c.cashier)).status).toBe(403);
      expect((await receive({ lines: [{ productId: p.id, qty: '-1', unitCost: '1' }] })).status).toBe(400);
      expect((await receive({ lines: [{ productId: p.id, qty: '1', unitCost: '-1' }] })).status).toBe(400);
      expect((await receive({ lines: [] })).status).toBe(400);
    });

    it('batch-tracked items need batch info; expiry is calculated from the shelf life when missing', async () => {
      const p = await addProduct(t, c.owner, { name: 'Paint Tin Batch', baseUnit: 'L', trackBatches: true, shelfLifeDays: 365 });
      expect((await receive({ lines: [{ productId: p.id, qty: '10', unitCost: '900' }] })).status).toBe(400);
      const ok = await receive({ lines: [{ productId: p.id, qty: '10', unitCost: '900', batchNo: 'B-77', mfgDate: '2026-01-10' }] });
      expect(ok.status).toBe(201);
      const b = (await t.db.admin((tx) => tx.query(`SELECT batch_no, expiry_date::text e, qty_remaining FROM stock_batch WHERE product_id=$1`, [p.id]))).rows[0];
      expect(b).toMatchObject({ batch_no: 'B-77', e: '2027-01-10' });
      expect(D(b.qty_remaining).toString()).toBe('10');
    });

    it('receiving restocks a low item and re-arms its alert', async () => {
      const p = await addProduct(t, c.owner, { name: 'Restock Item', minLevel: '5' });
      await receive({ lines: [{ productId: p.id, qty: '3', unitCost: '1' }] }); // 3 <= 5: low
      expect((await t.db.admin((tx) => tx.query(`SELECT state FROM low_stock_alert_state WHERE product_id=$1`, [p.id]))).rows[0].state).toBe('low');
      await receive({ lines: [{ productId: p.id, qty: '20', unitCost: '1' }] });
      expect((await t.db.admin((tx) => tx.query(`SELECT state FROM low_stock_alert_state WHERE product_id=$1`, [p.id]))).rows[0].state).toBe('ok');
    });
  });

  describe('purchase returns and supplier payments', () => {
    it('returns reduce stock and what we owe, at the cost incl. landed; capped at what was bought; refused if already sold', async () => {
      const s2 = await supplier('Return Supplies');
      const p = await addProduct(t, c.owner, { name: 'Return Goods' });
      const rcv = await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId: s2, lines: [{ productId: p.id, qty: '10', unitCost: '100' }], landedCosts: [{ label: 't', amount: '50' }] });
      expect(await owed(s2)).toBe('1050');
      const line = (await t.http().get(`/v1/purchases/${rcv.body.purchaseId}`).set(auth(c.manager))).body.lines[0].id;
      const ret = await t.http().post('/v1/purchase-returns').set(auth(c.manager)).send({ purchaseId: rcv.body.purchaseId, reason: 'damaged in transit', lines: [{ purchaseLineId: line, qty: '4' }] });
      expect(ret.status).toBe(201);
      expect(ret.body.total).toBe('420'); // 4/10 of 1050
      expect(await owed(s2)).toBe('630');
      expect(await balance(t, branch, p.id)).toBe('6');
      const over = await t.http().post('/v1/purchase-returns').set(auth(c.manager)).send({ purchaseId: rcv.body.purchaseId, reason: 'x', lines: [{ purchaseLineId: line, qty: '7' }] });
      expect(over.status).toBe(400);
      expect(over.body.details.remaining).toBe('6');
      const last = await t.http().post('/v1/purchase-returns').set(auth(c.manager)).send({ purchaseId: rcv.body.purchaseId, reason: 'rest', lines: [{ purchaseLineId: line, qty: '6' }] });
      expect(last.body.total).toBe('630'); // remainder exactly: supplier owes 0
      expect(await owed(s2)).toBe('0');

      const q = await addProduct(t, c.owner, { name: 'Sold Then Return' });
      const r2 = await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId: s2, lines: [{ productId: q.id, qty: '2', unitCost: '10' }] });
      await t.http().put(`/v1/products/${q.id}/prices`).set(auth(c.owner)).send({ price: '20' });
      const tl = await till(t, c, 'RET-T1');
      await sell(t, tl.token, { lines: [{ productId: q.id, qty: '2' }], payments: [{ method: 'cash', amount: '40' }] });
      const l2 = (await t.http().get(`/v1/purchases/${r2.body.purchaseId}`).set(auth(c.manager))).body.lines[0].id;
      const blocked = await t.http().post('/v1/purchase-returns').set(auth(c.manager)).send({ purchaseId: r2.body.purchaseId, reason: 'x', lines: [{ purchaseLineId: l2, qty: '1' }] });
      expect(blocked.body.code).toBe('STOCK_SHORT');
      expect(await owed(s2)).toBe('20'); // unchanged by the failed return
    });

    it('partial payments reduce the payable; overpayment is refused; statement has a running balance', async () => {
      const s3 = await supplier('Pay Supplies');
      const p = await addProduct(t, c.owner, { name: 'Pay Goods' });
      await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId: s3, lines: [{ productId: p.id, qty: '10', unitCost: '100' }] });
      const pay = (amount: string, extra: any = {}) => t.http().post(`/v1/suppliers/${s3}/payments`).set(auth(c.manager)).send({ amount, method: 'bank_transfer', reference: 'T1', ...extra });
      expect((await pay('400')).body.balance).toBe('600');
      expect((await pay('700')).status).toBe(400);
      expect((await pay('600')).body.balance).toBe('0');
      const st = (await t.http().get(`/v1/suppliers/${s3}/statement`).set(auth(c.manager))).body;
      expect(st.entries.map((e: any) => [e.entry_type, D(e.balance).toString()])).toEqual([['purchase', '1000'], ['payment', '600'], ['payment', '0']]);
    });

    it('a bounced cheque we issued makes us owe the supplier again', async () => {
      const s4 = await supplier('Cheque Supplies');
      const p = await addProduct(t, c.owner, { name: 'Cheque Goods' });
      await t.http().post('/v1/purchases').set(auth(c.manager)).send({ supplierId: s4, lines: [{ productId: p.id, qty: '5', unitCost: '100' }] });
      const pay = await t.http().post(`/v1/suppliers/${s4}/payments`).set(auth(c.manager)).send({ amount: '500', method: 'cheque', cheque: { bank: 'BOC', chequeNo: '000123', chequeDate: '2026-12-31' } });
      expect(pay.body.balance).toBe('0');
      await t.http().post(`/v1/cheques/${pay.body.chequeId}/bounce`).set(auth(c.manager)).send({}).expect(200);
      expect(await owed(s4)).toBe('500');
    });
  });
});
