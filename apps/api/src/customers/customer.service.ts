import { Injectable } from '@nestjs/common';
import { D, Decimal } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { escapeLike } from '../common/counter';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { FeatureService } from '../platform/feature.service';

export interface CustomerInput {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  type?: 'retail' | 'contractor' | 'wholesale';
  creditLimit?: string;
  dueDays?: number;
  notes?: string;
}

const COLS = `id, name, phone, email, address, type, credit_limit, balance, due_days, status, notes, version, created_at`;

@Injectable()
export class CustomerService {
  constructor(private readonly audit: AuditService, private readonly features: FeatureService) {}

  /** Credit limits are a plan feature and need credit.manage; checked by the caller for the permission. */
  async create(tx: Tx, s: TenantSession, i: CustomerInput) {
    if (i.creditLimit && D(i.creditLimit).gt(0)) await this.features.require(tx, s.shopId, 'credit_sales');
    const r = (
      await tx.query(
        `INSERT INTO customer(shop_id, name, phone, email, address, type, credit_limit, due_days, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLS}`,
        [s.shopId, i.name, i.phone ?? null, i.email ?? null, i.address ?? null, i.type ?? 'retail', i.creditLimit ?? '0', i.dueDays ?? 30, i.notes ?? null],
      )
    ).rows[0];
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'customer.created', entity: 'customer', entityId: r.id, new: { name: i.name, type: r.type } });
    return r;
  }

  async get(tx: Tx, shopId: string, id: string) {
    const r = (await tx.query(`SELECT ${COLS} FROM customer WHERE shop_id=$1 AND id=$2`, [shopId, id])).rows[0];
    if (!r) throw E.notFound('Customer');
    return r;
  }

  /** Cashiers find customers by name or phone at the till. */
  async search(tx: Tx, shopId: string, q: string, limit = 20) {
    const t = q.trim().toLowerCase();
    return (
      await tx.query(
        `SELECT id, name, phone, type, balance, credit_limit FROM customer
         WHERE shop_id=$1 AND status='active' AND ($2 = '' OR lower(name || ' ' || coalesce(phone,'')) LIKE '%' || $2 || '%' ESCAPE '\\') ORDER BY name LIMIT $3`,
        [shopId, escapeLike(t), Math.min(limit, 50)],
      )
    ).rows;
  }

  async update(tx: Tx, s: TenantSession, id: string, version: number, p: Partial<CustomerInput> & { status?: 'active' | 'inactive' }, canSetCredit: boolean) {
    if ((p.creditLimit !== undefined || p.dueDays !== undefined) && !canSetCredit) throw E.forbidden('Changing credit terms needs the credit.manage permission');
    if (p.creditLimit !== undefined && D(p.creditLimit).gt(0)) await this.features.require(tx, s.shopId, 'credit_sales');
    const old = await this.get(tx, s.shopId, id);
    const r = await tx.query(
      `UPDATE customer SET name=coalesce($4,name), phone=coalesce($5,phone), email=coalesce($6,email), address=coalesce($7,address), type=coalesce($8,type),
         credit_limit=coalesce($9,credit_limit), due_days=coalesce($10,due_days), notes=coalesce($11,notes), status=coalesce($12,status), version=version+1
       WHERE shop_id=$1 AND id=$2 AND version=$3 RETURNING ${COLS}`,
      [s.shopId, id, version, p.name ?? null, p.phone ?? null, p.email ?? null, p.address ?? null, p.type ?? null, p.creditLimit ?? null, p.dueDays ?? null, p.notes ?? null, p.status ?? null],
    );
    if (!r.rowCount) throw E.versionConflict();
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'customer.updated', entity: 'customer', entityId: id, old: { type: old.type, credit_limit: old.credit_limit }, new: p });
    return r.rows[0];
  }

  async list(tx: Tx, shopId: string, f: { withBalance?: boolean; limit?: number; offset?: number } = {}) {
    return (
      await tx.query(
        `SELECT ${COLS} FROM customer WHERE shop_id=$1 AND ($2::boolean IS NOT TRUE OR balance <> 0) ORDER BY name LIMIT $3 OFFSET $4`,
        [shopId, f.withBalance ?? false, Math.min(f.limit ?? 100, 500), f.offset ?? 0],
      )
    ).rows;
  }

  /** Printable statement: every entry with a running balance. */
  async statement(tx: Tx, shopId: string, customerId: string, f: { from?: string; to?: string } = {}) {
    const c = await this.get(tx, shopId, customerId);
    const rows = (
      await tx.query(
        `SELECT e.id, e.created_at, e.entry_type, e.amount, e.sale_id, s.invoice_no, e.note, e.due_date
         FROM credit_entry e LEFT JOIN sale s ON s.shop_id=e.shop_id AND s.id=e.sale_id WHERE e.shop_id=$1 AND e.customer_id=$2 ORDER BY e.id`,
        [shopId, customerId],
      )
    ).rows;
    let running = D(0);
    const all = rows.map((r) => {
      running = running.plus(r.amount);
      return { ...r, balance: running.toString() };
    });
    const inRange = all.filter((r) => (!f.from || new Date(r.created_at) >= new Date(f.from)) && (!f.to || new Date(r.created_at) < new Date(f.to)));
    const opening = inRange.length ? D(inRange[0].balance).minus(inRange[0].amount).toString() : c.balance;
    return { customer: { id: c.id, name: c.name, phone: c.phone }, openingBalance: opening, closingBalance: c.balance, entries: inRange };
  }

  /**
   * Ageing: payments are applied to the oldest charges first; what remains is bucketed by days past due.
   */
  async ageing(tx: Tx, shopId: string, customerId?: string) {
    const rows = (
      await tx.query(
        `SELECT e.customer_id, c.name, e.id, e.amount, e.due_date, e.entry_type, e.created_at FROM credit_entry e JOIN customer c ON c.shop_id=e.shop_id AND c.id=e.customer_id
         WHERE e.shop_id=$1 AND ($2::uuid IS NULL OR e.customer_id=$2) ORDER BY e.customer_id, e.id`,
        [shopId, customerId ?? null],
      )
    ).rows;
    const by = new Map<string, { name: string; charges: { due: Date; open: Decimal }[]; credit: Decimal }>();
    for (const r of rows) {
      const c: { name: string; charges: { due: Date; open: Decimal }[]; credit: Decimal } = by.get(r.customer_id) ?? { name: r.name, charges: [], credit: D(0) };
      by.set(r.customer_id, c);
      const amt = D(r.amount);
      if (amt.gt(0)) c.charges.push({ due: r.due_date ? new Date(r.due_date) : new Date(r.created_at), open: amt });
      else c.credit = c.credit.plus(amt.neg());
    }
    const today = new Date();
    return [...by.entries()]
      .map(([id, c]) => {
        let credit = c.credit;
        const b = { current: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d90_plus: D(0) };
        for (const ch of c.charges) {
          const use = Decimal.min(ch.open, credit);
          const open = ch.open.minus(use);
          credit = credit.minus(use);
          if (open.lte(0)) continue;
          const days = Math.floor((today.getTime() - ch.due.getTime()) / 86400000);
          if (days <= 0) b.current = b.current.plus(open);
          else if (days <= 30) b.d1_30 = b.d1_30.plus(open);
          else if (days <= 60) b.d31_60 = b.d31_60.plus(open);
          else if (days <= 90) b.d61_90 = b.d61_90.plus(open);
          else b.d90_plus = b.d90_plus.plus(open);
        }
        const total = Object.values(b).reduce((a, v) => a.plus(v), D(0));
        return { customerId: id, name: c.name, total: total.toString(), current: b.current.toString(), d1_30: b.d1_30.toString(), d31_60: b.d31_60.toString(), d61_90: b.d61_90.toString(), d90_plus: b.d90_plus.toString() };
      })
      .filter((x) => D(x.total).gt(0))
      .sort((a, b) => D(b.total).comparedTo(a.total));
  }

  /** Customers with anything past its due date (feeds reminders and the owner dashboard). */
  async overdue(tx: Tx, shopId: string) {
    const rows = await this.ageing(tx, shopId);
    return rows
      .map((r) => ({ ...r, overdue: D(r.d1_30).plus(r.d31_60).plus(r.d61_90).plus(r.d90_plus).toString() }))
      .filter((r) => D(r.overdue).gt(0));
  }
}
