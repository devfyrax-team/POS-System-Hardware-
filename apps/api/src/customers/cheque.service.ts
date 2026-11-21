import { Injectable } from '@nestjs/common';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';

export interface ChequeInput {
  bank?: string;
  chequeNo: string;
  chequeDate: string; // post-dated cheques carry a future date
}

type Status = 'pending' | 'deposited' | 'cleared' | 'bounced';
const NEXT: Record<Status, Status[]> = { pending: ['deposited', 'bounced'], deposited: ['cleared', 'bounced'], cleared: [], bounced: [] };

/** Cheques (including post-dated): pending -> deposited -> cleared, or bounced. Issued cheques follow the same states. */
@Injectable()
export class ChequeService {
  constructor(private readonly audit: AuditService) {}

  private parse(c: Partial<ChequeInput> | undefined): ChequeInput {
    if (!c?.chequeNo || !c.chequeDate || Number.isNaN(Date.parse(c.chequeDate))) throw E.validation('Cheque number and date are required');
    return { bank: c.bank, chequeNo: c.chequeNo, chequeDate: c.chequeDate };
  }

  async recordReceived(tx: Tx, s: TenantSession, i: { customerId: string; amount: string; paymentId?: string; saleId?: string; cheque: Partial<ChequeInput> }) {
    const c = this.parse(i.cheque);
    const r = (
      await tx.query(
        `INSERT INTO cheque(shop_id, direction, customer_id, bank, cheque_no, cheque_date, amount, sale_id, customer_payment_id, created_by)
         VALUES ($1,'received',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status`,
        [s.shopId, i.customerId, c.bank ?? null, c.chequeNo, c.chequeDate, i.amount, i.saleId ?? null, i.paymentId ?? null, s.userId],
      )
    ).rows[0];
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'cheque.received', entity: 'cheque', entityId: r.id, new: { chequeNo: c.chequeNo, amount: i.amount } });
    return r;
  }

  /** A cheque tendered at the till (checkout hook). Details come with the payment; reference is the fallback number. */
  async recordFromSale(tx: Tx, s: TenantSession, c: { saleId: string; amount: string; reference?: string; customerId?: string | null; details?: any }) {
    const d = c.details ?? {};
    const chequeNo = d.chequeNo ?? c.reference;
    if (!chequeNo) return; // cheque without number: plain payment record only
    const r = (
      await tx.query(
        `INSERT INTO cheque(shop_id, direction, customer_id, bank, cheque_no, cheque_date, amount, sale_id, created_by)
         VALUES ($1,'received',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [s.shopId, c.customerId ?? null, d.bank ?? null, chequeNo, d.chequeDate ?? new Date().toISOString().slice(0, 10), c.amount, c.saleId, s.userId],
      )
    ).rows[0];
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'cheque.received', entity: 'cheque', entityId: r.id, new: { chequeNo, saleId: c.saleId } });
  }

  async recordIssued(tx: Tx, s: TenantSession, i: { supplierId: string; amount: string; paymentId: string; cheque: Partial<ChequeInput> }) {
    const c = this.parse(i.cheque);
    return (
      await tx.query(
        `INSERT INTO cheque(shop_id, direction, supplier_id, bank, cheque_no, cheque_date, amount, supplier_payment_id, created_by)
         VALUES ($1,'issued',$2,$3,$4,$5,$6,$7,$8) RETURNING id, status`,
        [s.shopId, i.supplierId, c.bank ?? null, c.chequeNo, c.chequeDate, i.amount, i.paymentId, s.userId],
      )
    ).rows[0];
  }

  async list(tx: Tx, shopId: string, f: { status?: string; direction?: string; dueWithinDays?: number } = {}) {
    return (
      await tx.query(
        `SELECT ch.id, ch.direction, ch.status, ch.bank, ch.cheque_no, ch.cheque_date, ch.amount, ch.fee, c.name AS customer, sp.name AS supplier, ch.sale_id
         FROM cheque ch LEFT JOIN customer c ON c.shop_id=ch.shop_id AND c.id=ch.customer_id LEFT JOIN supplier sp ON sp.shop_id=ch.shop_id AND sp.id=ch.supplier_id
         WHERE ch.shop_id=$1 AND ($2::text IS NULL OR ch.status=$2) AND ($3::text IS NULL OR ch.direction=$3)
           AND ($4::int IS NULL OR (ch.status IN ('pending','deposited') AND ch.cheque_date <= current_date + $4::int))
         ORDER BY ch.cheque_date, ch.created_at LIMIT 200`,
        [shopId, f.status ?? null, f.direction ?? null, f.dueWithinDays ?? null],
      )
    ).rows;
  }

  /** Cheques due this week (owner dashboard). */
  async dueThisWeek(tx: Tx, shopId: string) {
    return this.list(tx, shopId, { dueWithinDays: 7 });
  }

  async transition(tx: Tx, s: TenantSession, id: string, to: Status, opts: { fee?: string } = {}) {
    const ch = (await tx.query(`SELECT * FROM cheque WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, id])).rows[0];
    if (!ch) throw E.notFound('Cheque');
    if (!NEXT[ch.status as Status].includes(to)) throw E.conflict(`A ${ch.status} cheque cannot become ${to}`);
    const fee = opts.fee ? D(opts.fee) : D(0);
    if (fee.isNegative()) throw E.validation('Fee cannot be negative');
    await tx.query(`UPDATE cheque SET status=$3, fee=$4, status_changed_at=now() WHERE shop_id=$1 AND id=$2`, [s.shopId, id, to, to === 'bounced' ? fee.toString() : ch.fee]);

    if (to === 'bounced') await this.reverse(tx, s, ch, fee.toString());
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: `cheque.${to}`, entity: 'cheque', entityId: id, old: { status: ch.status }, new: { status: to, fee: fee.toString() } });
    return { id, status: to };
  }

  /**
   * A bounced cheque reverses the payment: the customer owes the amount again (and any bank fee charged to them);
   * for an issued cheque we owe the supplier again.
   */
  private async reverse(tx: Tx, s: TenantSession, ch: any, fee: string) {
    if (ch.direction === 'received' && ch.customer_id) {
      await tx.query(`SELECT 1 FROM customer WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, ch.customer_id]);
      await tx.query(
        `INSERT INTO credit_entry(shop_id, customer_id, entry_type, amount, sale_id, payment_id, note, created_by) VALUES ($1,$2,'cheque_bounce',$3,$4,$5,$6,$7)`,
        [s.shopId, ch.customer_id, ch.amount, ch.sale_id, ch.customer_payment_id, `cheque ${ch.cheque_no} bounced`, s.userId],
      );
      let add = D(ch.amount);
      if (D(fee).gt(0)) {
        await tx.query(`INSERT INTO credit_entry(shop_id, customer_id, entry_type, amount, note, created_by) VALUES ($1,$2,'fee',$3,$4,$5)`, [s.shopId, ch.customer_id, fee, `bounce fee cheque ${ch.cheque_no}`, s.userId]);
        add = add.plus(fee);
      }
      await tx.query(`UPDATE customer SET balance = balance + $3 WHERE shop_id=$1 AND id=$2`, [s.shopId, ch.customer_id, add.toString()]);
    } else if (ch.direction === 'issued' && ch.supplier_id) {
      await tx.query(
        `INSERT INTO supplier_ledger(shop_id, supplier_id, entry_type, amount, ref_type, ref_id, note, created_by) VALUES ($1,$2,'cheque_bounce',$3,'cheque',$4,$5,$6)`,
        [s.shopId, ch.supplier_id, ch.amount, ch.id, `issued cheque ${ch.cheque_no} bounced`, s.userId],
      );
    }
  }
}
