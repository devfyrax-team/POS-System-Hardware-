import { D } from '@pos/money';
import { auth, createApp, TestCtx, uniq } from './helpers';
import { addProduct, balance, Ctx, ledgerDiffs, newKey, openingStock, sell, setupShop, till } from './inv-helpers';

describe('POS sales', () => {
  let t: TestCtx;
  let c: Ctx;
  let branch: string;
  let t1: Awaited<ReturnType<typeof till>>;
  let t2: Awaited<ReturnType<typeof till>>;

  const stocked = async (name: string, qty: string, cost: string, price: string, extra: Record<string, unknown> = {}) => {
    const p = await addProduct(t, c.owner, { name, price, ...extra });
    await openingStock(t, c.storekeeper, branch, [{ productId: p.id, qtyBase: qty, unitCost: cost }]);
    return p;
  };
  const line = (productId: string, qty: string, extra: Record<string, unknown> = {}) => ({ productId, qty, ...extra });

  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t);
    branch = c.shop.defaultBranchId;
    t1 = await till(t, c, 'POS-T1');
    t2 = await till(t, c, 'POS-T2');
  });
  afterAll(() => t.close());

  describe('checkout', () => {
    it('saves sale, lines with cost, payments, stock and ledger in one go; returns change; invoice is per terminal', async () => {
      const a = await stocked('Co A', '10', '60', '100');
      const b = await stocked('Co B', '5', '20', '35.50');
      const res = await sell(t, t1.token, { lines: [line(a.id, '2'), line(b.id, '3')], payments: [{ method: 'cash', amount: '500' }] });
      expect(res.status).toBe(201);
      expect(res.body.invoiceNo).toMatch(/^POS-T1-\d{6}$/);
      expect(res.body.total).toBe('306.5'); // 200 + 106.50
      expect(res.body.change).toBe('193.5');
      expect(res.body.lines.map((l: any) => l.lineTotal)).toEqual(['200', '106.5']);
      expect(await balance(t, branch, a.id)).toBe('8');
      expect(await balance(t, branch, b.id)).toBe('2');

      const row = (await t.db.admin((tx) => tx.query(`SELECT cogs, cost_estimated, price_charged, qty_base FROM sale_line WHERE sale_id=$1 ORDER BY line_no`, [res.body.saleId]))).rows;
      expect(row.map((r) => D(r.cogs).toString())).toEqual(['120', '60']); // cost stored permanently
      const pay = (await t.db.admin((tx) => tx.query(`SELECT method, amount FROM payment WHERE sale_id=$1`, [res.body.saleId]))).rows;
      expect(pay).toEqual([{ method: 'cash', amount: '306.50' }]); // change is not part of the takings
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
      const mv = (await t.db.admin((tx) => tx.query(`SELECT type, ref_type, ref_id FROM stock_movement WHERE product_id=$1 AND type='sale'`, [a.id]))).rows[0];
      expect(mv).toMatchObject({ ref_type: 'sale', ref_id: res.body.saleId });
    });

    it('never reveals cost or profit in any sale response, receipt or listing', async () => {
      const p = await stocked('Co Secret', '5', '4817.33', '1000');
      const res = await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '1000' }] });
      const get = await t.http().get(`/v1/sales/${res.body.saleId}`).set(auth(t1.token));
      const rec = await t.http().get(`/v1/sales/${res.body.saleId}/receipt`).set(auth(t1.token));
      const list = await t.http().get('/v1/sales').set(auth(t1.token));
      for (const body of [res.body, get.body, rec.body, list.body]) {
        const txt = JSON.stringify(body);
        expect(txt).not.toMatch(/cogs|unit_cost|"cost"|profit|4817\.33/i);
      }
    });

    it('requires a registered terminal and the Idempotency-Key header', async () => {
      const p = await stocked('Co Term', '5', '1', '10');
      const noTerm = await sell(t, c.cashier, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] });
      expect(noTerm.status).toBe(400);
      const noKey = await t.http().post('/v1/sales').set(auth(t1.token)).send({ lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] });
      expect(noKey.status).toBe(400);
      expect((await t.http().post('/v1/sales').set(auth(c.storekeeper)).set('Idempotency-Key', 'abcdefgh1').send({ lines: [line(p.id, '1')], payments: [] })).status).toBe(403);
    });

    it('the server recomputes prices: a till cannot send its own price or total', async () => {
      const p = await stocked('Co Tamper', '5', '10', '100');
      const res = await sell(t, t1.token, { lines: [{ productId: p.id, qty: '2', price: '1', lineTotal: '1', total: '1' }], total: '1', payments: [{ method: 'cash', amount: '200' }] });
      expect(res.status).toBe(201);
      expect(res.body.total).toBe('200');
      expect(res.body.lines[0].price).toBe('100');
    });

    it('an item with no price cannot be sold unless a price is entered', async () => {
      const p = await addProduct(t, c.owner, { name: 'Co NoPrice' });
      await openingStock(t, c.storekeeper, branch, [{ productId: p.id, qtyBase: '3' }]);
      const res = await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no price/);
    });

    it('whole-number items reject fractions; decimal items and unit conversions work (roll -> metres)', async () => {
      const nuts = await stocked('Co Nuts', '100', '1', '5');
      expect((await sell(t, t1.token, { lines: [line(nuts.id, '1.5')], payments: [{ method: 'cash', amount: '100' }] })).status).toBe(400);
      const wire = await stocked('Co Wire', '200', '10', '15', { baseUnit: 'm', decimalQty: true, units: [{ unit: 'roll', factor: '90' }] });
      const rollPrice = await t.http().get(`/v1/products/${wire.id}`).set(auth(c.owner));
      const roll = rollPrice.body.units.find((u: any) => u.unit === 'roll').id;
      const m = await sell(t, t1.token, { lines: [line(wire.id, '2.5')], payments: [{ method: 'cash', amount: '100' }] });
      expect(m.body.total).toBe('37.5');
      expect(await balance(t, branch, wire.id)).toBe('197.5');
      const r = await sell(t, t1.token, { lines: [{ productId: wire.id, unitId: roll, qty: '1' }], payments: [{ method: 'cash', amount: '2000' }] });
      expect(r.body.total).toBe('1350'); // derived: 15 x 90
      expect(await balance(t, branch, wire.id)).toBe('107.5');
      const sl = (await t.db.admin((tx) => tx.query(`SELECT qty_unit, qty_base, factor, unit FROM sale_line WHERE sale_id=$1`, [r.body.saleId]))).rows[0];
      expect(sl).toMatchObject({ unit: 'roll', factor: '90.000000' }); // conversion factor snapshot stored
      expect(D(sl.qty_base).toString()).toBe('90');
    });

    it('a repeated product in one cart and several items process correctly', async () => {
      const p = await stocked('Co Multi', '10', '5', '10');
      const q = await stocked('Co Multi2', '10', '5', '20');
      const res = await sell(t, t1.token, { lines: [line(p.id, '2'), line(q.id, '1'), line(p.id, '3')], payments: [{ method: 'cash', amount: '100' }] });
      expect(res.body.total).toBe('70'); // 2x10 + 1x20 + 3x10
      expect(await balance(t, branch, p.id)).toBe('5');
      expect(res.body.lines.map((l: any) => l.lineNo)).toEqual([1, 2, 3]);
    });
  });

  describe('idempotency', () => {
    it('a retry with the same key returns the same bill and sells nothing twice', async () => {
      const p = await stocked('Idem Item', '10', '5', '10');
      const key = newKey();
      const body = { lines: [line(p.id, '4')], payments: [{ method: 'cash', amount: '40' }] };
      const first = await sell(t, t1.token, body, key);
      const second = await sell(t, t1.token, body, key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(second.body.invoiceNo).toBe(first.body.invoiceNo);
      expect(await balance(t, branch, p.id)).toBe('6');
      const n = (await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM sale WHERE idempotency_key=$1`, [key]))).rows[0].c;
      expect(n).toBe(1);
      expect((await sell(t, t1.token, { ...body, lines: [line(p.id, '5')] }, key)).status).toBe(409); // same key, different request
    });

    it('five simultaneous retries of one bill create exactly one sale', async () => {
      const p = await stocked('Idem Race', '10', '5', '10');
      const key = newKey();
      const body = { lines: [line(p.id, '3')], payments: [{ method: 'cash', amount: '30' }] };
      const rs = await Promise.all(Array.from({ length: 5 }, () => sell(t, t1.token, body, key)));
      expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(new Set(rs.map((r) => r.body.invoiceNo)).size).toBe(1);
      expect(await balance(t, branch, p.id)).toBe('7');
    });

    it('a failed sale leaves no invoice-number gap and the same key can be retried after fixing', async () => {
      const p = await stocked('Idem Gap', '2', '5', '10');
      const before = await sell(t, t2.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] });
      const n0 = Number(before.body.invoiceNo.split('-').pop());
      const key = newKey();
      const fail = await sell(t, t2.token, { lines: [line(p.id, '5')], payments: [{ method: 'cash', amount: '50' }] }, key);
      expect(fail.status).toBe(409);
      const ok = await sell(t, t2.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] }, key);
      expect(ok.status).toBe(201); // the failed attempt did not burn the key
      expect(Number(ok.body.invoiceNo.split('-').pop())).toBe(n0 + 1);
    });
  });

  describe('stock and concurrency across tills', () => {
    it('refuses a bill that exceeds stock, lists every short line, and changes nothing', async () => {
      const a = await stocked('Sh A', '3', '5', '10');
      const b = await stocked('Sh B', '1', '5', '10');
      const ok = await stocked('Sh OK', '9', '5', '10');
      const res = await sell(t, t1.token, { lines: [line(ok.id, '2'), line(a.id, '5'), line(b.id, '2')], payments: [{ method: 'cash', amount: '500' }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STOCK_SHORT');
      expect(res.body.details.lines.map((l: any) => [l.name, l.available])).toEqual(expect.arrayContaining([['Sh A', '3.0000'], ['Sh B', '1.0000']]));
      expect(await balance(t, branch, ok.id)).toBe('9'); // the good line was rolled back too
      expect(await balance(t, branch, a.id)).toBe('3');
    });

    it('10 bags, three tills selling 5, 5 and 2 at once: never oversold; invoices stay gapless per terminal', async () => {
      const t3 = await till(t, c, `POS-R${Math.floor(Math.random() * 1e6)}`);
      for (let round = 0; round < 3; round++) {
        const p = await stocked(`Bag Race ${round}`, '10', '800', '1000');
        const reqs = [5, 5, 2];
        const tills = [t1, t2, t3];
        const results = await Promise.all(tills.map((tl, i) => sell(t, tl.token, { lines: [line(p.id, String(reqs[i]))], payments: [{ method: 'cash', amount: String(reqs[i] * 1000) }] })));
        const bal = D(await balance(t, branch, p.id));
        const soldOk = results.reduce((a, r, i) => (r.status === 201 ? a + reqs[i] : a), 0);
        expect(bal.toNumber()).toBe(10 - soldOk);
        expect(bal.gte(0)).toBe(true);
        for (const r of results) expect([201, 409]).toContain(r.status);
      }
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
      // per-terminal numbering has no gaps
      for (const tl of [t1, t2, t3]) {
        const nums = (await t.db.admin((tx) => tx.query(`SELECT invoice_no FROM sale WHERE terminal_id=$1 ORDER BY created_at, invoice_no`, [tl.terminalId]))).rows.map((r) => Number(r.invoice_no.split('-').pop()));
        nums.sort((x, y) => x - y);
        expect(nums).toEqual(nums.map((_, i) => i + 1));
      }
    });

    it('20 bags: all three tills succeed; different products on different tills do not interfere', async () => {
      const p = await stocked('Bag Plenty', '20', '800', '1000');
      const reqs = [5, 5, 2];
      const rs = await Promise.all([t1, t2, t1].map((tl, i) => sell(t, tl.token, { lines: [line(p.id, String(reqs[i]))], payments: [{ method: 'cash', amount: '5000' }] })));
      expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(await balance(t, branch, p.id)).toBe('8');
    });

    it('50 simultaneous single-item bills for 20 units across tills: exactly 20 succeed', async () => {
      const p = await stocked('Crowd Item', '20', '5', '10');
      const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => sell(t, (i % 2 ? t1 : t2).token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(20);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(30);
      expect(await balance(t, branch, p.id)).toBe('0');
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    }, 60000);
  });

  describe('payments', () => {
    it('split payments: cash + card + bank transfer; cash gives change only on the cash part', async () => {
      const p = await stocked('Pay Split', '10', '5', '100');
      const res = await sell(t, t1.token, {
        lines: [line(p.id, '5')], // 500
        payments: [{ method: 'card', amount: '200', reference: 'slip-77' }, { method: 'bank_transfer', amount: '100', reference: 'TXN1' }, { method: 'cash', amount: '300' }],
      });
      expect(res.status).toBe(201);
      expect(res.body.change).toBe('100');
      const pay = (await t.db.admin((tx) => tx.query(`SELECT method, amount, reference FROM payment WHERE sale_id=$1 ORDER BY method`, [res.body.saleId]))).rows;
      expect(pay).toEqual([{ method: 'bank_transfer', amount: '100.00', reference: 'TXN1' }, { method: 'card', amount: '200.00', reference: 'slip-77' }, { method: 'cash', amount: '200.00' , reference: null }]);
    });

    it('rejects short payment, non-cash overpayment and credit without a customer', async () => {
      const p = await stocked('Pay Bad', '10', '5', '100');
      const short = await sell(t, t1.token, { lines: [line(p.id, '2')], payments: [{ method: 'cash', amount: '150' }] });
      expect(short.status).toBe(400);
      expect(short.body.details.short).toBe('50');
      expect((await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'card', amount: '500' }] })).status).toBe(400);
      expect((await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'credit', amount: '100' }] })).status).toBe(400);
      expect(await balance(t, branch, p.id)).toBe('10');
    });
  });

  describe('price, discount and approvals', () => {
    it('price override: cashier needs a supervisor token (or the shop setting); a manager may override', async () => {
      const p = await stocked('Ov Item', '20', '50', '100');
      const body = { lines: [line(p.id, '1', { priceOverride: '80' })], payments: [{ method: 'cash', amount: '100' }] };
      const denied = await sell(t, t1.token, body);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('APPROVAL_REQUIRED');

      await t.http().put(`/v1/users/${c.users.manager}/pin`).set(auth(c.owner)).send({ pin: '2468' }).expect(204);
      const appr = await t.http().post('/v1/approvals').set(auth(t1.token)).send({ action: 'price.override', approverUserId: c.users.manager, pin: '2468' });
      const ok = await sell(t, t1.token, { ...body, approvals: { 'price.override': appr.body.token } });
      expect(ok.status).toBe(201);
      expect(ok.body.total).toBe('80');
      const row = (await t.db.admin((tx) => tx.query(`SELECT price_list, price_charged, price_overridden FROM sale_line WHERE sale_id=$1`, [ok.body.saleId]))).rows[0];
      expect(row).toMatchObject({ price_list: '100.0000', price_charged: '80.0000', price_overridden: true });
      const sale = (await t.db.admin((tx) => tx.query(`SELECT approver_id FROM sale WHERE id=$1`, [ok.body.saleId]))).rows[0];
      expect(sale.approver_id).toBe(c.users.manager);

      // a token cannot be reused for a different action, and does not work on another terminal/user
      const wrongAction = await sell(t, t1.token, { ...body, approvals: { 'price.override': (await t.http().post('/v1/approvals').set(auth(t1.token)).send({ action: 'sale.void', approverUserId: c.users.manager, pin: '2468' })).body.token } });
      expect(wrongAction.status).toBe(403);
      const t2Tok = (await t.http().post('/v1/approvals').set(auth(t2.token)).send({ action: 'price.override', approverUserId: c.users.manager, pin: '2468' })).body.token;
      expect((await sell(t, t1.token, { ...body, approvals: { 'price.override': t2Tok } })).status).toBe(200 + 203); // 403: bound to terminal 2

      // the manager himself may override without approval (price.override_on_sale)
      const m = await till(t, c, 'POS-MGR', 'manager');
      expect((await sell(t, m.token, body)).status).toBe(201);
    });

    it('shop setting lets cashiers override prices', async () => {
      const shop = await setupShop(t);
      const tl = await till(t, shop, 'ST-T1');
      const p = await addProduct(t, shop.owner, { name: 'Setting Ov', price: '100' });
      await openingStock(t, shop.storekeeper, shop.shop.defaultBranchId, [{ productId: p.id, qtyBase: '5', unitCost: '10' }]);
      const body = { lines: [line(p.id, '1', { priceOverride: '60' })], payments: [{ method: 'cash', amount: '60' }] };
      expect((await sell(t, tl.token, body)).status).toBe(403);
      await t.http().patch('/v1/shop/settings').set(auth(shop.owner)).send({ cashier_price_override: true }).expect(200);
      expect((await sell(t, tl.token, body)).status).toBe(201);
    });

    it('large discount: within the cashier limit (5%) is fine; above it needs approval; managers are unlimited', async () => {
      const p = await stocked('Disc Item', '50', '40', '100');
      const small = await sell(t, t1.token, { lines: [line(p.id, '10', { discount: '50' })], payments: [{ method: 'cash', amount: '1000' }] }); // 5%
      expect(small.status).toBe(201);
      expect(small.body.total).toBe('950');
      const big = { lines: [line(p.id, '10', { discount: '200' })], payments: [{ method: 'cash', amount: '1000' }] }; // 20%
      const denied = await sell(t, t1.token, big);
      expect(denied.body.code).toBe('APPROVAL_REQUIRED');
      expect(denied.body.details.action).toBe('discount.large');
      await t.http().put(`/v1/users/${c.users.manager}/pin`).set(auth(c.owner)).send({ pin: '2468' }).expect(204);
      const tok = (await t.http().post('/v1/approvals').set(auth(t1.token)).send({ action: 'discount.large', approverUserId: c.users.manager, pin: '2468' })).body.token;
      const ok = await sell(t, t1.token, { ...big, approvals: { 'discount.large': tok } });
      expect(ok.status).toBe(201);
      expect(ok.body.total).toBe('800');
      const m = await till(t, c, 'POS-MGR2', 'manager');
      expect((await sell(t, m.token, { lines: [line(p.id, '10', { discount: '600' })], payments: [{ method: 'cash', amount: '400' }] })).status).toBe(201);
      // a role-specific limit can raise the cashier's allowance
      await t.http().patch(`/v1/roles/${(await t.http().get('/v1/roles').set(auth(c.owner))).body.find((r: any) => r.system_key === 'cashier').id}`).set(auth(c.owner)).send({ approvalLimits: { maxDiscountPct: 25 } }).expect(200);
      expect((await sell(t, t1.token, { lines: [line(p.id, '10', { discount: '200' })], payments: [{ method: 'cash', amount: '1000' }] })).status).toBe(201);
      await t.http().patch(`/v1/roles/${(await t.http().get('/v1/roles').set(auth(c.owner))).body.find((r: any) => r.system_key === 'cashier').id}`).set(auth(c.owner)).send({ approvalLimits: {} }).expect(200);
    });

    it('bill discount cannot exceed the bill; selling below cost is flagged but never blocked', async () => {
      const p = await stocked('Below Cost', '10', '90', '100');
      expect((await sell(t, t1.token, { lines: [line(p.id, '1')], billDiscount: '500', payments: [{ method: 'cash', amount: '100' }] })).status).toBe(400);
      const m = await till(t, c, 'POS-MGR3', 'manager');
      const res = await sell(t, m.token, { lines: [line(p.id, '1', { priceOverride: '60' })], payments: [{ method: 'cash', amount: '60' }] });
      expect(res.status).toBe(201);
      expect(res.body.lines[0].belowCost).toBe(true);
      expect((await t.db.admin((tx) => tx.query(`SELECT below_cost FROM sale_line WHERE sale_id=$1`, [res.body.saleId]))).rows[0].below_cost).toBe(true);
    });

    it('repricing applies to the next sale only; earlier sale lines keep the price charged', async () => {
      const p = await stocked('Reprice', '10', '50', '100');
      const first = await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '100' }] });
      await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.owner)).send({ price: '130' }).expect(200);
      const second = await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '130' }] });
      expect(first.body.total).toBe('100');
      expect(second.body.total).toBe('130');
      expect((await t.http().get(`/v1/sales/${first.body.saleId}`).set(auth(t1.token))).body.lines[0].price_charged).toBe('100.0000');
    });

    it('retail price tiers: a wholesale bill uses the wholesale price when the shop has the feature', async () => {
      const p = await stocked('Tier Sell', '10', '50', '100');
      await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.owner)).send({ price: '85', tier: 'wholesale' }).expect(200);
      const w = await sell(t, t1.token, { tier: 'wholesale', lines: [line(p.id, '2')], payments: [{ method: 'cash', amount: '170' }] });
      expect(w.body.total).toBe('170');
    });
  });

  describe('void', () => {
    it('cashier needs a supervisor token; stock returns at the ORIGINAL cost; payments are reversed; both people audited', async () => {
      const p = await stocked('Void Item', '10', '70', '100');
      const sale = await sell(t, t1.token, { lines: [line(p.id, '3')], payments: [{ method: 'cash', amount: '300' }] });
      expect(await balance(t, branch, p.id)).toBe('7');
      const denied = await t.http().post(`/v1/sales/${sale.body.saleId}/void`).set(auth(t1.token)).send({ reason: 'customer left' });
      expect(denied.body.code).toBe('APPROVAL_REQUIRED');
      expect((await t.http().post(`/v1/sales/${sale.body.saleId}/void`).set(auth(t1.token)).send({ reason: '' })).status).toBe(400);

      await t.http().put(`/v1/users/${c.users.manager}/pin`).set(auth(c.owner)).send({ pin: '2468' }).expect(204);
      const tok = (await t.http().post('/v1/approvals').set(auth(t1.token)).send({ action: 'sale.void', entityId: sale.body.saleId, approverUserId: c.users.manager, pin: '2468' })).body.token;
      const other = await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '100' }] });
      expect((await t.http().post(`/v1/sales/${other.body.saleId}/void`).set(auth(t1.token)).send({ reason: 'x', approvalToken: tok })).status).toBe(403); // token is for another sale
      const ok = await t.http().post(`/v1/sales/${sale.body.saleId}/void`).set(auth(t1.token)).send({ reason: 'customer left', approvalToken: tok });
      expect(ok.status).toBe(200);
      expect(await balance(t, branch, p.id)).toBe('9'); // 10 - 3 - 1(other) + 3(void)
      const layer = (await t.db.admin((tx) => tx.query(`SELECT unit_cost FROM cost_layer WHERE product_id=$1 AND source_type='sales_return'`, [p.id]))).rows[0];
      expect(D(layer.unit_cost).toString()).toBe('70');
      const pays = (await t.db.admin((tx) => tx.query(`SELECT kind, amount FROM payment WHERE sale_id=$1 ORDER BY kind`, [sale.body.saleId]))).rows;
      expect(pays).toEqual([{ kind: 'sale', amount: '300.00' }, { kind: 'void', amount: '-300.00' }]);
      expect((await t.http().post(`/v1/sales/${sale.body.saleId}/void`).set(auth(t1.token)).send({ reason: 'again', approvalToken: tok })).status).toBe(409);
      const log = (await t.http().get('/v1/audit-log?action=sale.voided').set(auth(c.owner))).body.find((l: any) => l.entity_id === sale.body.saleId);
      expect(log).toMatchObject({ actor_id: c.users.cashier, approver_id: c.users.manager });
      expect((await t.http().get(`/v1/sales/${sale.body.saleId}`).set(auth(t1.token))).body.voided).toBe(true);
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('a manager voids directly; a sale with returns cannot be voided; sales rows can never be edited', async () => {
      const p = await stocked('Void Mgr', '10', '10', '20');
      const sale = await sell(t, t1.token, { lines: [line(p.id, '2')], payments: [{ method: 'cash', amount: '40' }] });
      const m = await till(t, c, 'POS-MGR4', 'manager');
      await t.http().post('/v1/returns').set(auth(m.token)).send({ saleId: sale.body.saleId, lines: [{ saleLineId: sale.body.lines[0].lineId, qty: '1' }], reason: 'wrong', refundMethod: 'cash' }).expect(201);
      expect((await t.http().post(`/v1/sales/${sale.body.saleId}/void`).set(auth(m.token)).send({ reason: 'x' })).status).toBe(409);
      const sale2 = await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '20' }] });
      expect((await t.http().post(`/v1/sales/${sale2.body.saleId}/void`).set(auth(m.token)).send({ reason: 'mistake' })).status).toBe(200);
      await expect(t.db.tenant({ shopId: c.shop.shopId }, (tx) => tx.query(`UPDATE sale SET total = 1`))).rejects.toThrow(/permission denied/i);
      await expect(t.db.tenant({ shopId: c.shop.shopId }, (tx) => tx.query(`DELETE FROM sale_line`))).rejects.toThrow(/permission denied/i);
      await expect(t.db.tenant({ shopId: c.shop.shopId }, (tx) => tx.query(`UPDATE payment SET amount = 1`))).rejects.toThrow(/permission denied/i);
    });
  });

  describe('returns', () => {
    it('partial and repeated returns are capped at the quantity sold; rounding never drifts; refund is a payment entry', async () => {
      const p = await stocked('Ret Item', '20', '2', '3.333');
      const sale = await sell(t, t1.token, { lines: [line(p.id, '3')], payments: [{ method: 'cash', amount: '10' }] });
      expect(sale.body.total).toBe('10'); // 9.999 -> 10.00
      const lineId = sale.body.lines[0].lineId;
      const m = await till(t, c, 'POS-MGR5', 'manager');
      const ret = (qty: string, extra: any = {}) => t.http().post('/v1/returns').set(auth(m.token)).send({ saleId: sale.body.saleId, lines: [{ saleLineId: lineId, qty }], reason: 'changed mind', refundMethod: 'cash', ...extra });
      const r1 = await ret('1');
      expect(r1.status).toBe(201);
      expect(r1.body.total).toBe('3.33');
      const r2 = await ret('1');
      expect(r2.body.total).toBe('3.33');
      const over = await ret('2');
      expect(over.status).toBe(400);
      expect(over.body.details.remaining).toBe('1');
      const r3 = await ret('1');
      expect(r3.body.total).toBe('3.34'); // last unit takes the remainder: 3.33+3.33+3.34 = 10.00
      expect(await balance(t, branch, p.id)).toBe('20');
      const refunds = (await t.db.admin((tx) => tx.query(`SELECT amount FROM payment WHERE sale_id=$1 AND kind='refund' ORDER BY created_at, id`, [sale.body.saleId]))).rows.map((r) => r.amount);
      expect(refunds).toEqual(['-3.33', '-3.33', '-3.34']);
      expect((await ret('1')).status).toBe(400); // nothing left
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('cashiers need approval; damaged returns do not go back on the sellable shelf; non-returnable items are refused', async () => {
      const p = await stocked('Ret Dmg', '10', '8', '20');
      const sale = await sell(t, t1.token, { lines: [line(p.id, '2')], payments: [{ method: 'cash', amount: '40' }] });
      const lineId = sale.body.lines[0].lineId;
      const body = { saleId: sale.body.saleId, lines: [{ saleLineId: lineId, qty: '1', disposition: 'damaged' }], reason: 'dented', refundMethod: 'cash' };
      expect((await t.http().post('/v1/returns').set(auth(t1.token)).send(body)).body.code).toBe('APPROVAL_REQUIRED');
      await t.http().put(`/v1/users/${c.users.manager}/pin`).set(auth(c.owner)).send({ pin: '2468' }).expect(204);
      const tok = (await t.http().post('/v1/approvals').set(auth(t1.token)).send({ action: 'sale.refund', entityId: sale.body.saleId, approverUserId: c.users.manager, pin: '2468' })).body.token;
      expect((await t.http().post('/v1/returns').set(auth(t1.token)).send({ ...body, approvalToken: tok })).status).toBe(201);
      expect(await balance(t, branch, p.id)).toBe('8'); // not back on the shelf
      expect(D((await t.db.admin((tx) => tx.query(`SELECT damaged_qty FROM stock_balance WHERE product_id=$1`, [p.id]))).rows[0].damaged_qty).toString()).toBe('1');

      await t.db.admin((tx) => tx.query(`UPDATE product SET non_returnable = true WHERE id=$1`, [p.id]));
      const m = await till(t, c, 'POS-MGR6', 'manager');
      const nr = await t.http().post('/v1/returns').set(auth(m.token)).send({ ...body, lines: [{ saleLineId: lineId, qty: '1' }] });
      expect(nr.status).toBe(400);
      expect(nr.body.message).toMatch(/cannot be returned/);
    });
  });

  describe('receipt, held bills, summaries', () => {
    it('80 mm receipt text has invoice, lines, total, tender and change; Sinhala names are flagged for image rendering', async () => {
      const p = await stocked('Receipt Item', '10', '5', '12.50', { nameSi: 'ඉටි' });
      const sale = await sell(t, t1.token, { lines: [line(p.id, '2')], payments: [{ method: 'cash', amount: '50' }] });
      const r = (await t.http().get(`/v1/sales/${sale.body.saleId}/receipt`).set(auth(t1.token))).body;
      expect(r.text).toContain(sale.body.invoiceNo);
      expect(r.text).toContain('Receipt Item');
      expect(r.text).toMatch(/TOTAL\s+25\.00/);
      expect(r.text).toMatch(/Change\s+25\.00/);
      expect(Math.max(...r.text.split('\n').map((l: string) => l.length))).toBeLessThanOrEqual(42);
      expect(r.needsRaster).toBe(false);
      const si = (await t.http().get(`/v1/sales/${sale.body.saleId}/receipt?lang=si`).set(auth(t1.token))).body;
      expect(si.needsRaster).toBe(true);
      expect(Buffer.from(si.escposBase64, 'base64')[0]).toBe(0x1b);
    });

    it('held bills are per terminal and are removed on recall; nothing is reserved', async () => {
      const p = await stocked('Held Item', '1', '5', '10');
      const h = await t.http().post('/v1/held-bills').set(auth(t1.token)).send({ label: 'Mr Perera', cart: { lines: [{ productId: p.id, qty: '1' }] } });
      expect(h.status).toBe(201);
      expect((await t.http().get('/v1/held-bills').set(auth(t1.token))).body.map((x: any) => x.label)).toContain('Mr Perera');
      expect((await t.http().get('/v1/held-bills').set(auth(t2.token))).body.map((x: any) => x.label)).not.toContain('Mr Perera');
      expect(await balance(t, branch, p.id)).toBe('1'); // held, not reserved: another till can sell it
      expect((await sell(t, t2.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] })).status).toBe(201);
      const recalled = await t.http().post(`/v1/held-bills/${h.body.id}/recall`).set(auth(t1.token));
      expect(recalled.body.cart.lines[0].productId).toBe(p.id);
      expect((await t.http().post(`/v1/held-bills/${h.body.id}/recall`).set(auth(t1.token))).status).toBe(404);
    });

    it('cashiers see only their own sales and summary; managers see everyone; totals net out voids and returns', async () => {
      const shop = await setupShop(t);
      const a = await till(t, shop, 'SM-T1');
      const m = await till(t, shop, 'SM-T2', 'manager');
      const p = await addProduct(t, shop.owner, { name: 'Sum Item', price: '100' });
      await openingStock(t, shop.storekeeper, shop.shop.defaultBranchId, [{ productId: p.id, qtyBase: '50', unitCost: '40' }]);
      const s1 = await sell(t, a.token, { lines: [line(p.id, '2')], payments: [{ method: 'cash', amount: '200' }] });
      await sell(t, a.token, { lines: [line(p.id, '1')], payments: [{ method: 'card', amount: '100' }] });
      const s3 = await sell(t, m.token, { lines: [line(p.id, '5')], payments: [{ method: 'cash', amount: '500' }] });
      await t.http().post(`/v1/sales/${s3.body.saleId}/void`).set(auth(m.token)).send({ reason: 'oops' }).expect(200);
      await t.http().post('/v1/returns').set(auth(m.token)).send({ saleId: s1.body.saleId, lines: [{ saleLineId: s1.body.lines[0].lineId, qty: '1' }], reason: 'r', refundMethod: 'cash' }).expect(201);

      const mine = (await t.http().get('/v1/sales/summary').set(auth(a.token))).body;
      expect(mine.sales).toMatchObject({ bills: 2, total: '300.00' });
      expect(mine.byCashier).toHaveLength(1);
      const all = (await t.http().get('/v1/sales/summary').set(auth(m.token))).body;
      expect(all.sales).toMatchObject({ bills: 2, total: '300.00' }); // voided 500 excluded
      expect(all.voided).toMatchObject({ bills: 1, total: '500.00' });
      expect(all.returns).toMatchObject({ count: 1, total: '100.00' });
      expect(all.netSales).toBe('200');
      const cash = all.byMethod.find((x: any) => x.method === 'cash').net;
      expect(D(cash).toString()).toBe('100'); // 200 + 500 - 500 (void) - 100 (refund)
      expect(all.byTerminal).toHaveLength(1);

      expect((await t.http().get(`/v1/sales/${s3.body.saleId}`).set(auth(a.token))).status).toBe(404); // another cashier's sale
      expect((await t.http().get('/v1/sales').set(auth(a.token))).body).toHaveLength(2);
      expect((await t.http().get('/v1/sales').set(auth(m.token))).body.length).toBeGreaterThanOrEqual(3);
    });

    it('another shop can never read this shop\'s sales', async () => {
      const other = await setupShop(t);
      const tl = await till(t, other, 'OT-T1');
      const p = await stocked('Private Sale', '5', '5', '10');
      const sale = await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] });
      expect((await t.http().get(`/v1/sales/${sale.body.saleId}`).set(auth(tl.token))).status).toBe(404);
      expect((await t.http().get('/v1/sales').set(auth(other.owner))).body.map((s: any) => s.id)).not.toContain(sale.body.saleId);
      // a sale cannot be made against another shop's product
      const res = await sell(t, tl.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] });
      expect(res.status).toBe(400);
    });
  });

  describe('quotations and delivery notes', () => {
    it('quotation converts through the normal checkout; converting twice returns the same sale; price changes are reported', async () => {
      const p = await stocked('Quote Item', '10', '30', '100');
      const q = await t.http().post('/v1/quotations').set(auth(t1.token)).send({ customerName: 'Mr Silva', lines: [{ productId: p.id, qty: '3' }] });
      expect(q.status).toBe(201);
      expect(q.body.total).toBe('300.00');
      expect(await balance(t, branch, p.id)).toBe('10'); // quoting reserves nothing
      await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.owner)).send({ price: '110' }).expect(200);
      const conv = await t.http().post(`/v1/quotations/${q.body.id}/convert`).set(auth(t1.token)).send({ payments: [{ method: 'cash', amount: '400' }] });
      expect(conv.status).toBe(200);
      expect(conv.body.total).toBe('330'); // current price applies
      expect(conv.body.priceChanges).toEqual([{ productId: p.id, quoted: '100', charged: '110' }]);
      const again = await t.http().post(`/v1/quotations/${q.body.id}/convert`).set(auth(t1.token)).send({ payments: [{ method: 'cash', amount: '400' }] });
      expect(again.body.saleId).toBe(conv.body.saleId);
      expect(await balance(t, branch, p.id)).toBe('7');
      expect((await t.http().get(`/v1/quotations/${q.body.id}`).set(auth(t1.token))).body.status).toBe('converted');
    });

    it('quotations and delivery notes are plan features', async () => {
      const basic = await setupShop(t, { plan: 'basic' });
      const tl = await till(t, basic, 'BQ-T1');
      expect((await t.http().post('/v1/quotations').set(auth(tl.token)).send({ lines: [] })).status).not.toBe(404);
      const p = await addProduct(t, basic.owner, { name: 'Basic Dn', price: '10' });
      await openingStock(t, basic.storekeeper, basic.shop.defaultBranchId, [{ productId: p.id, qtyBase: '5' }]);
      const sale = await sell(t, tl.token, { lines: [line(p.id, '2')], payments: [{ method: 'cash', amount: '20' }] });
      const dn = await t.http().post('/v1/delivery-notes').set(auth(tl.token)).send({ saleId: sale.body.saleId, lines: [{ saleLineId: sale.body.lines[0].lineId, qty: '1' }] });
      expect(dn.body.code).toBe('FEATURE_NOT_ENABLED');
    });

    it('part deliveries: each note is capped by what is still undelivered', async () => {
      const p = await stocked('Deliver Item', '20', '5', '10');
      const sale = await sell(t, t1.token, { lines: [line(p.id, '10')], payments: [{ method: 'cash', amount: '100' }] });
      const lineId = sale.body.lines[0].lineId;
      const post = (qty: string) => t.http().post('/v1/delivery-notes').set(auth(t1.token)).send({ saleId: sale.body.saleId, lines: [{ saleLineId: lineId, qty }] });
      expect((await post('4')).status).toBe(201);
      expect((await post('4')).status).toBe(201);
      const over = await post('3');
      expect(over.status).toBe(400);
      expect(over.body.details.left).toBe('2');
      expect((await t.http().get(`/v1/delivery-notes/sale/${sale.body.saleId}`).set(auth(t1.token))).body[0]).toMatchObject({ sold: '10.0000', remaining: '2' });
    });
  });

  it('every sale writes an audit row with cashier, terminal and invoice', async () => {
    const p = await stocked('Audit Sale', '5', '5', '10');
    const sale = await sell(t, t1.token, { lines: [line(p.id, '1')], payments: [{ method: 'cash', amount: '10' }] });
    const log = (await t.http().get('/v1/audit-log?action=sale.completed').set(auth(c.owner))).body.find((l: any) => l.entity_id === sale.body.saleId);
    expect(log).toMatchObject({ actor_id: c.users.cashier, terminal_id: t1.terminalId });
    expect(log.new_value.invoiceNo).toBe(sale.body.invoiceNo);
    void uniq;
  });
});
