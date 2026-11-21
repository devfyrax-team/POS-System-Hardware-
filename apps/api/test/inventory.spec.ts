import { D } from '@pos/money';
import { LowStockService } from '../src/inventory/lowstock.service';
import { OutboxService } from '../src/jobs/outbox.service';
import { auth, createApp, TestCtx } from './helpers';
import { addProduct, balance, Ctx, ledgerDiffs, openingStock, setupShop, stockTx } from './inv-helpers';

describe('inventory: ledger, costing, concurrency', () => {
  let t: TestCtx;
  let c: Ctx;
  let branch: string;
  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t);
    branch = c.shop.defaultBranchId;
  });
  afterAll(() => t.close());

  const sale = (productId: string, qty: string, method?: 'fifo' | 'average') =>
    stockTx(t, c.shop.shopId, (svc, tx) => svc.apply(tx, { shopId: c.shop.shopId, branchId: branch, productId, type: 'sale', qtyBase: `-${qty}`, costMethod: method }));
  const receive = (productId: string, qty: string, unitCost?: string) =>
    stockTx(t, c.shop.shopId, (svc, tx) => svc.apply(tx, { shopId: c.shop.shopId, branchId: branch, productId, type: 'purchase', qtyBase: qty, unitCost }));

  it('opening stock writes ledger row + balance + cost layer; receipts without cost are flagged estimated', async () => {
    const p = await addProduct(t, c.owner, { name: 'Opening Item' });
    await openingStock(t, c.storekeeper, branch, [{ productId: p.id, qtyBase: '10', unitCost: '50' }]);
    expect(await balance(t, branch, p.id)).toBe('10');
    const layer = (await t.db.admin((tx) => tx.query(`SELECT qty_remaining, unit_cost, estimated FROM cost_layer WHERE product_id=$1`, [p.id]))).rows;
    expect(layer).toEqual([{ qty_remaining: '10.0000', unit_cost: '50.0000', estimated: false }]);
    const q = await addProduct(t, c.owner, { name: 'No Cost Item' });
    await openingStock(t, c.storekeeper, branch, [{ productId: q.id, qtyBase: '4' }]);
    expect((await t.db.admin((tx) => tx.query(`SELECT estimated FROM cost_layer WHERE product_id=$1`, [q.id]))).rows[0].estimated).toBe(true);
    expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
  });

  it('opening stock is for stock keepers/managers: a cashier is refused', async () => {
    const p = await addProduct(t, c.owner, { name: 'Cashier Cannot' });
    const r = await t.http().post('/v1/stock/opening').set(auth(c.cashier)).send({ branchId: branch, lines: [{ productId: p.id, qtyBase: '5' }] });
    expect(r.status).toBe(403);
  });

  describe('costing', () => {
    it('FIFO: each sale carries the real cost of the layers it used (price rise between deliveries)', async () => {
      const p = await addProduct(t, c.owner, { name: 'Fifo Item' });
      await receive(p.id, '10', '100');
      await receive(p.id, '10', '120');
      const r1 = await sale(p.id, '15', 'fifo');
      expect(r1.cogs).toBe('1600'); // 10*100 + 5*120
      expect(r1.parts).toHaveLength(2);
      const r2 = await sale(p.id, '5', 'fifo');
      expect(r2.cogs).toBe('600'); // the remaining 5 @120
      expect(await balance(t, branch, p.id)).toBe('0');
    });

    it('average: one cost per item = value of open layers / quantity', async () => {
      const p = await addProduct(t, c.owner, { name: 'Avg Item' });
      await receive(p.id, '10', '100');
      await receive(p.id, '10', '120');
      const r = await sale(p.id, '4', 'average');
      expect(r.unitCost).toBe('110');
      expect(r.cogs).toBe('440');
      // layers are still consumed oldest-first, so remaining value stays consistent
      const rem = (await t.db.admin((tx) => tx.query(`SELECT sum(qty_remaining*unit_cost) v, sum(qty_remaining) q FROM cost_layer WHERE product_id=$1`, [p.id]))).rows[0];
      expect(D(rem.v).toString()).toBe('1800'); // 6*100 + 10*120
      expect(D(rem.q).toString()).toBe('16');
    });

    it('the shop costing method setting is used by default; changing it does not rewrite past movements', async () => {
      const p = await addProduct(t, c.owner, { name: 'Setting Item' });
      await receive(p.id, '10', '100');
      await receive(p.id, '10', '200');
      const first = await sale(p.id, '10'); // default fifo
      expect(first.cogs).toBe('1000');
      await t.http().patch('/v1/shop/settings').set(auth(c.owner)).send({ costing_method: 'average' }).expect(200);
      const second = await sale(p.id, '2');
      expect(second.unitCost).toBe('200'); // only the 200 layer is left
      const past = (await t.db.admin((tx) => tx.query(`SELECT unit_cost FROM stock_movement WHERE id=$1`, [first.movementId]))).rows[0].unit_cost;
      expect(D(past).toString()).toBe('100');
      await t.http().patch('/v1/shop/settings').set(auth(c.owner)).send({ costing_method: 'fifo' }).expect(200);
    });

    it('stock added without cost uses the last known cost and is flagged; unknown cost is 0 and flagged', async () => {
      const p = await addProduct(t, c.owner, { name: 'Estimate Item', lastCost: '75' });
      const r = await receive(p.id, '5'); // no unit cost
      expect(r.estimated).toBe(true);
      expect(r.unitCost).toBe('75');
      const q = await addProduct(t, c.owner, { name: 'Unknown Cost Item' });
      const out = await receive(q.id, '3');
      expect(out).toMatchObject({ unitCost: '0', estimated: true });
    });

    it('decimal quantities cost correctly (metres)', async () => {
      const p = await addProduct(t, c.owner, { name: 'Wire Metres', baseUnit: 'm', decimalQty: true });
      await receive(p.id, '100', '45.5');
      const r = await sale(p.id, '2.5');
      expect(r.cogs).toBe('113.75');
      expect(await balance(t, branch, p.id)).toBe('97.5');
    });
  });

  describe('no negative stock', () => {
    it('a sale larger than the balance is refused with STOCK_SHORT and changes nothing', async () => {
      const p = await addProduct(t, c.owner, { name: 'Short Item' });
      await receive(p.id, '3', '10');
      await expect(sale(p.id, '4')).rejects.toMatchObject({ code: 'STOCK_SHORT', details: { available: '3.0000' } });
      expect(await balance(t, branch, p.id)).toBe('3');
      const mv = (await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM stock_movement WHERE product_id=$1`, [p.id]))).rows[0].c;
      expect(mv).toBe(1);
      await expect(sale(p.id, '3')).resolves.toBeTruthy();
      await expect(sale(p.id, '0.0001')).rejects.toMatchObject({ code: 'STOCK_SHORT' });
    });

    it('a product never stocked at this branch cannot be sold', async () => {
      const p = await addProduct(t, c.owner, { name: 'Never Stocked' });
      await expect(sale(p.id, '1')).rejects.toMatchObject({ code: 'STOCK_SHORT', details: { available: '0' } });
    });

    it('the database itself refuses a negative balance (CHECK constraint backstop)', async () => {
      const p = await addProduct(t, c.owner, { name: 'Check Item' });
      await receive(p.id, '2', '1');
      await expect(t.db.admin((tx) => tx.query(`UPDATE stock_balance SET quantity = -1 WHERE product_id=$1`, [p.id]))).rejects.toThrow(/check constraint/i);
    });
  });

  describe('concurrency: many cashiers at the same time', () => {
    it('10 bags, requests of 5, 5 and 2 at once: never oversold, balance never negative, ledger exact', async () => {
      for (let round = 0; round < 5; round++) {
        const p = await addProduct(t, c.owner, { name: `Cement Race ${round}` });
        await receive(p.id, '10', '1000');
        const results = await Promise.allSettled([sale(p.id, '5'), sale(p.id, '5'), sale(p.id, '2')]);
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        const bal = D(await balance(t, branch, p.id));
        expect(bal.gte(0)).toBe(true);
        const sold = D(10).minus(bal);
        expect(sold.lte(10)).toBe(true);
        expect(ok + failed.length).toBe(3);
        for (const f of failed) expect(f.reason.code).toBe('STOCK_SHORT');
        // whichever order won, sold quantity equals the sum of the successful requests
        const reqs = [5, 5, 2];
        const soldFromOk = results.reduce((a, r, i) => (r.status === 'fulfilled' ? a + reqs[i] : a), 0);
        expect(sold.toNumber()).toBe(soldFromOk);
      }
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('20 bags, same requests: all succeed with only milliseconds of waiting', async () => {
      const p = await addProduct(t, c.owner, { name: 'Cement Plenty' });
      await receive(p.id, '20', '1000');
      const t0 = Date.now();
      const results = await Promise.allSettled([sale(p.id, '5'), sale(p.id, '5'), sale(p.id, '2')]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await balance(t, branch, p.id)).toBe('8');
      expect(Date.now() - t0).toBeLessThan(3000);
    });

    it('30 tills fight over 10 units: exactly 10 single-unit sales win', async () => {
      const p = await addProduct(t, c.owner, { name: 'Last Units' });
      await receive(p.id, '10', '5');
      const results = await Promise.allSettled(Array.from({ length: 30 }, () => sale(p.id, '1')));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
      expect(await balance(t, branch, p.id)).toBe('0');
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('different products never block each other and multi-line bills in opposite order do not deadlock', async () => {
      const a = await addProduct(t, c.owner, { name: 'Dead A' });
      const b = await addProduct(t, c.owner, { name: 'Dead B' });
      await receive(a.id, '100', '1');
      await receive(b.id, '100', '1');
      // Each "bill" takes both items in a fixed (product id) order, like checkout does.
      const bill = (first: string, second: string) =>
        t.db.tenant({ shopId: c.shop.shopId }, async (tx) => {
          const svc = (await import('../src/inventory/stock.service')).StockService;
          const stock = t.app.get(svc);
          const [x, y] = [first, second].sort();
          await stock.apply(tx, { shopId: c.shop.shopId, branchId: branch, productId: x, type: 'sale', qtyBase: '-1' });
          await stock.apply(tx, { shopId: c.shop.shopId, branchId: branch, productId: y, type: 'sale', qtyBase: '-1' });
        });
      const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? bill(a.id, b.id) : bill(b.id, a.id))));
      expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await balance(t, branch, a.id)).toBe('80');
      expect(await balance(t, branch, b.id)).toBe('80');
    });

    it('a bill that fails on one line rolls back every line', async () => {
      const a = await addProduct(t, c.owner, { name: 'Rollback A' });
      const b = await addProduct(t, c.owner, { name: 'Rollback B' });
      await receive(a.id, '10', '1');
      await receive(b.id, '1', '1');
      await expect(
        t.db.tenant({ shopId: c.shop.shopId }, async (tx) => {
          const stock = t.app.get((await import('../src/inventory/stock.service')).StockService);
          await stock.apply(tx, { shopId: c.shop.shopId, branchId: branch, productId: a.id, type: 'sale', qtyBase: '-5' });
          await stock.apply(tx, { shopId: c.shop.shopId, branchId: branch, productId: b.id, type: 'sale', qtyBase: '-2' });
        }),
      ).rejects.toMatchObject({ code: 'STOCK_SHORT' });
      expect(await balance(t, branch, a.id)).toBe('10');
      expect(await balance(t, branch, b.id)).toBe('1');
    });
  });

  describe('low-stock alerts', () => {
    const dispatch = () => t.app.get(OutboxService).dispatch();
    const inbox = async (token: string) => (await t.http().get('/v1/notifications').set(auth(token))).body as any[];

    it('alerts once per crossing to storekeeper/manager/owner (not the cashier); re-arms after restock', async () => {
      const p = await addProduct(t, c.owner, { name: 'Alert Item', minLevel: '5' });
      await openingStock(t, c.storekeeper, branch, [{ productId: p.id, qtyBase: '20', unitCost: '10' }]);
      await sale(p.id, '10'); // 10 left: above 5
      await dispatch();
      expect((await inbox(c.storekeeper)).filter((n) => n.payload?.productId === p.id)).toHaveLength(0);

      await sale(p.id, '6'); // 4 left: crosses to low
      await sale(p.id, '1'); // 3 left: still low -> no second alert
      await dispatch();
      for (const tok of [c.storekeeper, c.manager, c.owner]) {
        const mine = (await inbox(tok)).filter((n) => n.payload?.productId === p.id);
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ type: 'stock.low', title: 'Low stock: Alert Item' });
      }
      expect((await inbox(c.cashier)).filter((n) => n.payload?.productId === p.id)).toHaveLength(0);

      await sale(p.id, '3'); // 0 left: crosses to out
      await dispatch();
      const out = (await inbox(c.storekeeper)).filter((n) => n.payload?.productId === p.id);
      expect(out.map((n) => n.type).sort()).toEqual(['stock.low', 'stock.out']);

      await receive(p.id, '20', '10'); // restock above the level re-arms
      await sale(p.id, '17'); // 3 left: low again
      await dispatch();
      expect((await inbox(c.storekeeper)).filter((n) => n.payload?.productId === p.id && n.type === 'stock.low')).toHaveLength(2);
    });

    it('branch override of the minimum level wins over the product default', async () => {
      const p = await addProduct(t, c.owner, { name: 'Override Item', minLevel: '2' });
      await t.http().put(`/v1/products/${p.id}/branch-min-level`).set(auth(c.manager)).send({ branchId: branch, minLevel: '50' }).expect(204);
      await receive(p.id, '60', '1');
      await sale(p.id, '15'); // 45 <= 50 -> low
      await dispatch();
      expect((await inbox(c.manager)).some((n) => n.payload?.productId === p.id && n.type === 'stock.low')).toBe(true);
    });

    it('low-stock report lists low and out items; daily check catches a missed crossing', async () => {
      const p = await addProduct(t, c.owner, { name: 'Report Item', minLevel: '5' });
      await receive(p.id, '3', '1');
      const list = (await t.http().get('/v1/stock/low').set(auth(c.storekeeper))).body;
      expect(list.find((r: any) => r.product_id === p.id)).toMatchObject({ state: 'low' });
      // simulate a missed event: reset the alert state, then let the safety-net job find it
      await t.db.admin((tx) => tx.query(`DELETE FROM low_stock_alert_state WHERE product_id=$1`, [p.id]));
      const changed = await t.db.tenant({ shopId: c.shop.shopId }, (tx) => t.app.get(LowStockService).dailyCheck(tx, c.shop.shopId));
      expect(changed).toBeGreaterThanOrEqual(1);
      expect((await t.http().get('/v1/stock/low').set(auth(c.cashier))).status).toBe(403);
    });
  });

  describe('adjustments (reason + authorized user)', () => {
    it('storekeeper requests, nothing moves until a manager approves; the ledger records it', async () => {
      const p = await addProduct(t, c.owner, { name: 'Adjust Item' });
      await receive(p.id, '20', '10');
      const req = await t.http().post('/v1/adjustments').set(auth(c.storekeeper)).send({ branchId: branch, reason: 'broken in store', lines: [{ productId: p.id, kind: 'damaged', qtyDelta: '-3' }] });
      expect(req.body.status).toBe('requested');
      expect(await balance(t, branch, p.id)).toBe('20');
      expect((await t.http().post(`/v1/adjustments/${req.body.id}/approve`).set(auth(c.storekeeper))).status).toBe(403);
      const notified = (await t.http().get('/v1/notifications').set(auth(c.manager))).body.some((n: any) => n.type === 'adjustment.requested');
      expect(notified).toBe(true);
      expect((await t.http().post(`/v1/adjustments/${req.body.id}/approve`).set(auth(c.manager))).body.status).toBe('posted');
      expect(await balance(t, branch, p.id)).toBe('17');
      const dmg = (await t.db.admin((tx) => tx.query(`SELECT damaged_qty FROM stock_balance WHERE product_id=$1`, [p.id]))).rows[0].damaged_qty;
      expect(D(dmg).toString()).toBe('3');
      expect((await t.http().post(`/v1/adjustments/${req.body.id}/approve`).set(auth(c.manager))).status).toBe(409); // cannot post twice
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('a manager posts directly; reason is mandatory; damaged must be negative; shortfall is refused', async () => {
      const p = await addProduct(t, c.owner, { name: 'Direct Adjust' });
      await receive(p.id, '5', '10');
      const direct = await t.http().post('/v1/adjustments').set(auth(c.manager)).send({ branchId: branch, reason: 'found extra', lines: [{ productId: p.id, qtyDelta: '2' }] });
      expect(direct.body.status).toBe('posted');
      expect(await balance(t, branch, p.id)).toBe('7');
      expect((await t.http().post('/v1/adjustments').set(auth(c.manager)).send({ branchId: branch, reason: ' ', lines: [{ productId: p.id, qtyDelta: '1' }] })).status).toBe(400);
      expect((await t.http().post('/v1/adjustments').set(auth(c.manager)).send({ branchId: branch, reason: 'x', lines: [{ productId: p.id, kind: 'damaged', qtyDelta: '1' }] })).status).toBe(400);
      expect((await t.http().post('/v1/adjustments').set(auth(c.manager)).send({ branchId: branch, reason: 'x', lines: [{ productId: p.id, qtyDelta: '-99' }] })).body.code).toBe('STOCK_SHORT');
      expect(await balance(t, branch, p.id)).toBe('7');
    });

    it('rejected requests change nothing and notify the requester; cashiers cannot request', async () => {
      const p = await addProduct(t, c.owner, { name: 'Rejected Adjust' });
      await receive(p.id, '5', '10');
      const req = await t.http().post('/v1/adjustments').set(auth(c.storekeeper)).send({ branchId: branch, reason: 'theft?', lines: [{ productId: p.id, qtyDelta: '-5' }] });
      await t.http().post(`/v1/adjustments/${req.body.id}/reject`).set(auth(c.manager)).send({ note: 'recount first' }).expect(204);
      expect(await balance(t, branch, p.id)).toBe('5');
      expect((await t.http().get('/v1/notifications').set(auth(c.storekeeper))).body.some((n: any) => n.type === 'adjustment.rejected')).toBe(true);
      expect((await t.http().post('/v1/adjustments').set(auth(c.cashier)).send({ branchId: branch, reason: 'x', lines: [{ productId: p.id, qtyDelta: '-1' }] })).status).toBe(403);
    });
  });

  describe('stocktake', () => {
    it('sales made during the count are netted so nothing is counted twice; variance posts as stocktake movements', async () => {
      const a = await addProduct(t, c.owner, { name: 'Count A', category: 'CountShelf' });
      const b = await addProduct(t, c.owner, { name: 'Count B', category: 'CountShelf' });
      const other = await addProduct(t, c.owner, { name: 'Count Other', category: 'OtherShelf' });
      await receive(a.id, '10', '5');
      await receive(b.id, '8', '5');
      await receive(other.id, '8', '5');
      const st = (await t.http().post('/v1/stocktakes').set(auth(c.storekeeper)).send({ branchId: branch, category: 'CountShelf' })).body;
      expect(st.lines).toBe(2); // only the shelf in scope

      await sale(a.id, '2'); // sold WHILE counting
      // shelf shows 8 physically (10 - 2 sold) -> matches expected, no variance
      await t.http().put(`/v1/stocktakes/${st.id}/counts`).set(auth(c.storekeeper)).send({ productId: a.id, qty: '8' }).expect(200);
      // B counted in two places and accumulated: 5 + 1 = 6, system says 8 -> variance -2
      await t.http().put(`/v1/stocktakes/${st.id}/counts`).set(auth(c.storekeeper)).send({ productId: b.id, qty: '5', mode: 'add' }).expect(200);
      await t.http().put(`/v1/stocktakes/${st.id}/counts`).set(auth(c.storekeeper)).send({ productId: b.id, qty: '1', mode: 'add' }).expect(200);

      const review = (await t.http().get(`/v1/stocktakes/${st.id}/review`).set(auth(c.storekeeper))).body;
      const ra = review.find((r: any) => r.productId === a.id);
      expect(ra).toMatchObject({ systemQtyAtOpen: '10.0000', movedSinceOpen: '-2.0000', expected: '8', counted: '8', variance: '0' });
      expect(review.find((r: any) => r.productId === b.id).variance).toBe('-2');
      expect((await t.http().put(`/v1/stocktakes/${st.id}/counts`).set(auth(c.storekeeper)).send({ productId: other.id, qty: '1' })).status).toBe(404);

      expect((await t.http().post(`/v1/stocktakes/${st.id}/post`).set(auth(c.storekeeper))).status).toBe(403); // posting needs stock.adjust
      expect((await t.http().post(`/v1/stocktakes/${st.id}/post`).set(auth(c.manager)).send({})).body.posted).toBe(1);
      expect(await balance(t, branch, a.id)).toBe('8');
      expect(await balance(t, branch, b.id)).toBe('6');
      expect(await balance(t, branch, other.id)).toBe('8');
      expect((await t.http().post(`/v1/stocktakes/${st.id}/post`).set(auth(c.manager)).send({})).status).toBe(409);
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('a count above the system quantity adds stock at the last known cost (estimated)', async () => {
      const p = await addProduct(t, c.owner, { name: 'Count Up', lastCost: '40' });
      await receive(p.id, '2', '40');
      const st = (await t.http().post('/v1/stocktakes').set(auth(c.storekeeper)).send({ branchId: branch, productIds: [p.id] })).body;
      await t.http().put(`/v1/stocktakes/${st.id}/counts`).set(auth(c.storekeeper)).send({ productId: p.id, qty: '5' });
      await t.http().post(`/v1/stocktakes/${st.id}/post`).set(auth(c.owner)).send({}).expect(200);
      expect(await balance(t, branch, p.id)).toBe('5');
    });
  });

  describe('reconciliation and visibility', () => {
    it('detects a balance that differs from its ledger and alerts the owner', async () => {
      const p = await addProduct(t, c.owner, { name: 'Tampered' });
      await receive(p.id, '10', '1');
      await t.db.admin((tx) => tx.query(`UPDATE stock_balance SET quantity = 12 WHERE product_id=$1`, [p.id]));
      const diffs = (await t.http().post('/v1/stock/reconcile').set(auth(c.manager))).body;
      expect(diffs.some((d: any) => d.product_id === p.id && D(d.balance).toString() === '12' && D(d.ledger_sum).toString() === '10')).toBe(true);
      expect((await t.http().get('/v1/notifications').set(auth(c.owner))).body.some((n: any) => n.type === 'stock.discrepancy')).toBe(true);
      await t.db.admin((tx) => tx.query(`UPDATE stock_balance SET quantity = 10 WHERE product_id=$1`, [p.id]));
    });

    it('cashiers see quantities but never cost, valuation or the ledger', async () => {
      const p = await addProduct(t, c.owner, { name: 'Secret Cost' });
      await receive(p.id, '5', '77');
      expect((await t.http().get('/v1/stock').query({ productId: p.id }).set(auth(c.cashier))).body[0].quantity).toBe('5.0000');
      expect((await t.http().get('/v1/stock/valuation').set(auth(c.cashier))).status).toBe(403);
      expect((await t.http().get(`/v1/products/${p.id}/cost`).set(auth(c.cashier))).status).toBe(403);
      expect((await t.http().get('/v1/stock/movements').set(auth(c.cashier))).status).toBe(403);
      expect((await t.http().get('/v1/stock/valuation').set(auth(c.storekeeper))).status).toBe(403); // storekeeper sees stock, not cost
      const val = (await t.http().get('/v1/stock/valuation').set(auth(c.manager))).body.find((r: any) => r.product_id === p.id);
      expect(D(val.value).toString()).toBe('385');
    });

    it('the ledger rows are immutable for the application role', async () => {
      await expect(t.db.tenant({ shopId: c.shop.shopId }, (tx) => tx.query(`UPDATE stock_movement SET qty_base = 1`))).rejects.toThrow(/permission denied/i);
      await expect(t.db.tenant({ shopId: c.shop.shopId }, (tx) => tx.query(`DELETE FROM stock_movement`))).rejects.toThrow(/permission denied/i);
      await expect(t.db.tenant({ shopId: c.shop.shopId }, (tx) => tx.query(`UPDATE price_history SET new_price = 1`))).rejects.toThrow(/permission denied/i);
    });

    it('stock and catalog data of one shop is invisible to another', async () => {
      const other = await setupShop(t);
      const mine = await addProduct(t, c.owner, { name: 'Only Mine Item' });
      expect((await t.http().get('/v1/products/search').query({ q: 'only mine' }).set(auth(other.owner))).body).toEqual([]);
      expect((await t.http().get(`/v1/products/${mine.id}`).set(auth(other.owner))).status).toBe(404);
      expect((await t.http().get('/v1/stock').query({ productId: mine.id }).set(auth(other.owner))).body).toEqual([]);
    });
  });
});
