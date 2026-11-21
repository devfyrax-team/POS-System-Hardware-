import { D } from '@pos/money';
import { CreditService } from '../src/customers/credit.service';
import { auth, createApp, TestCtx } from './helpers';
import { addProduct, balance, Ctx, ledgerDiffs, newKey, openingStock, sell, setupShop, till } from './inv-helpers';

describe('customers, credit and cheques', () => {
  let t: TestCtx;
  let c: Ctx;
  let branch: string;
  let t1: Awaited<ReturnType<typeof till>>;
  let t2: Awaited<ReturnType<typeof till>>;

  const customer = async (name: string, extra: any = {}) => (await t.http().post('/v1/customers').set(auth(c.owner)).send({ name, type: 'retail', creditLimit: '1000', ...extra })).body as { id: string; version: number };
  const stocked = async (name: string, qty = '100', cost = '50', price = '100') => {
    const p = await addProduct(t, c.owner, { name, price });
    await openingStock(t, c.storekeeper, branch, [{ productId: p.id, qtyBase: qty, unitCost: cost }]);
    return p;
  };
  const bal = async (id: string) => D((await t.http().get(`/v1/customers/${id}`).set(auth(c.manager))).body.balance).toString();
  const verify = async () => t.db.tenant({ shopId: c.shop.shopId }, (tx) => t.app.get(CreditService).verifyBalances(tx, c.shop.shopId));

  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t);
    branch = c.shop.defaultBranchId;
    t1 = await till(t, c, 'CR-T1');
    t2 = await till(t, c, 'CR-T2');
  });
  afterAll(() => t.close());

  describe('customers', () => {
    it('cashiers create customers but cannot set credit terms; search by name or phone; version-checked edits', async () => {
      const made = await t.http().post('/v1/customers').set(auth(t1.token)).send({ name: 'Walk Perera', phone: '0771234567', creditLimit: '99999' });
      expect(made.status).toBe(201);
      expect(D(made.body.credit_limit).toString()).toBe('0'); // ignored: needs credit.manage
      expect((await t.http().get('/v1/customers/search').query({ q: '0771234' }).set(auth(t1.token))).body[0].name).toBe('Walk Perera');
      expect((await t.http().get('/v1/customers/search').query({ q: 'perera' }).set(auth(t1.token))).body).toHaveLength(1);
      const upd = await t.http().patch(`/v1/customers/${made.body.id}`).set(auth(t1.token)).send({ version: made.body.version, creditLimit: '5000' });
      expect(upd.status).toBe(403);
      const ok = await t.http().patch(`/v1/customers/${made.body.id}`).set(auth(c.manager)).send({ version: made.body.version, creditLimit: '5000', type: 'contractor' });
      expect(ok.status).toBe(200);
      expect((await t.http().patch(`/v1/customers/${made.body.id}`).set(auth(c.manager)).send({ version: made.body.version, name: 'X' })).body.code).toBe('VERSION_CONFLICT');
    });

    it('credit terms are a plan feature', async () => {
      const basic = await setupShop(t, { plan: 'basic' });
      const res = await t.http().post('/v1/customers').set(auth(basic.owner)).send({ name: 'Basic Cust', creditLimit: '1000' });
      expect(res.body.code).toBe('FEATURE_NOT_ENABLED');
      expect((await t.http().post('/v1/customers').set(auth(basic.owner)).send({ name: 'Basic Cust' })).status).toBe(201);
    });
  });

  describe('credit sales', () => {
    it('credit within the limit creates a receivable (kept apart from takings); beyond it is refused with what is available', async () => {
      const p = await stocked('Cr Item');
      const cu = await customer('Credit Cust 1');
      const ok = await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '6' }], payments: [{ method: 'credit', amount: '600' }] });
      expect(ok.status).toBe(201);
      expect(await bal(cu.id)).toBe('600');
      expect((await t.db.admin((tx) => tx.query(`SELECT method, amount FROM payment WHERE sale_id=$1`, [ok.body.saleId]))).rows).toEqual([{ method: 'credit', amount: '600.00' }]);
      const over = await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '6' }], payments: [{ method: 'credit', amount: '600' }] });
      expect(over.status).toBe(409);
      expect(over.body.code).toBe('CREDIT_LIMIT');
      expect(over.body.details).toMatchObject({ limit: '1000', balance: '600', requested: '600', available: '400' });
      expect(await balance(t, branch, p.id)).toBe('94'); // the refused sale took no stock
      expect(await bal(cu.id)).toBe('600');
      // split: part cash part credit works within the remaining 400
      const split = await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '6' }], payments: [{ method: 'cash', amount: '200' }, { method: 'credit', amount: '400' }] });
      expect(split.status).toBe(201);
      expect(await bal(cu.id)).toBe('1000');
      expect(await verify()).toEqual([]);
    });

    it('the same credit customer at two tills at the same moment can never exceed the limit', async () => {
      for (let round = 0; round < 4; round++) {
        const p = await stocked(`Cr Race ${round}`);
        const cu = await customer(`Race Cust ${round}`);
        const body = (n: string) => ({ customerId: cu.id, lines: [{ productId: p.id, qty: '6' }], payments: [{ method: 'credit', amount: '600' }], note: n });
        const rs = await Promise.all([sell(t, t1.token, body('a')), sell(t, t2.token, body('b'))]);
        expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(rs.find((r) => r.status === 409)!.body.code).toBe('CREDIT_LIMIT');
        expect(await bal(cu.id)).toBe('600');
        expect(await balance(t, branch, p.id)).toBe('94');
      }
      expect(await verify()).toEqual([]);
      expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    });

    it('credit needs a customer and the credit_sales feature', async () => {
      const p = await stocked('Cr Rules');
      expect((await sell(t, t1.token, { lines: [{ productId: p.id, qty: '1' }], payments: [{ method: 'credit', amount: '100' }] })).status).toBe(400);
      const basic = await setupShop(t, { plan: 'basic' });
      const tl = await till(t, basic, 'CRB-T1');
      const bp = await addProduct(t, basic.owner, { name: 'Basic Credit', price: '100' });
      await openingStock(t, basic.storekeeper, basic.shop.defaultBranchId, [{ productId: bp.id, qtyBase: '5' }]);
      const bc = await t.http().post('/v1/customers').set(auth(basic.owner)).send({ name: 'BC' });
      const res = await sell(t, tl.token, { customerId: bc.body.id, lines: [{ productId: bp.id, qty: '1' }], payments: [{ method: 'credit', amount: '100' }] });
      expect(res.body.code).toBe('FEATURE_NOT_ENABLED');
    });

    it('wholesale and contractor customers get their price tier automatically', async () => {
      const p = await stocked('Tier Cust Item');
      await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.owner)).send({ price: '80', tier: 'wholesale' }).expect(200);
      const w = await customer('Wholesale Cust', { type: 'wholesale' });
      const res = await sell(t, t1.token, { customerId: w.id, lines: [{ productId: p.id, qty: '10' }], payments: [{ method: 'cash', amount: '800' }] });
      expect(res.body.total).toBe('800');
      const retailRes = await sell(t, t1.token, { lines: [{ productId: p.id, qty: '10' }], payments: [{ method: 'cash', amount: '1000' }] });
      expect(retailRes.body.total).toBe('1000');
    });

    it('voiding a credit sale and returning to account both reduce what the customer owes', async () => {
      const p = await stocked('Cr Void');
      const cu = await customer('Void Cust');
      const m = await till(t, c, 'CR-MGR', 'manager');
      const s1 = await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '5' }], payments: [{ method: 'credit', amount: '500' }] });
      expect(await bal(cu.id)).toBe('500');
      await t.http().post(`/v1/sales/${s1.body.saleId}/void`).set(auth(m.token)).send({ reason: 'wrong customer' }).expect(200);
      expect(await bal(cu.id)).toBe('0');
      const s2 = await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '4' }], payments: [{ method: 'credit', amount: '400' }] });
      await t.http().post('/v1/returns').set(auth(m.token)).send({ saleId: s2.body.saleId, lines: [{ saleLineId: s2.body.lines[0].lineId, qty: '1' }], reason: 'extra', refundMethod: 'account_credit' }).expect(201);
      expect(await bal(cu.id)).toBe('300');
      expect(await verify()).toEqual([]);
    });
  });

  describe('payments, statements, ageing', () => {
    it('partial payments reduce the balance; paying more than owed is refused; cashiers take payments', async () => {
      const p = await stocked('Pay Item');
      const cu = await customer('Pay Cust');
      await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '8' }], payments: [{ method: 'credit', amount: '800' }] });
      const pay = (amount: string, extra: any = {}) => t.http().post(`/v1/customers/${cu.id}/payments`).set(auth(t1.token)).send({ amount, method: 'cash', ...extra });
      expect((await pay('300')).body.balance).toBe('500');
      expect((await pay('600')).status).toBe(400);
      expect((await pay('500')).body.balance).toBe('0');
      const st = (await t.http().get(`/v1/customers/${cu.id}/statement`).set(auth(c.manager))).body;
      expect(st.entries.map((e: any) => [e.entry_type, D(e.balance).toString()])).toEqual([['sale', '800'], ['payment', '500'], ['payment', '0']]);
      expect(st.closingBalance).toBe('0.00');
      expect(await verify()).toEqual([]);
    });

    it('ageing buckets apply payments to the oldest charges first', async () => {
      const p = await stocked('Age Item');
      const cu = await customer('Age Cust', { creditLimit: '5000' });
      await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '10' }], payments: [{ method: 'credit', amount: '1000' }] }); // old
      await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '10' }], payments: [{ method: 'credit', amount: '1000' }] }); // recent
      await t.db.admin((tx) => tx.query(`UPDATE credit_entry SET due_date = current_date - 75 WHERE id = (SELECT min(id) FROM credit_entry WHERE customer_id=$1 AND entry_type='sale')`, [cu.id]));
      await t.db.admin((tx) => tx.query(`UPDATE credit_entry SET due_date = current_date + 10 WHERE id = (SELECT max(id) FROM credit_entry WHERE customer_id=$1 AND entry_type='sale')`, [cu.id]));
      await t.http().post(`/v1/customers/${cu.id}/payments`).set(auth(c.manager)).send({ amount: '400', method: 'cash' }).expect(201);
      const row = (await t.http().get('/v1/customers/ageing').set(auth(c.manager))).body.find((r: any) => r.customerId === cu.id);
      expect(row).toMatchObject({ total: '1600', current: '1000', d61_90: '600', d1_30: '0', d90_plus: '0' });
      expect((await t.http().get('/v1/customers/overdue').set(auth(c.manager))).body.some((r: any) => r.customerId === cu.id && r.overdue === '600')).toBe(true);
      expect((await t.http().get('/v1/customers/ageing').set(auth(t1.token))).status).toBe(403);
    });
  });

  describe('cheques', () => {
    it('a customer cheque payment: pending -> deposited -> cleared; invalid transitions are refused; post-dated cheques show when due', async () => {
      const p = await stocked('Chq Item');
      const cu = await customer('Chq Cust');
      await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '6' }], payments: [{ method: 'credit', amount: '600' }] });
      const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const pay = await t.http().post(`/v1/customers/${cu.id}/payments`).set(auth(c.manager)).send({ amount: '600', method: 'cheque', cheque: { bank: 'Sampath', chequeNo: '778899', chequeDate: soon } });
      expect(pay.status).toBe(201);
      expect(await bal(cu.id)).toBe('0');
      const id = pay.body.chequeId;
      expect((await t.http().get('/v1/cheques').query({ dueWithinDays: 7 }).set(auth(c.manager))).body.some((x: any) => x.id === id)).toBe(true);
      expect((await t.http().post(`/v1/cheques/${id}/clear`).set(auth(c.manager))).status).toBe(409); // must be deposited first
      await t.http().post(`/v1/cheques/${id}/deposit`).set(auth(c.manager)).expect(200);
      await t.http().post(`/v1/cheques/${id}/clear`).set(auth(c.manager)).expect(200);
      expect((await t.http().post(`/v1/cheques/${id}/bounce`).set(auth(c.manager)).send({})).status).toBe(409); // cleared cheques cannot bounce
      expect(await bal(cu.id)).toBe('0');
    });

    it('a bounced cheque reverses the payment, restores the balance and optionally charges the bank fee', async () => {
      const p = await stocked('Bounce Item');
      const cu = await customer('Bounce Cust');
      await sell(t, t1.token, { customerId: cu.id, lines: [{ productId: p.id, qty: '5' }], payments: [{ method: 'credit', amount: '500' }] });
      const pay = await t.http().post(`/v1/customers/${cu.id}/payments`).set(auth(c.manager)).send({ amount: '500', method: 'cheque', cheque: { bank: 'HNB', chequeNo: '111', chequeDate: '2026-12-01' } });
      expect(await bal(cu.id)).toBe('0');
      await t.http().post(`/v1/cheques/${pay.body.chequeId}/deposit`).set(auth(c.manager)).expect(200);
      await t.http().post(`/v1/cheques/${pay.body.chequeId}/bounce`).set(auth(c.manager)).send({ fee: '250' }).expect(200);
      expect(await bal(cu.id)).toBe('750'); // 500 owed again + 250 fee
      const types = (await t.http().get(`/v1/customers/${cu.id}/statement`).set(auth(c.manager))).body.entries.map((e: any) => e.entry_type);
      expect(types).toEqual(['sale', 'payment', 'cheque_bounce', 'fee']);
      expect(await verify()).toEqual([]);
    });

    it('a sale paid by cheque is tracked; if it bounces the customer owes the amount (even above their limit)', async () => {
      const p = await stocked('Sale Chq');
      const cu = await customer('Sale Chq Cust', { creditLimit: '100' });
      const sale = await sell(t, t1.token, {
        customerId: cu.id, lines: [{ productId: p.id, qty: '5' }], payments: [{ method: 'cheque', amount: '500', reference: 'CH-9', cheque: { bank: 'BOC', chequeNo: 'CH-9', chequeDate: '2026-12-15' } }],
      });
      expect(sale.status).toBe(201);
      expect(await bal(cu.id)).toBe('0');
      const ch = (await t.http().get('/v1/cheques').query({ status: 'pending' }).set(auth(c.manager))).body.find((x: any) => x.sale_id === sale.body.saleId);
      expect(ch).toMatchObject({ direction: 'received', cheque_no: 'CH-9' });
      await t.http().post(`/v1/cheques/${ch.id}/bounce`).set(auth(c.manager)).send({ fee: '100' }).expect(200);
      expect(await bal(cu.id)).toBe('600');
    });

    it('cheque tracking is a plan feature and needs credit/purchasing permissions', async () => {
      const basic = await setupShop(t, { plan: 'basic' });
      expect((await t.http().get('/v1/cheques').set(auth(basic.owner))).body.code).toBe('FEATURE_NOT_ENABLED');
      expect((await t.http().get('/v1/cheques').set(auth(t1.token))).status).toBe(403);
      expect((await t.http().post(`/v1/cheques/${'00000000-0000-0000-0000-000000000000'}/deposit`).set(auth(t1.token))).status).toBe(403);
    });
  });

  it('customers of one shop are invisible to another and credit entries are immutable', async () => {
    const other = await setupShop(t);
    const cu = await customer('Private Cust');
    expect((await t.http().get(`/v1/customers/${cu.id}`).set(auth(other.owner))).status).toBe(404);
    expect((await t.http().get('/v1/customers/search').query({ q: 'private' }).set(auth(other.owner))).body).toEqual([]);
    await expect(t.db.tenant({ shopId: c.shop.shopId }, (tx) => tx.query(`UPDATE credit_entry SET amount = 0`))).rejects.toThrow(/permission denied/i);
    await expect(t.db.tenant({ shopId: c.shop.shopId }, (tx) => tx.query(`DELETE FROM supplier_ledger`))).rejects.toThrow(/permission denied/i);
    void newKey;
  });
});
