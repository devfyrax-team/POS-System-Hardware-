import { Injectable } from '@nestjs/common';
import { D, lineTotal, sum } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { nextCounter } from '../common/counter';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { PricingService } from '../catalog/pricing.service';
import { UnitService } from '../catalog/unit.service';
import { CheckoutCmd, CheckoutService } from './checkout.service';
import { lockSale } from './void-return.service';

/** Held bills: per terminal, survive a till refresh, reserve nothing. */
@Injectable()
export class HeldBillService {
  async hold(tx: Tx, s: TenantSession, input: { label?: string; cart: unknown }) {
    if (!s.terminalId || !s.branchId) throw E.validation('Held bills belong to a registered terminal');
    const r = (
      await tx.query(`INSERT INTO held_bill(shop_id, branch_id, terminal_id, user_id, label, cart) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, label, created_at`, [
        s.shopId, s.branchId, s.terminalId, s.userId, input.label ?? null, JSON.stringify(input.cart),
      ])
    ).rows[0];
    return r;
  }

  async list(tx: Tx, s: TenantSession) {
    return (await tx.query(`SELECT id, label, user_id, cart, created_at FROM held_bill WHERE shop_id=$1 AND terminal_id=$2 ORDER BY created_at`, [s.shopId, s.terminalId ?? null])).rows;
  }

  /** Recall hands the cart back and removes the held copy. */
  async recall(tx: Tx, s: TenantSession, id: string) {
    const r = await tx.query(`DELETE FROM held_bill WHERE shop_id=$1 AND id=$2 AND terminal_id=$3 RETURNING id, label, cart`, [s.shopId, id, s.terminalId ?? null]);
    if (!r.rowCount) throw E.notFound('Held bill');
    return r.rows[0];
  }

  async discard(tx: Tx, s: TenantSession, id: string) {
    await this.recall(tx, s, id);
  }
}

export interface QuoteLineIn {
  productId: string;
  unitId?: string;
  unit?: string;
  qty: string;
  price?: string;
}

@Injectable()
export class QuotationService {
  constructor(
    private readonly pricing: PricingService,
    private readonly units: UnitService,
    private readonly checkout: CheckoutService,
    private readonly audit: AuditService,
  ) {}

  async create(tx: Tx, s: TenantSession, input: { customerId?: string; customerName?: string; validDays?: number; lines: QuoteLineIn[]; note?: string }) {
    if (!s.branchId) throw E.validation('Choose a branch first');
    const lines: any[] = [];
    for (const l of input.lines) {
      const p = (await tx.query(`SELECT name FROM product WHERE shop_id=$1 AND id=$2 AND status='active'`, [s.shopId, l.productId])).rows[0];
      if (!p) throw E.notFound('Product');
      const u = await this.units.toBase(tx, s.shopId, l.productId, { unitId: l.unitId, unit: l.unit }, l.qty);
      const listed = l.price ?? (await this.pricing.resolve(tx, s.shopId, l.productId, u.unitId, 'retail'))?.price;
      if (listed === undefined) throw E.validation(`"${p.name}" has no price`);
      lines.push({ productId: l.productId, name: p.name, unitId: u.unitId, unit: u.unit, qty: u.qtyUnit, price: D(listed).toString(), lineTotal: lineTotal(listed, u.qtyUnit).toString() });
    }
    const total = sum(lines.map((l) => l.lineTotal));
    const number = `Q-${String(await nextCounter(tx, s.shopId, 'quotation')).padStart(6, '0')}`;
    const q = (
      await tx.query(
        `INSERT INTO quotation(shop_id, branch_id, number, customer_id, customer_name, valid_until, lines, total, note, created_by)
         VALUES ($1,$2,$3,$4,$5, current_date + $6::int, $7,$8,$9,$10) RETURNING id, number, valid_until, total`,
        [s.shopId, s.branchId, number, input.customerId ?? null, input.customerName ?? null, input.validDays ?? 14, JSON.stringify(lines), total.toString(), input.note ?? null, s.userId],
      )
    ).rows[0];
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'quotation.created', entity: 'quotation', entityId: q.id, new: { number, total: total.toString() } });
    return { ...q, lines };
  }

  async get(tx: Tx, shopId: string, id: string) {
    const q = (await tx.query(`SELECT id, number, status, customer_id, customer_name, valid_until, lines, total, note, converted_sale_id, created_at FROM quotation WHERE shop_id=$1 AND id=$2`, [shopId, id])).rows[0];
    if (!q) throw E.notFound('Quotation');
    return q;
  }

  async list(tx: Tx, shopId: string, status?: string) {
    return (await tx.query(`SELECT id, number, status, customer_name, valid_until, total, created_at FROM quotation WHERE shop_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT 100`, [shopId, status ?? null])).rows;
  }

  /**
   * Converting re-runs the normal checkout, so current prices, stock and permissions apply.
   * The idempotency key derives from the quotation, so converting twice returns the same sale.
   */
  async convert(tx: Tx, s: TenantSession, id: string, input: Pick<CheckoutCmd, 'payments' | 'customerId' | 'approvals' | 'billDiscount'>) {
    const q = (await tx.query(`SELECT * FROM quotation WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, id])).rows[0];
    if (!q) throw E.notFound('Quotation');
    if (q.status === 'converted') return { ...(await this.checkoutFor(tx, s, q, input)), alreadyConverted: true };
    if (q.status !== 'open') throw E.conflict(`Quotation is ${q.status}`);
    if (q.valid_until && new Date(q.valid_until) < new Date(new Date().toDateString())) throw E.conflict('Quotation has expired');
    const sale: any = await this.checkoutFor(tx, s, q, input);
    await tx.query(`UPDATE quotation SET status='converted', converted_sale_id=$3 WHERE shop_id=$1 AND id=$2`, [s.shopId, id, sale.saleId]);
    const priceChanges: any[] = [];
    for (const ql of q.lines) {
      const sl = sale.lines.find((x: any) => x.productId === ql.productId);
      if (sl && !D(sl.price).equals(ql.price)) priceChanges.push({ productId: ql.productId, quoted: ql.price, charged: sl.price });
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'quotation.converted', entity: 'quotation', entityId: id, new: { saleId: sale.saleId } });
    return { ...sale, priceChanges };
  }

  private checkoutFor(tx: Tx, s: TenantSession, q: any, input: Pick<CheckoutCmd, 'payments' | 'customerId' | 'approvals' | 'billDiscount'>) {
    return this.checkout.checkout(tx, s, {
      idempotencyKey: `quote-${q.id}`, customerId: input.customerId ?? q.customer_id ?? undefined, payments: input.payments, approvals: input.approvals, billDiscount: input.billDiscount,
      lines: q.lines.map((l: any) => ({ productId: l.productId, unitId: l.unitId, qty: l.qty })),
    });
  }

  async cancel(tx: Tx, s: TenantSession, id: string) {
    const r = await tx.query(`UPDATE quotation SET status='cancelled' WHERE shop_id=$1 AND id=$2 AND status='open' RETURNING id`, [s.shopId, id]);
    if (!r.rowCount) throw E.notFound('Open quotation');
  }

  async expireOld(tx: Tx, shopId: string): Promise<number> {
    return (await tx.query(`UPDATE quotation SET status='expired' WHERE shop_id=$1 AND status='open' AND valid_until < current_date`, [shopId])).rowCount;
  }
}

@Injectable()
export class DeliveryNoteService {
  constructor(private readonly audit: AuditService) {}

  /** Part deliveries: each note covers some quantity of a sale line; the total can never exceed what was sold. */
  async create(tx: Tx, s: TenantSession, input: { saleId: string; lines: { saleLineId: string; qty: string }[]; note?: string }) {
    if (!s.branchId) throw E.validation('Choose a branch first');
    await lockSale(tx, input.saleId);
    const sale = (await tx.query(`SELECT id FROM sale WHERE shop_id=$1 AND id=$2`, [s.shopId, input.saleId])).rows[0];
    if (!sale) throw E.notFound('Sale');
    if ((await tx.query(`SELECT 1 FROM sale_void WHERE sale_id=$1`, [input.saleId])).rowCount) throw E.conflict('This sale was voided');
    const prepared: { id: string; qty: string }[] = [];
    for (const l of input.lines) {
      const row = (
        await tx.query(
          `SELECT l.id, l.qty_unit, l.unit, coalesce((SELECT sum(d.qty_unit) FROM delivery_note_line d WHERE d.sale_line_id=l.id),0) AS delivered
           FROM sale_line l WHERE l.shop_id=$1 AND l.id=$2 AND l.sale_id=$3`,
          [s.shopId, l.saleLineId, input.saleId],
        )
      ).rows[0];
      if (!row) throw E.notFound('Sale line');
      const left = D(row.qty_unit).minus(row.delivered);
      if (!D(l.qty).gt(0) || D(l.qty).gt(left)) throw E.validation(`Only ${left.toString()} ${row.unit} left to deliver`, { saleLineId: l.saleLineId, left: left.toString() });
      prepared.push({ id: l.saleLineId, qty: l.qty });
    }
    const number = `DN-${String(await nextCounter(tx, s.shopId, 'delivery_note')).padStart(6, '0')}`;
    const dn = (await tx.query(`INSERT INTO delivery_note(shop_id, branch_id, sale_id, number, created_by, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, number`, [s.shopId, s.branchId, input.saleId, number, s.userId, input.note ?? null])).rows[0];
    for (const l of prepared) await tx.query(`INSERT INTO delivery_note_line(shop_id, note_id, sale_line_id, qty_unit) VALUES ($1,$2,$3,$4)`, [s.shopId, dn.id, l.id, l.qty]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'delivery_note.created', entity: 'delivery_note', entityId: dn.id, new: { number } });
    return dn;
  }

  async status(tx: Tx, shopId: string, saleId: string) {
    return (
      await tx.query(
        `SELECT l.id AS sale_line_id, p.name, l.unit, l.qty_unit AS sold,
                coalesce((SELECT sum(d.qty_unit) FROM delivery_note_line d WHERE d.sale_line_id=l.id),0) AS delivered
         FROM sale_line l JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id WHERE l.shop_id=$1 AND l.sale_id=$2 ORDER BY l.line_no`,
        [shopId, saleId],
      )
    ).rows.map((r) => ({ ...r, remaining: D(r.sold).minus(r.delivered).toString() }));
  }
}
