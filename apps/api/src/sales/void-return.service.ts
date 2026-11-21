import { Injectable } from '@nestjs/common';
import { D, Decimal, convertQty, roundCost, roundMoney } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { nextCounter } from '../common/counter';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { ApprovalService } from '../identity/approval.service';
import { StockService } from '../inventory/stock.service';
import { OutboxService } from '../jobs/outbox.service';
import { CheckoutHooks } from './checkout.hooks';

/** Insert-only tables cannot be row-locked (that needs UPDATE rights), so concurrent void/return/delivery on one sale queue on this lock. */
export async function lockSale(tx: Tx, saleId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [saleId]);
}

export interface ReturnInput {
  saleId: string;
  lines: { saleLineId: string; qty: string; disposition?: 'sellable' | 'damaged' }[];
  reason: string;
  refundMethod: 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'account_credit';
  approvalToken?: string;
}

/** Voids and returns are NEW entries. The original sale, its lines and payments are never edited. */
@Injectable()
export class VoidReturnService {
  constructor(
    private readonly stock: StockService,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly hooks: CheckoutHooks,
  ) {}

  /** Needs sale.void, or a supervisor override token bound to this sale. Both people are logged. */
  private authorize(s: TenantSession, perm: 'sale.void' | 'sale.refund', saleId: string, token?: string): string | null {
    if (s.permissions?.has(perm)) return null;
    return this.approvals.verify(token, s, { action: perm, entityId: saleId });
  }

  async void(tx: Tx, s: TenantSession, saleId: string, input: { reason: string; approvalToken?: string }) {
    if (!input.reason.trim()) throw E.validation('A reason is required');
    const approver = this.authorize(s, 'sale.void', saleId, input.approvalToken);
    await lockSale(tx, saleId); // sales are insert-only (no row locks): serialise per sale with an advisory lock
    const sale = (await tx.query(`SELECT id, branch_id, customer_id, invoice_no FROM sale WHERE shop_id=$1 AND id=$2`, [s.shopId, saleId])).rows[0];
    if (!sale) throw E.notFound('Sale');
    if ((await tx.query(`SELECT 1 FROM sale_void WHERE sale_id=$1`, [saleId])).rowCount) throw E.conflict('Sale is already voided');
    if ((await tx.query(`SELECT 1 FROM sales_return WHERE shop_id=$1 AND sale_id=$2`, [s.shopId, saleId])).rowCount) throw E.conflict('A sale with returns cannot be voided');

    const lines = (await tx.query(`SELECT product_id, qty_base, cogs, batch_id, unit, qty_unit, factor FROM sale_line WHERE shop_id=$1 AND sale_id=$2 ORDER BY product_id, line_no`, [s.shopId, saleId])).rows;
    for (const l of lines) {
      await this.stock.apply(tx, {
        shopId: s.shopId, branchId: sale.branch_id, productId: l.product_id, type: 'sales_return', qtyBase: l.qty_base, batchId: l.batch_id,
        unitCost: roundCost(D(l.cogs).div(l.qty_base)).toString(), unit: l.unit, qtyUnit: l.qty_unit, factor: l.factor,
        refType: 'void', refId: saleId, reason: input.reason, userId: s.userId,
      });
    }
    const pays = (await tx.query(`SELECT method, amount, reference FROM payment WHERE shop_id=$1 AND sale_id=$2 AND kind='sale'`, [s.shopId, saleId])).rows;
    for (const p of pays) {
      await tx.query(
        `INSERT INTO payment(shop_id, branch_id, terminal_id, sale_id, kind, method, amount, reference, created_by) VALUES ($1,$2,$3,$4,'void',$5,$6,$7,$8)`,
        [s.shopId, sale.branch_id, s.terminalId ?? null, saleId, p.method, D(p.amount).neg().toString(), p.reference, s.userId],
      );
      if (p.method === 'credit' && this.hooks.reverse && sale.customer_id) {
        await this.hooks.reverse(tx, s, { customerId: sale.customer_id, amount: p.amount, saleId, reason: 'void' });
      }
    }
    await tx.query(`INSERT INTO sale_void(sale_id, shop_id, reason, voided_by, approver_id) VALUES ($1,$2,$3,$4,$5)`, [saleId, s.shopId, input.reason, s.userId, approver]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, approverId: approver, terminalId: s.terminalId ?? null, action: 'sale.voided', entity: 'sale', entityId: saleId, new: { reason: input.reason, invoiceNo: sale.invoice_no } });
    await this.outbox.publish(tx, s.shopId, 'sale.voided', { saleId, branchId: sale.branch_id });
    return { saleId, voided: true };
  }

  async createReturn(tx: Tx, s: TenantSession, input: ReturnInput) {
    if (!input.reason.trim()) throw E.validation('A reason is required');
    if (!input.lines.length) throw E.validation('Choose at least one item to return');
    const approver = this.authorize(s, 'sale.refund', input.saleId, input.approvalToken);
    await lockSale(tx, input.saleId);
    const sale = (await tx.query(`SELECT id, branch_id, customer_id FROM sale WHERE shop_id=$1 AND id=$2`, [s.shopId, input.saleId])).rows[0];
    if (!sale) throw E.notFound('Sale');
    if ((await tx.query(`SELECT 1 FROM sale_void WHERE sale_id=$1`, [input.saleId])).rowCount) throw E.conflict('This sale was voided');

    // Phase A: validate every line and work out the amounts (no writes yet)
    const plan: { l: any; qty: Decimal; qtyBase: Decimal; amount: Decimal; unitCost: Decimal; disposition: 'sellable' | 'damaged' }[] = [];
    const wanted = [...input.lines].sort((x, y) => (x.saleLineId < y.saleLineId ? -1 : 1));
    for (const w of wanted) {
      const l = (
        await tx.query(
          `SELECT l.*, p.non_returnable, p.name FROM sale_line l JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id WHERE l.shop_id=$1 AND l.id=$2 AND l.sale_id=$3`,
          [s.shopId, w.saleLineId, input.saleId],
        )
      ).rows[0];
      if (!l) throw E.notFound('Sale line');
      if (l.non_returnable) throw E.validation(`"${l.name}" cannot be returned`);
      const qty = D(w.qty);
      if (!qty.gt(0)) throw E.validation('Return quantity must be positive');
      const prior = (await tx.query(`SELECT coalesce(sum(qty_unit),0) q, coalesce(sum(qty_base),0) qb, coalesce(sum(amount),0) a FROM sales_return_line WHERE shop_id=$1 AND sale_line_id=$2`, [s.shopId, l.id])).rows[0];
      const remaining = D(l.qty_unit).minus(prior.q);
      if (qty.gt(remaining)) throw E.validation(`Only ${remaining.toString()} ${l.unit} of "${l.name}" can still be returned`, { saleLineId: l.id, remaining: remaining.toString() });
      const isLast = qty.equals(remaining); // the last return of a line takes the exact remainder (no rounding drift)
      plan.push({
        l, qty, disposition: w.disposition ?? 'sellable',
        amount: isLast ? D(l.line_total).minus(prior.a) : roundMoney(D(l.line_total).times(qty).div(l.qty_unit)),
        qtyBase: isLast ? D(l.qty_base).minus(prior.qb) : convertQty(qty, l.factor),
        unitCost: roundCost(D(l.cogs).div(l.qty_base)),
      });
    }
    const total = plan.reduce((a, x) => a.plus(x.amount), D(0));

    // Phase B: write
    const number = `RET-${String(await nextCounter(tx, s.shopId, 'return')).padStart(6, '0')}`;
    const ret = (
      await tx.query(
        `INSERT INTO sales_return(shop_id, branch_id, terminal_id, sale_id, number, reason, refund_method, total, created_by, approver_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [s.shopId, sale.branch_id, s.terminalId ?? null, input.saleId, number, input.reason, input.refundMethod, total.toString(), s.userId, approver],
      )
    ).rows[0];
    for (const x of plan) {
      const { l } = x;
      await this.stock.apply(tx, {
        shopId: s.shopId, branchId: sale.branch_id, productId: l.product_id, type: 'sales_return', qtyBase: x.qtyBase.toString(), batchId: l.batch_id,
        unitCost: x.unitCost.toString(), unit: l.unit, qtyUnit: x.qty.toString(), factor: l.factor, refType: 'return', refId: ret.id, reason: input.reason, userId: s.userId,
      });
      if (x.disposition === 'damaged') {
        // back on the premises only as damaged stock (kept apart so dented items can be sold at a discount)
        await this.stock.apply(tx, {
          shopId: s.shopId, branchId: sale.branch_id, productId: l.product_id, type: 'damaged', qtyBase: x.qtyBase.neg().toString(), batchId: l.batch_id,
          refType: 'return', refId: ret.id, reason: `damaged return: ${input.reason}`, userId: s.userId,
        });
      }
      await tx.query(
        `INSERT INTO sales_return_line(shop_id, return_id, sale_line_id, product_id, qty_unit, qty_base, amount, disposition, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.shopId, ret.id, l.id, l.product_id, x.qty.toString(), x.qtyBase.toString(), x.amount.toString(), x.disposition, x.unitCost.toString()],
      );
    }

    if (input.refundMethod === 'account_credit') {
      if (!sale.customer_id || !this.hooks.reverse) throw E.validation('Account credit needs a customer account on the sale');
      await this.hooks.reverse(tx, s, { customerId: sale.customer_id, amount: total.toString(), saleId: input.saleId, reason: `return ${number}` });
    } else {
      await tx.query(
        `INSERT INTO payment(shop_id, branch_id, terminal_id, sale_id, kind, method, amount, reference, created_by) VALUES ($1,$2,$3,$4,'refund',$5,$6,$7,$8)`,
        [s.shopId, sale.branch_id, s.terminalId ?? null, input.saleId, input.refundMethod, total.neg().toString(), number, s.userId],
      );
    }
    await this.audit.record(tx, {
      shopId: s.shopId, actorId: s.userId, approverId: approver, terminalId: s.terminalId ?? null, action: 'sale.returned', entity: 'sales_return', entityId: ret.id,
      new: { number, total: total.toString(), lines: input.lines.length },
    });
    return { returnId: ret.id as string, number, total: total.toString(), refundMethod: input.refundMethod };
  }
}

export { Decimal };
