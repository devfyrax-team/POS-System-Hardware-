import { Injectable } from '@nestjs/common';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { StockService } from './stock.service';

/**
 * A count session per category or shelf. It records each item's system quantity when the count opens and
 * adds the sales/receipts made DURING the count, so nothing is counted twice. Differences post as adjustments
 * with an authorized user.
 */
@Injectable()
export class StocktakeService {
  constructor(private readonly stock: StockService, private readonly audit: AuditService) {}

  async open(tx: Tx, s: TenantSession, input: { branchId: string; scope?: string; category?: string; productIds?: string[] }) {
    const snap = (await tx.query(`SELECT coalesce(max(id),0) AS m FROM stock_movement WHERE shop_id=$1 AND branch_id=$2`, [s.shopId, input.branchId])).rows[0].m;
    const st = (
      await tx.query(
        `INSERT INTO stocktake(shop_id, branch_id, scope, snapshot_movement_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [s.shopId, input.branchId, input.scope ?? input.category ?? 'all', snap, s.userId],
      )
    ).rows[0];
    const added = await tx.query(
      `INSERT INTO stocktake_line(stocktake_id, shop_id, product_id, system_qty)
       SELECT $1, p.shop_id, p.id, coalesce(sb.quantity,0) FROM product p
       LEFT JOIN stock_balance sb ON sb.branch_id=$3 AND sb.product_id=p.id
       WHERE p.shop_id=$2 AND p.status='active' AND ($4::text IS NULL OR p.category=$4) AND ($5::uuid[] IS NULL OR p.id = ANY($5))`,
      [st.id, s.shopId, input.branchId, input.category ?? null, input.productIds ?? null],
    );
    if (!added.rowCount) throw E.validation('No products in this count scope');
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'stocktake.opened', entity: 'stocktake', entityId: st.id, new: { scope: input.scope ?? input.category ?? 'all', lines: added.rowCount } });
    return { id: st.id as string, lines: added.rowCount };
  }

  /** `mode: add` accumulates scans (several shelves of one item); `set` overwrites. */
  async recordCount(tx: Tx, s: TenantSession, stocktakeId: string, productId: string, qty: string, mode: 'set' | 'add' = 'set') {
    if (D(qty).isNegative()) throw E.validation('Counted quantity cannot be negative');
    const st = (await tx.query(`SELECT status FROM stocktake WHERE shop_id=$1 AND id=$2`, [s.shopId, stocktakeId])).rows[0];
    if (!st) throw E.notFound('Stocktake');
    if (st.status !== 'open') throw E.conflict('Stocktake is closed');
    const r = await tx.query(
      `UPDATE stocktake_line SET counted_qty = CASE WHEN $4 = 'add' THEN coalesce(counted_qty,0) + $3 ELSE $3 END
       WHERE stocktake_id=$1 AND shop_id=$5 AND product_id=$2 RETURNING counted_qty`,
      [stocktakeId, productId, qty, mode, s.shopId],
    );
    if (!r.rowCount) throw E.notFound('Product is not part of this count');
    return { countedQty: String(r.rows[0].counted_qty) };
  }

  /** Expected = system quantity at open + all movements since then (except earlier count corrections). */
  async review(tx: Tx, s: TenantSession, stocktakeId: string) {
    const st = (await tx.query(`SELECT * FROM stocktake WHERE shop_id=$1 AND id=$2`, [s.shopId, stocktakeId])).rows[0];
    if (!st) throw E.notFound('Stocktake');
    const rows = (
      await tx.query(
        `SELECT l.product_id, p.sku, p.name, l.system_qty, l.counted_qty,
                coalesce((SELECT sum(m.qty_base) FROM stock_movement m
                          WHERE m.branch_id=$2 AND m.product_id=l.product_id AND m.id > $3 AND m.type <> 'stocktake'),0) AS since
         FROM stocktake_line l JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id
         WHERE l.stocktake_id=$1 ORDER BY p.name`,
        [stocktakeId, st.branch_id, st.snapshot_movement_id],
      )
    ).rows;
    return rows.map((r) => {
      const expected = D(r.system_qty).plus(r.since);
      const counted = r.counted_qty === null ? null : D(r.counted_qty);
      return {
        productId: r.product_id, sku: r.sku, name: r.name, systemQtyAtOpen: String(r.system_qty), movedSinceOpen: String(r.since),
        expected: expected.toString(), counted: counted?.toString() ?? null, variance: counted ? counted.minus(expected).toString() : null,
      };
    });
  }

  /** Posts variances for counted lines. Requires stock.adjust (checked by the controller). */
  async post(tx: Tx, s: TenantSession, stocktakeId: string, opts: { zeroUncounted?: boolean } = {}) {
    const st = (await tx.query(`SELECT * FROM stocktake WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, stocktakeId])).rows[0];
    if (!st) throw E.notFound('Stocktake');
    if (st.status !== 'open') throw E.conflict('Stocktake is already closed');
    const lines = await this.review(tx, s, stocktakeId);
    let posted = 0;
    for (const l of lines) {
      const counted = l.counted ?? (opts.zeroUncounted ? '0' : null);
      if (counted === null) continue;
      const variance = D(counted).minus(l.expected);
      if (variance.isZero()) continue;
      await this.stock.apply(tx, {
        shopId: s.shopId, branchId: st.branch_id, productId: l.productId, type: 'stocktake', qtyBase: variance.toString(),
        refType: 'stocktake', refId: stocktakeId, reason: `stocktake ${st.scope}`, userId: s.userId,
      });
      posted++;
    }
    await tx.query(`UPDATE stocktake SET status='posted', approved_by=$3, posted_at=now() WHERE shop_id=$1 AND id=$2`, [s.shopId, stocktakeId, s.userId]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'stocktake.posted', entity: 'stocktake', entityId: stocktakeId, new: { adjustments: posted } });
    return { posted };
  }

  async cancel(tx: Tx, s: TenantSession, stocktakeId: string) {
    const r = await tx.query(`UPDATE stocktake SET status='cancelled' WHERE shop_id=$1 AND id=$2 AND status='open' RETURNING id`, [s.shopId, stocktakeId]);
    if (!r.rowCount) throw E.notFound('Open stocktake');
  }
}
