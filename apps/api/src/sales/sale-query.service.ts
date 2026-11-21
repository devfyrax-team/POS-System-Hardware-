import { Injectable } from '@nestjs/common';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';

export interface SummaryFilter {
  branchId?: string;
  terminalId?: string;
  cashierId?: string;
  from?: string;
  to?: string;
}

/** Reads over sales. Cost and profit are never returned here (they live behind cost.view / profit.view). */
@Injectable()
export class SaleQueryService {
  async get(tx: Tx, shopId: string, saleId: string, opts: { onlyCashierId?: string } = {}) {
    const sale = (
      await tx.query(
        `SELECT s.id, s.invoice_no, s.branch_id, s.terminal_id, s.cashier_id, s.customer_id, s.price_tier, s.subtotal, s.bill_discount, s.total, s.paid, s.tendered,
                s.change_due, s.note, s.created_at, (v.sale_id IS NOT NULL) AS voided, v.reason AS void_reason
         FROM sale s LEFT JOIN sale_void v ON v.sale_id = s.id WHERE s.shop_id=$1 AND s.id=$2`,
        [shopId, saleId],
      )
    ).rows[0];
    if (!sale || (opts.onlyCashierId && sale.cashier_id !== opts.onlyCashierId)) throw E.notFound('Sale');
    const lines = (
      await tx.query(
        `SELECT l.id, l.line_no, l.product_id, p.name, l.unit, l.qty_unit, l.price_charged, l.price_overridden, l.discount, l.line_total,
                coalesce((SELECT sum(r.qty_unit) FROM sales_return_line r WHERE r.sale_line_id = l.id),0) AS returned_qty
         FROM sale_line l JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id WHERE l.shop_id=$1 AND l.sale_id=$2 ORDER BY l.line_no`,
        [shopId, saleId],
      )
    ).rows;
    const payments = (await tx.query(`SELECT kind, method, amount, reference, created_at FROM payment WHERE shop_id=$1 AND sale_id=$2 ORDER BY created_at, id`, [shopId, saleId])).rows;
    return { ...sale, lines, payments };
  }

  async list(tx: Tx, shopId: string, f: SummaryFilter & { invoiceNo?: string; limit?: number; beforeCreatedAt?: string }) {
    return (
      await tx.query(
        `SELECT s.id, s.invoice_no, s.branch_id, s.terminal_id, s.cashier_id, s.total, s.created_at, (v.sale_id IS NOT NULL) AS voided
         FROM sale s LEFT JOIN sale_void v ON v.sale_id = s.id
         WHERE s.shop_id=$1 AND ($2::uuid IS NULL OR s.branch_id=$2) AND ($3::uuid IS NULL OR s.cashier_id=$3) AND ($4::uuid IS NULL OR s.terminal_id=$4)
           AND ($5::timestamptz IS NULL OR s.created_at >= $5) AND ($6::timestamptz IS NULL OR s.created_at < $6)
           AND ($7::text IS NULL OR s.invoice_no ILIKE $7 || '%') AND ($8::timestamptz IS NULL OR s.created_at < $8)
         ORDER BY s.created_at DESC LIMIT $9`,
        [shopId, f.branchId ?? null, f.cashierId ?? null, f.terminalId ?? null, f.from ?? null, f.to ?? null, f.invoiceNo ?? null, f.beforeCreatedAt ?? null, Math.min(f.limit ?? 50, 200)],
      )
    ).rows;
  }

  /** Totals for a period: sales (not voided), returns, and cash/card/... by payment method, by cashier and terminal. */
  async summary(tx: Tx, shopId: string, f: SummaryFilter) {
    const p = [shopId, f.branchId ?? null, f.cashierId ?? null, f.terminalId ?? null, f.from ?? null, f.to ?? null];
    const where = `s.shop_id=$1 AND ($2::uuid IS NULL OR s.branch_id=$2) AND ($3::uuid IS NULL OR s.cashier_id=$3) AND ($4::uuid IS NULL OR s.terminal_id=$4)
                   AND ($5::timestamptz IS NULL OR s.created_at >= $5) AND ($6::timestamptz IS NULL OR s.created_at < $6)`;
    const sales = (
      await tx.query(
        `SELECT count(*)::int AS bills, coalesce(sum(s.total),0) AS total, coalesce(sum(s.bill_discount),0) AS bill_discounts
         FROM sale s WHERE ${where} AND NOT EXISTS (SELECT 1 FROM sale_void v WHERE v.sale_id=s.id)`,
        p,
      )
    ).rows[0];
    const voided = (
      await tx.query(`SELECT count(*)::int AS bills, coalesce(sum(s.total),0) AS total FROM sale s JOIN sale_void v ON v.sale_id=s.id WHERE ${where}`, p)
    ).rows[0];
    const returns = (
      await tx.query(
        `SELECT count(*)::int AS count, coalesce(sum(r.total),0) AS total FROM sales_return r JOIN sale s ON s.shop_id=r.shop_id AND s.id=r.sale_id WHERE ${where}`,
        p,
      )
    ).rows[0];
    const byMethod = (
      await tx.query(
        `SELECT pay.method, sum(pay.amount) AS net FROM payment pay JOIN sale s ON s.shop_id=pay.shop_id AND s.id=pay.sale_id WHERE ${where} GROUP BY pay.method ORDER BY pay.method`,
        p,
      )
    ).rows;
    const byCashier = (
      await tx.query(
        `SELECT s.cashier_id, u.name, count(*)::int AS bills, sum(s.total) AS total FROM sale s JOIN users u ON u.shop_id=s.shop_id AND u.id=s.cashier_id
         WHERE ${where} AND NOT EXISTS (SELECT 1 FROM sale_void v WHERE v.sale_id=s.id) GROUP BY s.cashier_id, u.name ORDER BY total DESC`,
        p,
      )
    ).rows;
    const byTerminal = (
      await tx.query(
        `SELECT s.terminal_id, t.prefix, count(*)::int AS bills, sum(s.total) AS total FROM sale s JOIN terminal t ON t.shop_id=s.shop_id AND t.id=s.terminal_id
         WHERE ${where} AND NOT EXISTS (SELECT 1 FROM sale_void v WHERE v.sale_id=s.id) GROUP BY s.terminal_id, t.prefix ORDER BY t.prefix`,
        p,
      )
    ).rows;
    return { sales, voided, returns, netSales: D(sales.total).minus(returns.total).toString(), byMethod, byCashier, byTerminal };
  }
}
