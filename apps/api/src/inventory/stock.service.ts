import { Injectable } from '@nestjs/common';
import { MovementType } from '@pos/contracts';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { CostingService, CostMethod } from './costing.service';
import { LowStockService } from './lowstock.service';

export interface MovementInput {
  shopId: string;
  branchId: string;
  productId: string;
  type: MovementType;
  /** Signed quantity in BASE units: positive = stock in, negative = stock out. */
  qtyBase: string;
  batchId?: string | null;
  unit?: string;
  qtyUnit?: string;
  factor?: string;
  /** Cost per base unit for stock coming in (omit to use the last known cost, marked estimated). */
  unitCost?: string | null;
  supplierId?: string | null;
  refType?: string;
  refId?: string;
  reason?: string;
  userId?: string | null;
  costMethod?: CostMethod;
}

export interface MovementResult {
  movementId: number;
  balanceAfter: string;
  cogs?: string; // out movements
  unitCost: string;
  parts?: { layerId: number | null; qty: string; unitCost: string }[];
  estimated: boolean;
}

/**
 * The ONLY way stock changes. Every change is an immutable ledger row, and the cached balance is updated in
 * the same transaction by one atomic statement, so two tills can never take the same last unit.
 */
@Injectable()
export class StockService {
  constructor(private readonly costing: CostingService, private readonly low: LowStockService) {}

  /**
   * Check-and-decrement in a single UPDATE (never read-then-write). The row lock serialises two sales of the
   * same product; the second re-checks against the new quantity. Different products never wait for each other.
   * Returns the new quantity, or null when there is not enough stock.
   */
  async decrementAtomic(tx: Tx, shopId: string, branchId: string, productId: string, qty: string): Promise<string | null> {
    const r = await tx.query(
      `UPDATE stock_balance SET quantity = quantity - $4, updated_at = now()
       WHERE shop_id=$1 AND branch_id=$2 AND product_id=$3 AND quantity >= $4
       RETURNING quantity`,
      [shopId, branchId, productId, qty],
    );
    return r.rowCount ? String(r.rows[0].quantity) : null;
  }

  async available(tx: Tx, branchId: string, productId: string): Promise<string> {
    const r = await tx.query(`SELECT quantity FROM stock_balance WHERE branch_id=$1 AND product_id=$2`, [branchId, productId]);
    return r.rowCount ? String(r.rows[0].quantity) : '0';
  }

  async apply(tx: Tx, m: MovementInput): Promise<MovementResult> {
    const qty = D(m.qtyBase);
    if (qty.isZero()) throw E.validation('Quantity cannot be zero');
    return qty.gt(0) ? this.applyIn(tx, m, qty.toString()) : this.applyOut(tx, m, qty.abs().toString());
  }

  private async applyIn(tx: Tx, m: MovementInput, qty: string): Promise<MovementResult> {
    const bal = (
      await tx.query(
        `INSERT INTO stock_balance(shop_id, branch_id, product_id, quantity) VALUES ($1,$2,$3,$4)
         ON CONFLICT (branch_id, product_id) DO UPDATE SET quantity = stock_balance.quantity + EXCLUDED.quantity, updated_at = now()
         RETURNING quantity`,
        [m.shopId, m.branchId, m.productId, qty],
      )
    ).rows[0];
    if (m.batchId) await tx.query(`UPDATE stock_batch SET qty_remaining = qty_remaining + $2 WHERE shop_id=$1 AND id=$3`, [m.shopId, qty, m.batchId]);
    const layer = await this.costing.createLayer(tx, {
      shopId: m.shopId, branchId: m.branchId, productId: m.productId, batchId: m.batchId, qty, unitCost: m.unitCost,
      sourceType: m.type, sourceId: m.refId, supplierId: m.supplierId,
    });
    const id = await this.insertMovement(tx, m, qty, layer.unitCost);
    await this.low.afterChange(tx, m.shopId, m.branchId, m.productId, String(bal.quantity));
    return { movementId: id, balanceAfter: String(bal.quantity), unitCost: layer.unitCost, estimated: layer.estimated };
  }

  private async applyOut(tx: Tx, m: MovementInput, qty: string): Promise<MovementResult> {
    const after = await this.decrementAtomic(tx, m.shopId, m.branchId, m.productId, qty);
    if (after === null) {
      const have = await this.available(tx, m.branchId, m.productId);
      throw E.stockShort({ productId: m.productId, requested: qty, available: have });
    }
    if (m.batchId) {
      const b = await tx.query(`UPDATE stock_batch SET qty_remaining = qty_remaining - $2 WHERE shop_id=$1 AND id=$3 AND qty_remaining >= $2`, [m.shopId, qty, m.batchId]);
      if (!b.rowCount) throw E.stockShort({ productId: m.productId, batchId: m.batchId, requested: qty });
    }
    if (m.type === 'damaged') {
      await tx.query(`UPDATE stock_balance SET damaged_qty = damaged_qty + $3 WHERE branch_id=$1 AND product_id=$2`, [m.branchId, m.productId, qty]);
    }
    const cost = await this.costing.consume(tx, { shopId: m.shopId, branchId: m.branchId, productId: m.productId, qty, method: m.costMethod, batchId: m.batchId });
    const id = await this.insertMovement(tx, m, D(qty).neg().toString(), cost.unitCost);
    await this.low.afterChange(tx, m.shopId, m.branchId, m.productId, after);
    return { movementId: id, balanceAfter: after, cogs: cost.cogs, unitCost: cost.unitCost, parts: cost.parts, estimated: cost.estimated };
  }

  private async insertMovement(tx: Tx, m: MovementInput, signedQty: string, unitCost: string): Promise<number> {
    const r = await tx.query(
      `INSERT INTO stock_movement(shop_id, branch_id, product_id, batch_id, type, qty_base, unit, qty_unit, factor, unit_cost, ref_type, ref_id, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        m.shopId, m.branchId, m.productId, m.batchId ?? null, m.type, signedQty, m.unit ?? null, m.qtyUnit ?? null, m.factor ?? null, unitCost,
        m.refType ?? null, m.refId ?? null, m.reason ?? null, m.userId ?? null,
      ],
    );
    return Number(r.rows[0].id);
  }

  // ----- reads -----
  async balances(tx: Tx, shopId: string, f: { branchId?: string; productId?: string; limit?: number; offset?: number } = {}) {
    return (
      await tx.query(
        `SELECT sb.branch_id, sb.product_id, p.sku, p.name, p.base_unit, sb.quantity, sb.damaged_qty
         FROM stock_balance sb JOIN product p ON p.shop_id=sb.shop_id AND p.id=sb.product_id
         WHERE sb.shop_id=$1 AND ($2::uuid IS NULL OR sb.branch_id=$2) AND ($3::uuid IS NULL OR sb.product_id=$3)
         ORDER BY p.name LIMIT $4 OFFSET $5`,
        [shopId, f.branchId ?? null, f.productId ?? null, Math.min(f.limit ?? 200, 1000), f.offset ?? 0],
      )
    ).rows;
  }

  async movements(tx: Tx, shopId: string, f: { branchId?: string; productId?: string; limit?: number; beforeId?: number }) {
    return (
      await tx.query(
        `SELECT id, branch_id, product_id, batch_id, type, qty_base, unit, qty_unit, factor, ref_type, ref_id, reason, created_by, created_at
         FROM stock_movement WHERE shop_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) AND ($3::uuid IS NULL OR product_id=$3) AND ($4::bigint IS NULL OR id < $4)
         ORDER BY id DESC LIMIT $5`,
        [shopId, f.branchId ?? null, f.productId ?? null, f.beforeId ?? null, Math.min(f.limit ?? 100, 500)],
      )
    ).rows;
  }
}
