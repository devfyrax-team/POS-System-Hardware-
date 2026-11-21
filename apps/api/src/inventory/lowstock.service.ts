import { Injectable } from '@nestjs/common';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { OutboxService } from '../jobs/outbox.service';
import { ProductService } from '../catalog/product.service';

export type StockState = 'ok' | 'low' | 'out';

export function stateFor(qty: string, minLevel: string): StockState {
  const q = D(qty);
  if (q.lte(0)) return 'out';
  const m = D(minLevel);
  if (m.gt(0) && q.lte(m)) return 'low';
  return 'ok';
}

/**
 * Low-stock alerts replace negative stock. One alert per threshold crossing; re-armed when stock is restocked
 * above the level. The event is written to the outbox in the same transaction as the stock change.
 */
@Injectable()
export class LowStockService {
  constructor(private readonly outbox: OutboxService, private readonly products: ProductService) {}

  /** Called by StockService after every balance change. */
  async afterChange(tx: Tx, shopId: string, branchId: string, productId: string, newQty: string): Promise<StockState> {
    const min = await this.products.minLevel(tx, shopId, branchId, productId);
    const next = stateFor(newQty, min);
    const prev = (await tx.query(`SELECT state FROM low_stock_alert_state WHERE branch_id=$1 AND product_id=$2`, [branchId, productId])).rows[0]?.state as StockState | undefined;
    if ((prev ?? 'ok') === next) return next;
    await tx.query(
      `INSERT INTO low_stock_alert_state(shop_id, branch_id, product_id, state) VALUES ($1,$2,$3,$4)
       ON CONFLICT (branch_id, product_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()`,
      [shopId, branchId, productId, next],
    );
    if (next !== 'ok') {
      await this.outbox.publish(tx, shopId, 'stock.low', { branchId, productId, quantity: newQty, minLevel: min, state: next });
    }
    return next;
  }

  /** Low and out-of-stock lists for the back office / dashboard. */
  async list(tx: Tx, shopId: string, branchId?: string) {
    return (
      await tx.query(
        `SELECT b.id AS branch_id, p.id AS product_id, p.sku, p.name, p.base_unit, coalesce(sb.quantity,0) AS quantity,
                coalesce(bp.min_level, p.min_level) AS min_level,
                CASE WHEN coalesce(sb.quantity,0) <= 0 THEN 'out' ELSE 'low' END AS state
         FROM product p CROSS JOIN branch b
         LEFT JOIN stock_balance sb ON sb.branch_id=b.id AND sb.product_id=p.id
         LEFT JOIN branch_product bp ON bp.branch_id=b.id AND bp.product_id=p.id
         WHERE p.shop_id=$1 AND b.shop_id=$1 AND b.status='active' AND p.status='active' AND ($2::uuid IS NULL OR b.id=$2)
           AND (coalesce(bp.available,true))
           AND (coalesce(sb.quantity,0) <= 0 AND (coalesce(sb.quantity,0) <> 0 OR EXISTS (SELECT 1 FROM stock_movement m WHERE m.branch_id=b.id AND m.product_id=p.id))
                OR (coalesce(bp.min_level, p.min_level) > 0 AND coalesce(sb.quantity,0) <= coalesce(bp.min_level, p.min_level)))
         ORDER BY state DESC, p.name`,
        [shopId, branchId ?? null],
      )
    ).rows;
  }

  /** Daily safety net: re-evaluates every product/branch and raises alerts that were missed. */
  async dailyCheck(tx: Tx, shopId: string): Promise<number> {
    const rows = (
      await tx.query(
        `SELECT b.id AS branch_id, p.id AS product_id, coalesce(sb.quantity,0) AS quantity
         FROM product p CROSS JOIN branch b LEFT JOIN stock_balance sb ON sb.branch_id=b.id AND sb.product_id=p.id
         WHERE p.shop_id=$1 AND b.shop_id=$1 AND p.status='active' AND b.status='active'
           AND (sb.product_id IS NOT NULL OR p.min_level > 0)`,
        [shopId],
      )
    ).rows;
    let changed = 0;
    for (const r of rows) {
      const before = (await tx.query(`SELECT state FROM low_stock_alert_state WHERE branch_id=$1 AND product_id=$2`, [r.branch_id, r.product_id])).rows[0]?.state ?? 'ok';
      const after = await this.afterChange(tx, shopId, r.branch_id, r.product_id, r.quantity);
      if (before !== after) changed++;
    }
    return changed;
  }
}
