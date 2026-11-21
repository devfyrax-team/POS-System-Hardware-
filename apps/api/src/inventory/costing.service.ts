import { Injectable } from '@nestjs/common';
import { D, Decimal, roundCost } from '@pos/money';
import { Tx } from '../db/db';

export type CostMethod = 'fifo' | 'average';

export interface ConsumePart {
  layerId: number | null; // null = no layer left: costed at the last known cost
  qty: string;
  unitCost: string;
}

export interface ConsumeResult {
  cogs: string; // total cost of goods, 4 dp
  unitCost: string; // cogs / qty
  parts: ConsumePart[];
  estimated: boolean; // some or all of the cost was a fallback
}

/**
 * Cost layers: every receipt creates one (quantity, remaining, unit cost). Both FIFO and weighted average
 * read the same layers, so the choice only changes reported cost, never cash. The cost of goods sold is
 * stored permanently on the sale line, so later method or price changes never rewrite history.
 */
@Injectable()
export class CostingService {
  async method(tx: Tx, shopId: string): Promise<CostMethod> {
    const r = (await tx.query(`SELECT settings->>'costing_method' AS m FROM shop WHERE id=$1`, [shopId])).rows[0];
    return r?.m === 'average' ? 'average' : 'fifo';
  }

  /** Latest layer cost for the product at the branch, else anywhere in the shop, else the product's last purchase cost. */
  async lastKnownCost(tx: Tx, shopId: string, branchId: string, productId: string): Promise<Decimal | null> {
    const l = (
      await tx.query(
        `SELECT unit_cost FROM cost_layer WHERE shop_id=$1 AND product_id=$2 AND estimated=false
         ORDER BY (branch_id = $3) DESC, received_at DESC, id DESC LIMIT 1`,
        [shopId, productId, branchId],
      )
    ).rows[0];
    if (l) return D(l.unit_cost);
    const p = (await tx.query(`SELECT last_cost FROM product WHERE shop_id=$1 AND id=$2`, [shopId, productId])).rows[0];
    return p?.last_cost != null ? D(p.last_cost) : null;
  }

  /** Creates the layer for a receipt. With no cost given it uses the last known cost and marks the layer estimated. */
  async createLayer(
    tx: Tx,
    p: { shopId: string; branchId: string; productId: string; batchId?: string | null; qty: string; unitCost?: string | null; sourceType: string; sourceId?: string; supplierId?: string | null },
  ) {
    let cost: Decimal;
    let estimated = false;
    if (p.unitCost !== undefined && p.unitCost !== null) {
      cost = roundCost(p.unitCost);
    } else {
      const last = await this.lastKnownCost(tx, p.shopId, p.branchId, p.productId);
      cost = last ?? D(0);
      estimated = true;
    }
    const r = (
      await tx.query(
        `INSERT INTO cost_layer(shop_id, branch_id, product_id, batch_id, qty_in, qty_remaining, unit_cost, estimated, source_type, source_id, supplier_id)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [p.shopId, p.branchId, p.productId, p.batchId ?? null, p.qty, cost.toString(), estimated, p.sourceType, p.sourceId ?? null, p.supplierId ?? null],
      )
    ).rows[0];
    return { layerId: Number(r.id), unitCost: cost.toString(), estimated };
  }

  /**
   * Takes `qty` from open layers (oldest first, row-locked) and prices it.
   * FIFO: each unit carries the real cost of the layer it came from.
   * Average: one cost per item = value of open layers / open quantity at the moment of sale.
   * If layers run out (stock added without a cost) the remainder is costed at the last known cost and flagged.
   */
  async consume(
    tx: Tx,
    p: { shopId: string; branchId: string; productId: string; qty: string; method?: CostMethod; batchId?: string | null },
  ): Promise<ConsumeResult> {
    const method = p.method ?? (await this.method(tx, p.shopId));
    const layers = (
      await tx.query(
        `SELECT id, qty_remaining, unit_cost FROM cost_layer
         WHERE branch_id=$1 AND product_id=$2 AND qty_remaining > 0 AND ($3::uuid IS NULL OR batch_id = $3)
         ORDER BY received_at, id FOR UPDATE`,
        [p.branchId, p.productId, p.batchId ?? null],
      )
    ).rows;

    let avg: Decimal | null = null;
    if (method === 'average' && layers.length) {
      const value = layers.reduce((a, l) => a.plus(D(l.qty_remaining).times(l.unit_cost)), D(0));
      const qty = layers.reduce((a, l) => a.plus(l.qty_remaining), D(0));
      avg = roundCost(value.div(qty));
    }

    let need = D(p.qty);
    const parts: ConsumePart[] = [];
    for (const l of layers) {
      if (need.lte(0)) break;
      const take = Decimal.min(need, D(l.qty_remaining));
      await tx.query(`UPDATE cost_layer SET qty_remaining = qty_remaining - $2 WHERE id=$1`, [l.id, take.toString()]);
      parts.push({ layerId: Number(l.id), qty: take.toString(), unitCost: (avg ?? D(l.unit_cost)).toString() });
      need = need.minus(take);
    }
    let estimated = false;
    if (need.gt(0)) {
      const fallback = avg ?? (await this.lastKnownCost(tx, p.shopId, p.branchId, p.productId)) ?? D(0);
      parts.push({ layerId: null, qty: need.toString(), unitCost: fallback.toString() });
      estimated = true;
    }
    const cogs = parts.reduce((a, x) => a.plus(D(x.qty).times(x.unitCost)), D(0)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    return { cogs: cogs.toString(), unitCost: D(p.qty).isZero() ? '0' : roundCost(cogs.div(p.qty)).toString(), parts, estimated };
  }

  /** Stock value at cost for a branch (owner/manager reports). */
  async valuation(tx: Tx, shopId: string, branchId?: string) {
    return (
      await tx.query(
        `SELECT p.id AS product_id, p.sku, p.name, sum(l.qty_remaining) AS qty, sum(l.qty_remaining * l.unit_cost) AS value
         FROM cost_layer l JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id
         WHERE l.shop_id=$1 AND l.qty_remaining > 0 AND ($2::uuid IS NULL OR l.branch_id=$2)
         GROUP BY p.id, p.sku, p.name ORDER BY p.name`,
        [shopId, branchId ?? null],
      )
    ).rows;
  }
}
