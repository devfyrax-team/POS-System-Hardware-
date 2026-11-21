import { Pool } from 'pg';

export interface Violation {
  check: string;
  count: number;
  sample: unknown[];
}

const CHECKS: { name: string; sql: string }[] = [
  {
    name: 'stock balance equals the sum of its ledger rows',
    sql: `SELECT sb.branch_id, sb.product_id, sb.quantity, coalesce(m.s,0) AS ledger
          FROM stock_balance sb LEFT JOIN (SELECT branch_id, product_id, sum(qty_base) s FROM stock_movement GROUP BY 1,2) m ON m.branch_id=sb.branch_id AND m.product_id=sb.product_id
          WHERE sb.quantity <> coalesce(m.s,0)`,
  },
  {
    name: 'ledger rows exist for items with no balance row',
    sql: `SELECT m.branch_id, m.product_id, sum(m.qty_base) s FROM stock_movement m LEFT JOIN stock_balance sb ON sb.branch_id=m.branch_id AND sb.product_id=m.product_id
          WHERE sb.product_id IS NULL GROUP BY 1,2 HAVING sum(m.qty_base) <> 0`,
  },
  {
    name: 'no negative stock',
    sql: `SELECT branch_id, product_id, quantity FROM stock_balance WHERE quantity < 0 OR damaged_qty < 0`,
  },
  {
    name: 'open cost layers never exceed the balance',
    sql: `SELECT l.branch_id, l.product_id, sum(l.qty_remaining) AS layers, max(sb.quantity) AS balance
          FROM cost_layer l JOIN stock_balance sb ON sb.branch_id=l.branch_id AND sb.product_id=l.product_id GROUP BY 1,2 HAVING sum(l.qty_remaining) > max(sb.quantity)`,
  },
  {
    name: 'batches never hold more than the balance',
    sql: `SELECT b.branch_id, b.product_id, sum(b.qty_remaining) AS batches, max(sb.quantity) AS balance
          FROM stock_batch b JOIN stock_balance sb ON sb.branch_id=b.branch_id AND sb.product_id=b.product_id GROUP BY 1,2 HAVING sum(b.qty_remaining) > max(sb.quantity)`,
  },
  {
    name: 'customer balance equals the sum of credit entries',
    sql: `SELECT c.id, c.balance, coalesce(e.s,0) AS ledger FROM customer c LEFT JOIN (SELECT customer_id, sum(amount) s FROM credit_entry GROUP BY 1) e ON e.customer_id=c.id
          WHERE c.balance <> coalesce(e.s,0)`,
  },
  {
    name: 'sale total equals its lines minus bill discount',
    sql: `SELECT s.id, s.total, coalesce(l.t,0) - s.bill_discount AS lines FROM sale s LEFT JOIN (SELECT sale_id, sum(line_total) t FROM sale_line GROUP BY 1) l ON l.sale_id=s.id
          WHERE s.total <> coalesce(l.t,0) - s.bill_discount`,
  },
  {
    name: 'sale payments equal the sale total',
    sql: `SELECT s.id, s.total, coalesce(p.t,0) AS paid FROM sale s LEFT JOIN (SELECT sale_id, sum(amount) t FROM payment WHERE kind='sale' GROUP BY 1) p ON p.sale_id=s.id
          WHERE s.total <> coalesce(p.t,0)`,
  },
  {
    name: 'sale cost of goods equals the sum of its lines',
    sql: `SELECT s.id, s.cogs_total, coalesce(l.c,0) AS lines FROM sale s LEFT JOIN (SELECT sale_id, sum(cogs) c FROM sale_line GROUP BY 1) l ON l.sale_id=s.id
          WHERE s.cogs_total <> coalesce(l.c,0)`,
  },
  {
    name: 'invoice numbers have no gaps per terminal',
    sql: `SELECT q.terminal_id, q.next - 1 AS issued, coalesce(c.n,0) AS sales FROM invoice_sequence q LEFT JOIN (SELECT terminal_id, count(*) n FROM sale GROUP BY 1) c ON c.terminal_id=q.terminal_id
          WHERE q.next - 1 <> coalesce(c.n,0)`,
  },
  {
    name: 'returns never exceed what was sold',
    sql: `SELECT l.id, l.qty_unit, r.q AS returned FROM sale_line l JOIN (SELECT sale_line_id, sum(qty_unit) q FROM sales_return_line GROUP BY 1) r ON r.sale_line_id=l.id WHERE r.q > l.qty_unit`,
  },
];

/** Database-level invariants that must always hold. Used by tests, the nightly check, and restore rehearsals. */
export async function checkIntegrity(pool: Pool, shopId?: string): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const c of CHECKS) {
    // run each check as the superuser: the report must not depend on a tenant context
    const r = await pool.query(c.sql);
    const rows = shopId ? r.rows : r.rows;
    if (rows.length) out.push({ check: c.name, count: rows.length, sample: rows.slice(0, 5) });
  }
  return out;
}

export const INTEGRITY_CHECK_NAMES = CHECKS.map((c) => c.name);
