import { Injectable } from '@nestjs/common';
import { D, Decimal } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { CheckoutHooks } from '../sales/checkout.hooks';

export interface Allocation {
  batchId: string | null; // null = stock that was never batched (legacy / opening without batch)
  qtyBase: string;
  batchNo?: string | null;
  expiry?: string | null;
  expired?: boolean;
}

/**
 * Batch picking for batch-tracked items (paint, adhesives, sealants, cement).
 * Default: earliest expiry first. The cashier may choose a batch, which matters for paint because one job
 * should use tins from the same batch so the colour matches. Expired stock follows the shop policy.
 */
@Injectable()
export class BatchService {
  constructor(hooks: CheckoutHooks) {
    hooks.allocateBatch = (tx, s, c) => this.allocate(tx, s, c);
  }

  async policy(tx: Tx, shopId: string): Promise<'block' | 'warn' | 'allow'> {
    const r = (await tx.query(`SELECT settings->>'expired_stock_policy' p FROM shop WHERE id=$1`, [shopId])).rows[0];
    return (['block', 'warn', 'allow'].includes(r?.p) ? r.p : 'warn') as 'block' | 'warn' | 'allow';
  }

  /**
   * Returns how to take `qtyBase` from batches. Batch rows are locked (earliest expiry first) so two tills
   * never pick the same remaining units. A single batch is preferred whenever one covers the whole line.
   */
  async plan(tx: Tx, shopId: string, branchId: string, productId: string, qtyBase: string, preferredBatchId?: string): Promise<Allocation[]> {
    const prod = (await tx.query(`SELECT track_batches FROM product WHERE shop_id=$1 AND id=$2`, [shopId, productId])).rows[0];
    if (!prod?.track_batches) return [{ batchId: null, qtyBase }];
    const policy = await this.policy(tx, shopId);
    const batches = (
      await tx.query(
        `SELECT id, batch_no, expiry_date::text AS expiry, qty_remaining, (expiry_date IS NOT NULL AND expiry_date < current_date) AS expired
         FROM stock_batch WHERE shop_id=$1 AND branch_id=$2 AND product_id=$3 AND qty_remaining > 0
         ORDER BY expiry_date NULLS LAST, created_at, id FOR UPDATE`,
        [shopId, branchId, productId],
      )
    ).rows;

    const usable = batches.filter((b) => !(b.expired && policy === 'block'));
    // 'warn' keeps expired batches but sells good ones first
    const ordered = policy === 'warn' ? [...usable.filter((b) => !b.expired), ...usable.filter((b) => b.expired)] : usable;

    if (preferredBatchId) {
      const b = batches.find((x) => x.id === preferredBatchId);
      if (!b) throw E.validation('The chosen batch has no stock at this branch');
      if (b.expired && policy === 'block') throw E.validation(`Batch ${b.batch_no ?? ''} is expired and expired stock is blocked for sale`);
      if (D(b.qty_remaining).lt(qtyBase)) throw E.stockShort({ productId, batchId: b.id, requested: qtyBase, available: D(b.qty_remaining).toString() });
      return [{ batchId: b.id, qtyBase, batchNo: b.batch_no, expiry: b.expiry, expired: b.expired }];
    }

    const need = D(qtyBase);
    const single = ordered.find((b) => D(b.qty_remaining).gte(need));
    if (single) return [{ batchId: single.id, qtyBase, batchNo: single.batch_no, expiry: single.expiry, expired: single.expired }];

    const out: Allocation[] = [];
    let left = need;
    for (const b of ordered) {
      if (left.lte(0)) break;
      const take = Decimal.min(left, D(b.qty_remaining));
      out.push({ batchId: b.id, qtyBase: take.toString(), batchNo: b.batch_no, expiry: b.expiry, expired: b.expired });
      left = left.minus(take);
    }
    if (left.gt(0)) {
      // whatever is left must come from stock that was never batched; StockService refuses if it is not there
      if (policy === 'block' && batches.some((b) => b.expired)) {
        const have = D(await this.unbatched(tx, branchId, productId));
        if (have.lt(left)) throw E.stockShort({ productId, requested: qtyBase, available: need.minus(left).plus(have).toString(), reason: 'expired stock is blocked' });
      }
      out.push({ batchId: null, qtyBase: left.toString() });
    }
    return out;
  }

  private async unbatched(tx: Tx, branchId: string, productId: string): Promise<string> {
    const r = (
      await tx.query(
        `SELECT coalesce((SELECT quantity FROM stock_balance WHERE branch_id=$1 AND product_id=$2),0)
              - coalesce((SELECT sum(qty_remaining) FROM stock_batch WHERE branch_id=$1 AND product_id=$2),0) AS q`,
        [branchId, productId],
      )
    ).rows[0];
    return D(r.q).toString();
  }

  /** Checkout hook: one allocation entry per batch used. */
  async allocate(tx: Tx, s: TenantSession, c: { productId: string; qtyBase: string; preferredBatchId?: string }) {
    const plan = await this.plan(tx, s.shopId, s.branchId!, c.productId, c.qtyBase, c.preferredBatchId);
    return { batchId: plan[0].batchId, allocations: plan };
  }

  async list(tx: Tx, shopId: string, f: { branchId?: string; productId?: string; includeEmpty?: boolean }) {
    return (
      await tx.query(
        `SELECT b.id, b.branch_id, b.product_id, p.name, b.batch_no, b.mfg_date, b.expiry_date, b.qty_received, b.qty_remaining,
                (b.expiry_date - current_date) AS days_left, (b.expiry_date IS NOT NULL AND b.expiry_date < current_date) AS expired
         FROM stock_batch b JOIN product p ON p.shop_id=b.shop_id AND p.id=b.product_id
         WHERE b.shop_id=$1 AND ($2::uuid IS NULL OR b.branch_id=$2) AND ($3::uuid IS NULL OR b.product_id=$3) AND ($4 OR b.qty_remaining > 0)
         ORDER BY b.expiry_date NULLS LAST, b.created_at LIMIT 500`,
        [shopId, f.branchId ?? null, f.productId ?? null, f.includeEmpty ?? false],
      )
    ).rows;
  }
}
