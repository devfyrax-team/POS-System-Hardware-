import { Injectable } from '@nestjs/common';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { CheckoutHooks } from '../sales/checkout.hooks';
import { ChequeService, ChequeInput } from './cheque.service';

/**
 * Credit sales create receivables kept apart from cash takings. The customer ROW IS LOCKED while the limit is
 * checked, so two cashiers at two tills can never push one customer past the limit together.
 */
@Injectable()
export class CreditService {
  constructor(private readonly audit: AuditService, private readonly cheques: ChequeService, hooks: CheckoutHooks) {
    hooks.lockCustomer = (tx, s, id) => this.lockCustomer(tx, s, id);
    hooks.charge = (tx, s, c) => this.charge(tx, s, c);
    hooks.reverse = (tx, s, c) => this.reverse(tx, s, c);
    hooks.cheque = async (tx, s, c) => {
      if (!s.features?.has('cheques')) return; // plan without cheque tracking: still recorded as a plain payment
      await this.cheques.recordFromSale(tx, s, c);
    };
  }

  /** First step of any checkout that names a customer: lock the row (global lock order: customer -> stock). */
  async lockCustomer(tx: Tx, s: TenantSession, customerId: string) {
    const c = (await tx.query(`SELECT id, type, status FROM customer WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, customerId])).rows[0];
    if (!c) throw E.validation('Customer not found');
    if (c.status !== 'active') throw E.validation('Customer is inactive');
    return { tier: c.type as 'retail' | 'wholesale' | 'contractor' };
  }

  async charge(tx: Tx, s: TenantSession, c: { customerId: string; amount: string; saleId: string; invoiceNo: string }) {
    if (!s.features?.has('credit_sales')) throw E.featureNotEnabled('credit_sales');
    const cust = (await tx.query(`SELECT balance, credit_limit, due_days FROM customer WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, c.customerId])).rows[0];
    const after = D(cust.balance).plus(c.amount);
    if (after.gt(cust.credit_limit)) {
      throw E.creditLimit({
        limit: D(cust.credit_limit).toString(), balance: D(cust.balance).toString(), requested: c.amount,
        available: D(cust.credit_limit).minus(cust.balance).toString(),
      });
    }
    await tx.query(
      `INSERT INTO credit_entry(shop_id, customer_id, entry_type, amount, sale_id, due_date, note, created_by)
       VALUES ($1,$2,'sale',$3,$4, current_date + $5::int, $6, $7)`,
      [s.shopId, c.customerId, c.amount, c.saleId, cust.due_days, c.invoiceNo, s.userId],
    );
    await tx.query(`UPDATE customer SET balance = balance + $3 WHERE shop_id=$1 AND id=$2`, [s.shopId, c.customerId, c.amount]);
  }

  /** Voids and returns-to-account reduce what the customer owes. */
  async reverse(tx: Tx, s: TenantSession, c: { customerId: string; amount: string; saleId: string; reason: string }) {
    await tx.query(`SELECT 1 FROM customer WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, c.customerId]);
    await tx.query(
      `INSERT INTO credit_entry(shop_id, customer_id, entry_type, amount, sale_id, note, created_by) VALUES ($1,$2,'reversal',$3,$4,$5,$6)`,
      [s.shopId, c.customerId, D(c.amount).neg().toString(), c.saleId, c.reason, s.userId],
    );
    await tx.query(`UPDATE customer SET balance = balance - $3 WHERE shop_id=$1 AND id=$2`, [s.shopId, c.customerId, c.amount]);
  }

  /** A customer pays down their account (cash, card, transfer or cheque). Partial payments are normal. */
  async recordPayment(tx: Tx, s: TenantSession, i: { customerId: string; amount: string; method: 'cash' | 'card' | 'bank_transfer' | 'cheque'; reference?: string; cheque?: ChequeInput }) {
    if (!D(i.amount).gt(0)) throw E.validation('Amount must be positive');
    const cust = (await tx.query(`SELECT balance FROM customer WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, i.customerId])).rows[0];
    if (!cust) throw E.notFound('Customer');
    if (D(i.amount).gt(cust.balance)) throw E.validation('Payment is more than the outstanding balance', { balance: D(cust.balance).toString() });
    if (i.method === 'cheque') {
      if (!s.features?.has('cheques')) throw E.featureNotEnabled('cheques');
      if (!i.cheque) throw E.validation('Cheque details are required');
    }
    const pay = (
      await tx.query(`INSERT INTO customer_payment(shop_id, customer_id, amount, method, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
        s.shopId, i.customerId, i.amount, i.method, i.reference ?? null, s.userId,
      ])
    ).rows[0];
    await tx.query(`INSERT INTO credit_entry(shop_id, customer_id, entry_type, amount, payment_id, note, created_by) VALUES ($1,$2,'payment',$3,$4,$5,$6)`, [
      s.shopId, i.customerId, D(i.amount).neg().toString(), pay.id, i.reference ?? null, s.userId,
    ]);
    await tx.query(`UPDATE customer SET balance = balance - $3 WHERE shop_id=$1 AND id=$2`, [s.shopId, i.customerId, i.amount]);
    let chequeId: string | undefined;
    if (i.method === 'cheque') chequeId = (await this.cheques.recordReceived(tx, s, { customerId: i.customerId, amount: i.amount, paymentId: pay.id, cheque: i.cheque! })).id;
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'customer.payment', entity: 'customer', entityId: i.customerId, new: { amount: i.amount, method: i.method } });
    return { paymentId: pay.id as string, balance: D(cust.balance).minus(i.amount).toString(), chequeId };
  }

  /** The cached balance must equal the sum of credit entries. Returns offenders (used by tests and the nightly check). */
  async verifyBalances(tx: Tx, shopId: string) {
    return (
      await tx.query(
        `SELECT c.id, c.balance, coalesce(e.s,0) AS ledger FROM customer c
         LEFT JOIN (SELECT customer_id, sum(amount) s FROM credit_entry GROUP BY 1) e ON e.customer_id = c.id
         WHERE c.shop_id=$1 AND c.balance <> coalesce(e.s,0)`,
        [shopId],
      )
    ).rows;
  }
}
