import { Injectable } from '@nestjs/common';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { CustomerService } from '../customers/customer.service';
import { ChequeService } from '../customers/cheque.service';
import { LowStockService } from '../inventory/lowstock.service';

export interface Period {
  branchId?: string;
  from?: string;
  to?: string;
}

/** Profit and dashboards. Everything here that touches cost is behind profit.view / cost.view at the controller. */
@Injectable()
export class ReportsService {
  constructor(private readonly customers: CustomerService, private readonly cheques: ChequeService, private readonly low: LowStockService) {}

  /**
   * Estimated gross profit = sales - returns - (cost of goods sold - cost of goods returned).
   * Cost of goods sold comes from the value stored permanently on each sale line, so repricing or a costing
   * method change never rewrites past profit. Voided sales are excluded.
   */
  async profit(tx: Tx, shopId: string, p: Period) {
    const args = [shopId, p.branchId ?? null, p.from ?? null, p.to ?? null];
    const sales = (
      await tx.query(
        `SELECT count(*)::int AS bills, coalesce(sum(s.total),0) AS sales, coalesce(sum(s.cogs_total),0) AS cogs, coalesce(sum(s.bill_discount),0) AS bill_discounts
         FROM sale s WHERE s.shop_id=$1 AND ($2::uuid IS NULL OR s.branch_id=$2) AND ($3::timestamptz IS NULL OR s.created_at >= $3) AND ($4::timestamptz IS NULL OR s.created_at < $4)
           AND NOT EXISTS (SELECT 1 FROM sale_void v WHERE v.sale_id = s.id)`,
        args,
      )
    ).rows[0];
    const ret = (
      await tx.query(
        `SELECT coalesce(sum(l.amount),0) AS amount, coalesce(sum(l.qty_base * l.unit_cost),0) AS cogs_back
         FROM sales_return r JOIN sales_return_line l ON l.shop_id=r.shop_id AND l.return_id=r.id
         WHERE r.shop_id=$1 AND ($2::uuid IS NULL OR r.branch_id=$2) AND ($3::timestamptz IS NULL OR r.created_at >= $3) AND ($4::timestamptz IS NULL OR r.created_at < $4)`,
        args,
      )
    ).rows[0];
    const netSales = D(sales.sales).minus(ret.amount);
    const netCogs = D(sales.cogs).minus(ret.cogs_back);
    return {
      bills: sales.bills, sales: D(sales.sales).toString(), returns: D(ret.amount).toString(), netSales: netSales.toString(),
      cogs: netCogs.toDecimalPlaces(2).toString(), estimatedGrossProfit: netSales.minus(netCogs).toDecimalPlaces(2).toString(),
      marginPct: netSales.isZero() ? null : netSales.minus(netCogs).div(netSales).times(100).toDecimalPlaces(1).toString(),
      billDiscounts: D(sales.bill_discounts).toString(),
    };
  }

  /** Profit by item, category, cashier or branch (line level, before returns and bill discounts). */
  async profitBy(tx: Tx, shopId: string, by: 'item' | 'category' | 'cashier' | 'branch', p: Period) {
    const key = { item: 'p.id', category: `coalesce(p.category,'(none)')`, cashier: 's.cashier_id', branch: 's.branch_id' }[by];
    const label = { item: 'p.name', category: `coalesce(p.category,'(none)')`, cashier: `(SELECT u.name FROM users u WHERE u.shop_id=s.shop_id AND u.id=s.cashier_id)`, branch: `(SELECT b.name FROM branch b WHERE b.shop_id=s.shop_id AND b.id=s.branch_id)` }[by];
    const rows = (
      await tx.query(
        `SELECT ${key} AS key, ${label} AS label, sum(l.qty_unit) AS qty, sum(l.line_total) AS revenue, sum(l.cogs) AS cogs, sum(l.line_total - l.cogs) AS profit
         FROM sale_line l JOIN sale s ON s.shop_id=l.shop_id AND s.id=l.sale_id JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id
         WHERE l.shop_id=$1 AND ($2::uuid IS NULL OR s.branch_id=$2) AND ($3::timestamptz IS NULL OR s.created_at >= $3) AND ($4::timestamptz IS NULL OR s.created_at < $4)
           AND NOT EXISTS (SELECT 1 FROM sale_void v WHERE v.sale_id = s.id)
         GROUP BY 1, 2 ORDER BY profit DESC LIMIT 200`,
        [shopId, p.branchId ?? null, p.from ?? null, p.to ?? null],
      )
    ).rows;
    return rows.map((r) => ({ key: r.key, label: r.label, qty: D(r.qty).toString(), revenue: D(r.revenue).toString(), cogs: D(r.cogs).toDecimalPlaces(2).toString(), profit: D(r.profit).toDecimalPlaces(2).toString() }));
  }

  /**
   * Quiet flags (never block a sale): items sold below cost, items with only estimated/missing cost, and the
   * replacement-cost margin (latest purchase cost vs current selling price) to catch supplier increases early.
   */
  async costFlags(tx: Tx, shopId: string, p: Period) {
    const below = (
      await tx.query(
        `SELECT p.id, p.name, count(*)::int AS lines FROM sale_line l JOIN sale s ON s.shop_id=l.shop_id AND s.id=l.sale_id JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id
         WHERE l.shop_id=$1 AND l.below_cost AND ($2::timestamptz IS NULL OR s.created_at >= $2) AND ($3::timestamptz IS NULL OR s.created_at < $3)
           AND NOT EXISTS (SELECT 1 FROM sale_void v WHERE v.sale_id=s.id) GROUP BY p.id, p.name ORDER BY lines DESC LIMIT 100`,
        [shopId, p.from ?? null, p.to ?? null],
      )
    ).rows;
    const missing = (
      await tx.query(
        `SELECT p.id, p.name FROM product p WHERE p.shop_id=$1 AND p.status='active' AND p.last_cost IS NULL
           AND NOT EXISTS (SELECT 1 FROM cost_layer c WHERE c.product_id=p.id AND c.estimated=false) ORDER BY p.name LIMIT 200`,
        [shopId],
      )
    ).rows;
    const margin = (
      await tx.query(
        `SELECT p.id, p.name, pp.price, p.last_cost,
                CASE WHEN pp.price > 0 THEN round((pp.price - p.last_cost) / pp.price * 100, 1) END AS margin_pct
         FROM product p JOIN product_unit u ON u.product_id=p.id AND u.is_base JOIN product_price pp ON pp.product_id=p.id AND pp.unit_id=u.id AND pp.tier='retail'
         WHERE p.shop_id=$1 AND p.status='active' AND p.last_cost IS NOT NULL ORDER BY margin_pct NULLS LAST LIMIT 100`,
        [shopId],
      )
    ).rows;
    return { soldBelowCost: below, missingCost: missing, replacementMargin: margin.map((m) => ({ id: m.id, name: m.name, price: D(m.price).toString(), replacementCost: D(m.last_cost).toString(), marginPct: m.margin_pct })) };
  }

  /** Owner's home screen. Profit figures are included only when the caller may see cost. */
  async dashboard(tx: Tx, shopId: string, opts: { branchId?: string; includeProfit: boolean }) {
    const from = new Date(new Date().toDateString()).toISOString();
    const today = await this.profit(tx, shopId, { branchId: opts.branchId, from });
    const byMethod = (
      await tx.query(
        `SELECT pay.method, sum(pay.amount) AS net FROM payment pay WHERE pay.shop_id=$1 AND ($2::uuid IS NULL OR pay.branch_id=$2) AND pay.created_at >= $3 GROUP BY pay.method ORDER BY pay.method`,
        [shopId, opts.branchId ?? null, from],
      )
    ).rows.map((r) => ({ method: r.method, net: D(r.net).toString() }));
    const overdue = await this.customers.overdue(tx, shopId);
    const cheques = await this.cheques.dueThisWeek(tx, shopId);
    const lowStock = await this.low.list(tx, shopId, opts.branchId);
    const out: any = {
      today: { bills: today.bills, sales: today.sales, returns: today.returns, netSales: today.netSales },
      byMethod,
      lowStockItems: lowStock.filter((r) => r.state === 'low').length,
      outOfStockItems: lowStock.filter((r) => r.state === 'out').length,
      overdueCredit: { customers: overdue.length, amount: overdue.reduce((a, r) => a.plus(r.overdue), D(0)).toString() },
      chequesDueThisWeek: { count: cheques.length, amount: cheques.reduce((a, r) => a.plus(r.amount), D(0)).toString() },
    };
    if (opts.includeProfit) Object.assign(out.today, { cogs: today.cogs, estimatedGrossProfit: today.estimatedGrossProfit, marginPct: today.marginPct });
    return out;
  }

  /** Branch comparison: bills and sales per branch; stock value at cost only for roles that may see cost. */
  async branches(tx: Tx, shopId: string, p: Period, includeCost: boolean) {
    const rows = (
      await tx.query(
        `SELECT b.id, b.name,
           (SELECT count(*)::int FROM sale s WHERE s.branch_id=b.id AND ($2::timestamptz IS NULL OR s.created_at >= $2) AND ($3::timestamptz IS NULL OR s.created_at < $3)
              AND NOT EXISTS (SELECT 1 FROM sale_void v WHERE v.sale_id=s.id)) AS bills,
           (SELECT coalesce(sum(s.total),0) FROM sale s WHERE s.branch_id=b.id AND ($2::timestamptz IS NULL OR s.created_at >= $2) AND ($3::timestamptz IS NULL OR s.created_at < $3)
              AND NOT EXISTS (SELECT 1 FROM sale_void v WHERE v.sale_id=s.id)) AS sales,
           (SELECT coalesce(sum(quantity),0) FROM stock_balance sb WHERE sb.branch_id=b.id) AS units_in_stock,
           (SELECT coalesce(sum(l.qty_remaining * l.unit_cost),0) FROM cost_layer l WHERE l.branch_id=b.id AND l.qty_remaining > 0) AS stock_value
         FROM branch b WHERE b.shop_id=$1 AND b.status='active' ORDER BY b.name`,
        [shopId, p.from ?? null, p.to ?? null],
      )
    ).rows;
    return rows.map((r) => ({ branchId: r.id, branch: r.name, bills: r.bills, sales: D(r.sales).toString(), unitsInStock: D(r.units_in_stock).toString(), ...(includeCost ? { stockValue: D(r.stock_value).toDecimalPlaces(2).toString() } : {}) }));
  }
}
