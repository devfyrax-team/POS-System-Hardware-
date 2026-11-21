import { Injectable } from '@nestjs/common';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from './notification.service';
import { StockService } from './stock.service';

export interface AdjustmentLineInput {
  productId: string;
  kind?: 'adjustment' | 'damaged' | 'expired';
  qtyDelta: string; // base units, signed. damaged/expired must be negative
  unitCost?: string;
}

/**
 * Stock adjustments always need a reason and an authorized user. A storekeeper REQUESTS; a manager/owner
 * (stock.adjust) approves and the ledger entry is posted. Someone who already holds stock.adjust posts directly.
 */
@Injectable()
export class AdjustmentService {
  constructor(
    private readonly stock: StockService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  async request(tx: Tx, s: TenantSession, input: { branchId: string; reason: string; lines: AdjustmentLineInput[] }) {
    if (!input.reason.trim()) throw E.validation('A reason is required');
    if (!input.lines.length) throw E.validation('Add at least one line');
    for (const l of input.lines) {
      if (D(l.qtyDelta).isZero()) throw E.validation('Quantity cannot be zero');
      if ((l.kind === 'damaged' || l.kind === 'expired') && D(l.qtyDelta).gt(0)) throw E.validation(`${l.kind} stock must be a negative quantity`);
    }
    const br = (await tx.query(`SELECT id FROM branch WHERE shop_id=$1 AND id=$2 AND status='active'`, [s.shopId, input.branchId])).rows[0];
    if (!br) throw E.notFound('Branch');
    const adj = (
      await tx.query(
        `INSERT INTO stock_adjustment(shop_id, branch_id, reason, requested_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [s.shopId, input.branchId, input.reason, s.userId],
      )
    ).rows[0];
    for (const l of input.lines) {
      await tx.query(
        `INSERT INTO stock_adjustment_line(shop_id, adjustment_id, product_id, kind, qty_delta, unit_cost) VALUES ($1,$2,$3,$4,$5,$6)`,
        [s.shopId, adj.id, l.productId, l.kind ?? 'adjustment', l.qtyDelta, l.unitCost ?? null],
      );
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'adjustment.requested', entity: 'stock_adjustment', entityId: adj.id, new: input });

    if (s.permissions?.has('stock.adjust')) return this.post(tx, s, adj.id);

    const approvers = await this.notifications.recipientsWithPermission(tx, s.shopId, input.branchId, 'stock.adjust');
    await this.notifications.notify(tx, {
      shopId: s.shopId, userIds: approvers, branchId: input.branchId, type: 'adjustment.requested',
      title: 'Stock adjustment awaiting approval', body: input.reason, payload: { adjustmentId: adj.id },
    });
    return { id: adj.id as string, status: 'requested' as const };
  }

  /** Approve and post: one ledger entry per line, inside this transaction. */
  async approve(tx: Tx, s: TenantSession, id: string) {
    return this.post(tx, s, id);
  }

  private async post(tx: Tx, s: TenantSession, id: string) {
    const adj = (await tx.query(`SELECT * FROM stock_adjustment WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, id])).rows[0];
    if (!adj) throw E.notFound('Adjustment');
    if (adj.status !== 'requested') throw E.conflict(`Adjustment is already ${adj.status}`);
    const lines = (await tx.query(`SELECT * FROM stock_adjustment_line WHERE shop_id=$1 AND adjustment_id=$2 ORDER BY product_id`, [s.shopId, id])).rows;
    for (const l of lines) {
      await this.stock.apply(tx, {
        shopId: s.shopId, branchId: adj.branch_id, productId: l.product_id, type: l.kind, qtyBase: l.qty_delta,
        unitCost: l.unit_cost, refType: 'adjustment', refId: id, reason: adj.reason, userId: s.userId,
      });
    }
    await tx.query(`UPDATE stock_adjustment SET status='posted', decided_by=$3, decided_at=now() WHERE shop_id=$1 AND id=$2`, [s.shopId, id, s.userId]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'adjustment.posted', entity: 'stock_adjustment', entityId: id, new: { lines: lines.length } });
    return { id: id as string, status: 'posted' as const };
  }

  async reject(tx: Tx, s: TenantSession, id: string, note?: string) {
    const r = await tx.query(`UPDATE stock_adjustment SET status='rejected', decided_by=$3, decided_at=now() WHERE shop_id=$1 AND id=$2 AND status='requested' RETURNING id, requested_by`, [s.shopId, id, s.userId]);
    if (!r.rowCount) throw E.notFound('Pending adjustment');
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'adjustment.rejected', entity: 'stock_adjustment', entityId: id, new: { note } });
    await this.notifications.notify(tx, { shopId: s.shopId, userIds: [r.rows[0].requested_by], type: 'adjustment.rejected', title: 'Stock adjustment rejected', body: note });
  }

  async list(tx: Tx, shopId: string, status?: string) {
    return (
      await tx.query(
        `SELECT a.id, a.branch_id, a.status, a.reason, a.requested_by, a.decided_by, a.created_at,
                (SELECT json_agg(json_build_object('productId', l.product_id, 'kind', l.kind, 'qtyDelta', l.qty_delta)) FROM stock_adjustment_line l WHERE l.adjustment_id = a.id) AS lines
         FROM stock_adjustment a WHERE a.shop_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY a.created_at DESC LIMIT 100`,
        [shopId, status ?? null],
      )
    ).rows;
  }

  /** Opening stock is posted separately from product creation (a count, with an optional cost). */
  async postOpening(tx: Tx, s: TenantSession, input: { branchId: string; lines: { productId: string; qtyBase: string; unitCost?: string }[] }) {
    for (const l of input.lines) {
      if (!D(l.qtyBase).gt(0)) throw E.validation('Opening quantity must be positive');
      await this.stock.apply(tx, { shopId: s.shopId, branchId: input.branchId, productId: l.productId, type: 'opening', qtyBase: l.qtyBase, unitCost: l.unitCost, userId: s.userId, reason: 'opening stock' });
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'stock.opening_posted', entity: 'branch', entityId: input.branchId, new: { lines: input.lines.length } });
    return { posted: input.lines.length };
  }
}
