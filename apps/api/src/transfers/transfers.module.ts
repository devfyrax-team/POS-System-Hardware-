import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { D, Decimal, roundCost } from '@pos/money';
import { SalesModule } from '../sales/sales.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ExpiryModule } from '../inventory/expiry.module';
import { CatalogModule } from '../catalog/catalog.module';
import { Db, Tx } from '../db/db';
import { E } from '../common/errors';
import { nextCounter } from '../common/counter';
import { CurrentTenant, TenantSession } from '../common/session';
import { parse, positiveDecimal, z } from '../common/validate';
import { AuditService } from '../audit/audit.service';
import { RequireFeature, RequirePermission } from '../auth/decorators';
import { BatchService } from '../inventory/batch.service';
import { NotificationService } from '../inventory/notification.service';
import { StockService } from '../inventory/stock.service';

/** The user must hold a role in the branch (shop-wide roles count). */
function assertBranchAccess(s: TenantSession, branchId: string, what: string) {
  if (!(s.allBranches || s.branchIds?.has(branchId))) throw E.forbidden(`You do not work at the ${what} branch`);
}

/**
 * Branch transfers: request -> approve -> dispatch (stock leaves the source and is IN TRANSIT) -> receive
 * (partial receiving allowed, discrepancies reported) -> history. Cost travels with the stock, so the
 * receiving branch inherits the cost; batch and expiry details are recreated at the destination.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly stock: StockService,
    private readonly batches: BatchService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async get(tx: Tx, shopId: string, id: string, lock = false) {
    const t = (await tx.query(`SELECT * FROM branch_transfer WHERE shop_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [shopId, id])).rows[0];
    if (!t) throw E.notFound('Transfer');
    return t;
  }

  async create(tx: Tx, s: TenantSession, i: { fromBranchId: string; toBranchId: string; lines: { productId: string; qty: string }[]; note?: string }) {
    if (i.fromBranchId === i.toBranchId) throw E.validation('Choose two different branches');
    if (!i.lines.length) throw E.validation('Add at least one item');
    const bs = (await tx.query(`SELECT id FROM branch WHERE shop_id=$1 AND status='active' AND id = ANY($2)`, [s.shopId, [i.fromBranchId, i.toBranchId]])).rows;
    if (bs.length !== 2) throw E.notFound('Branch');
    if (!(s.allBranches || s.branchIds?.has(i.fromBranchId) || s.branchIds?.has(i.toBranchId))) throw E.forbidden('You do not work at either branch');
    const number = `TR-${String(await nextCounter(tx, s.shopId, 'transfer')).padStart(6, '0')}`;
    const t = (
      await tx.query(`INSERT INTO branch_transfer(shop_id, from_branch_id, to_branch_id, number, note, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, number, status`, [
        s.shopId, i.fromBranchId, i.toBranchId, number, i.note ?? null, s.userId,
      ])
    ).rows[0];
    for (const l of i.lines) {
      if (!D(l.qty).gt(0)) throw E.validation('Quantities must be positive');
      const p = (await tx.query(`SELECT id FROM product WHERE shop_id=$1 AND id=$2 AND status='active'`, [s.shopId, l.productId])).rows[0];
      if (!p) throw E.notFound('Product');
      await tx.query(`INSERT INTO branch_transfer_line(shop_id, transfer_id, product_id, qty_requested) VALUES ($1,$2,$3,$4)`, [s.shopId, t.id, l.productId, l.qty]);
    }
    const approvers = await this.notifications.recipientsWithPermission(tx, s.shopId, i.fromBranchId, 'transfer.manage');
    await this.notifications.notify(tx, { shopId: s.shopId, userIds: approvers.filter((u) => u !== s.userId), branchId: i.fromBranchId, type: 'transfer.requested', title: `Transfer ${number} awaiting approval`, payload: { transferId: t.id } });
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'transfer.requested', entity: 'branch_transfer', entityId: t.id, new: { number } });
    return t;
  }

  /** The SENDING branch approves. */
  async approve(tx: Tx, s: TenantSession, id: string) {
    const t = await this.get(tx, s.shopId, id, true);
    assertBranchAccess(s, t.from_branch_id, 'sending');
    if (t.status !== 'requested') throw E.conflict(`Transfer is ${t.status}`);
    await tx.query(`UPDATE branch_transfer SET status='approved', approved_by=$3 WHERE shop_id=$1 AND id=$2`, [s.shopId, id, s.userId]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'transfer.approved', entity: 'branch_transfer', entityId: id });
    return { id, status: 'approved' as const };
  }

  async reject(tx: Tx, s: TenantSession, id: string) {
    const t = await this.get(tx, s.shopId, id, true);
    assertBranchAccess(s, t.from_branch_id, 'sending');
    if (!['requested', 'approved'].includes(t.status)) throw E.conflict(`Transfer is ${t.status}`);
    await tx.query(`UPDATE branch_transfer SET status='rejected' WHERE shop_id=$1 AND id=$2`, [s.shopId, id]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'transfer.rejected', entity: 'branch_transfer', entityId: id });
  }

  /**
   * Stock leaves the source (and is in transit: in neither branch's balance). Cost of what leaves is captured per line
   * so it can be inherited by the destination; batch details are carried too.
   */
  async dispatch(tx: Tx, s: TenantSession, id: string, adjust?: { lineId: string; qty: string }[]) {
    const t = await this.get(tx, s.shopId, id, true);
    assertBranchAccess(s, t.from_branch_id, 'sending');
    if (t.status !== 'approved') throw E.conflict(`Transfer is ${t.status}; it must be approved first`);
    const lines = (await tx.query(`SELECT id, product_id, qty_requested FROM branch_transfer_line WHERE shop_id=$1 AND transfer_id=$2 ORDER BY product_id`, [s.shopId, id])).rows;
    for (const l of lines) {
      const qty = D(adjust?.find((a) => a.lineId === l.id)?.qty ?? l.qty_requested);
      if (qty.gt(l.qty_requested)) throw E.validation('Cannot send more than was requested');
      if (qty.lte(0)) continue;
      const plan = await this.batches.plan(tx, s.shopId, t.from_branch_id, l.product_id, qty.toString());
      let cost = D(0);
      const batchInfo: any[] = [];
      for (const a of plan) {
        const r = await this.stock.apply(tx, {
          shopId: s.shopId, branchId: t.from_branch_id, productId: l.product_id, type: 'transfer_out', qtyBase: D(a.qtyBase).neg().toString(), batchId: a.batchId,
          refType: 'transfer', refId: id, reason: `to branch, ${t.number}`, userId: s.userId,
        });
        cost = cost.plus(r.cogs ?? '0');
        if (a.batchId) {
          const b = (await tx.query(`SELECT batch_no, mfg_date::text mfg, expiry_date::text expiry, supplier_id FROM stock_batch WHERE shop_id=$1 AND id=$2`, [s.shopId, a.batchId])).rows[0];
          batchInfo.push({ batchNo: b.batch_no, mfgDate: b.mfg, expiryDate: b.expiry, supplierId: b.supplier_id, qty: a.qtyBase });
        }
      }
      await tx.query(`UPDATE branch_transfer_line SET qty_dispatched=$3, unit_cost=$4, batches=$5 WHERE shop_id=$1 AND id=$2`, [s.shopId, l.id, qty.toString(), roundCost(cost.div(qty)).toString(), batchInfo.length ? JSON.stringify(batchInfo) : null]);
    }
    if ((await tx.query(`SELECT 1 FROM branch_transfer_line WHERE shop_id=$1 AND transfer_id=$2 AND qty_dispatched > 0 LIMIT 1`, [s.shopId, id])).rowCount === 0) throw E.validation('Nothing to send');
    await tx.query(`UPDATE branch_transfer SET status='in_transit', dispatched_by=$3, dispatched_at=now() WHERE shop_id=$1 AND id=$2`, [s.shopId, id, s.userId]);
    const receivers = await this.notifications.recipientsWithPermission(tx, s.shopId, t.to_branch_id, 'transfer.manage');
    await this.notifications.notify(tx, { shopId: s.shopId, userIds: receivers, branchId: t.to_branch_id, type: 'transfer.dispatched', title: `Transfer ${t.number} is on its way`, payload: { transferId: id } });
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'transfer.dispatched', entity: 'branch_transfer', entityId: id });
    return { id, status: 'in_transit' as const };
  }

  /** The RECEIVING branch counts what arrived. Partial receipts are fine; the rest is reported at close. */
  async receive(tx: Tx, s: TenantSession, id: string, received: { lineId: string; qty: string }[]) {
    const t = await this.get(tx, s.shopId, id, true);
    assertBranchAccess(s, t.to_branch_id, 'receiving');
    if (t.status !== 'in_transit') throw E.conflict(`Transfer is ${t.status}`);
    for (const r of received) {
      const l = (await tx.query(`SELECT * FROM branch_transfer_line WHERE shop_id=$1 AND transfer_id=$2 AND id=$3 FOR UPDATE`, [s.shopId, id, r.lineId])).rows[0];
      if (!l) throw E.notFound('Transfer line');
      const qty = D(r.qty);
      if (!qty.gt(0)) continue;
      const left = D(l.qty_dispatched).minus(l.qty_received);
      if (qty.gt(left)) throw E.validation(`Only ${left.toString()} still expected for this item`, { lineId: r.lineId, expected: left.toString() });

      const batches: any[] = l.batches ?? [];
      let remaining = qty;
      let alreadyTaken = D(l.qty_received);
      const parts: { batchId: string | null; qty: Decimal }[] = [];
      if (batches.length) {
        // first-fit over the dispatched batches, skipping what earlier receipts already used
        for (const b of batches) {
          const free = D(b.qty).minus(Decimal.min(alreadyTaken, D(b.qty)));
          alreadyTaken = Decimal.max(alreadyTaken.minus(b.qty), D(0));
          if (remaining.lte(0) || free.lte(0)) continue;
          const take = Decimal.min(free, remaining);
          const existing = (await tx.query(`SELECT id FROM stock_batch WHERE shop_id=$1 AND branch_id=$2 AND product_id=$3 AND batch_no IS NOT DISTINCT FROM $4 AND expiry_date IS NOT DISTINCT FROM $5::date`, [s.shopId, t.to_branch_id, l.product_id, b.batchNo, b.expiryDate])).rows[0];
          const batchId =
            existing?.id ??
            (
              await tx.query(
                `INSERT INTO stock_batch(shop_id, branch_id, product_id, batch_no, mfg_date, expiry_date, qty_received, qty_remaining, unit_cost, supplier_id) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9) RETURNING id`,
                [s.shopId, t.to_branch_id, l.product_id, b.batchNo, b.mfgDate, b.expiryDate, b.qty, l.unit_cost, b.supplierId],
              )
            ).rows[0].id;
          parts.push({ batchId, qty: take });
          remaining = remaining.minus(take);
        }
      } else parts.push({ batchId: null, qty });
      for (const p of parts) {
        await this.stock.apply(tx, {
          shopId: s.shopId, branchId: t.to_branch_id, productId: l.product_id, type: 'transfer_in', qtyBase: p.qty.toString(), batchId: p.batchId,
          unitCost: l.unit_cost ?? '0', refType: 'transfer', refId: id, reason: `from branch, ${t.number}`, userId: s.userId,
        });
      }
      await tx.query(`UPDATE branch_transfer_line SET qty_received = qty_received + $3 WHERE shop_id=$1 AND id=$2`, [s.shopId, r.lineId, qty.toString()]);
    }
    const open = (await tx.query(`SELECT count(*)::int c FROM branch_transfer_line WHERE shop_id=$1 AND transfer_id=$2 AND qty_received < qty_dispatched`, [s.shopId, id])).rows[0].c;
    if (!open) {
      await tx.query(`UPDATE branch_transfer SET status='received', received_at=now() WHERE shop_id=$1 AND id=$2`, [s.shopId, id]);
      await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'transfer.received', entity: 'branch_transfer', entityId: id });
      return { id, status: 'received' as const, discrepancies: [] };
    }
    return { id, status: 'in_transit' as const, discrepancies: [] };
  }

  /** Close a partly received transfer: the shortfall is recorded as a discrepancy (value at the cost that travelled). */
  async close(tx: Tx, s: TenantSession, id: string) {
    const t = await this.get(tx, s.shopId, id, true);
    assertBranchAccess(s, t.to_branch_id, 'receiving');
    if (t.status !== 'in_transit') throw E.conflict(`Transfer is ${t.status}`);
    const short = (await tx.query(`SELECT product_id, qty_dispatched - qty_received AS missing, unit_cost FROM branch_transfer_line WHERE shop_id=$1 AND transfer_id=$2 AND qty_received < qty_dispatched`, [s.shopId, id])).rows;
    const out: any[] = [];
    for (const m of short) {
      const value = D(m.missing).times(m.unit_cost ?? 0).toDecimalPlaces(2);
      await tx.query(`INSERT INTO transfer_discrepancy(shop_id, transfer_id, product_id, qty_missing, value, note) VALUES ($1,$2,$3,$4,$5,$6)`, [s.shopId, id, m.product_id, m.missing, value.toString(), 'not received']);
      out.push({ productId: m.product_id, missing: D(m.missing).toString(), value: value.toString() });
    }
    await tx.query(`UPDATE branch_transfer SET status='closed', received_at=now() WHERE shop_id=$1 AND id=$2`, [s.shopId, id]);
    if (out.length) {
      const owners = await this.notifications.recipientsWithPermission(tx, s.shopId, null, 'stock.adjust');
      await this.notifications.notify(tx, { shopId: s.shopId, userIds: owners, type: 'transfer.discrepancy', title: `Transfer ${t.number}: ${out.length} item(s) did not arrive`, payload: { transferId: id, items: out } });
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'transfer.closed', entity: 'branch_transfer', entityId: id, new: { discrepancies: out.length } });
    return { id, status: 'closed' as const, discrepancies: out };
  }

  async view(tx: Tx, shopId: string, id: string) {
    const t = await this.get(tx, shopId, id);
    const lines = (
      await tx.query(
        `SELECT l.id, l.product_id, p.name, l.qty_requested, l.qty_dispatched, l.qty_received FROM branch_transfer_line l JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id WHERE l.shop_id=$1 AND l.transfer_id=$2 ORDER BY p.name`,
        [shopId, id],
      )
    ).rows;
    return { ...t, lines };
  }

  async list(tx: Tx, shopId: string, f: { status?: string; branchId?: string }) {
    return (
      await tx.query(
        `SELECT id, number, status, from_branch_id, to_branch_id, created_at FROM branch_transfer
         WHERE shop_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::uuid IS NULL OR from_branch_id=$3 OR to_branch_id=$3) ORDER BY created_at DESC LIMIT 100`,
        [shopId, f.status ?? null, f.branchId ?? null],
      )
    ).rows;
  }
}

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });

@RequireFeature('branch_transfers')
@RequirePermission('transfer.manage')
@Controller('transfers')
export class TransferController {
  constructor(private readonly db: Db, private readonly transfers: TransferService) {}

  @Post()
  create(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ fromBranchId: z.string().uuid(), toBranchId: z.string().uuid(), note: z.string().optional(), lines: z.array(z.object({ productId: z.string().uuid(), qty: positiveDecimal })).min(1) }), body);
    return this.db.tenant(ctx(s), (tx) => this.transfers.create(tx, s, b));
  }

  @Get()
  list(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) => this.transfers.list(tx, s.shopId, { status: q.status, branchId: q.branchId }));
  }

  @Get(':id')
  get(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.transfers.view(tx, s.shopId, id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.transfers.approve(tx, s, id));
  }

  @Post(':id/reject')
  @HttpCode(204)
  async reject(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.transfers.reject(tx, s, id));
  }

  @Post(':id/dispatch')
  @HttpCode(200)
  dispatch(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ lines: z.array(z.object({ lineId: z.string().uuid(), qty: positiveDecimal })).optional() }), body ?? {});
    return this.db.tenant(ctx(s), (tx) => this.transfers.dispatch(tx, s, id, b.lines));
  }

  @Post(':id/receive')
  @HttpCode(200)
  receive(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ lines: z.array(z.object({ lineId: z.string().uuid(), qty: positiveDecimal })).min(1) }), body);
    return this.db.tenant(ctx(s), (tx) => this.transfers.receive(tx, s, id, b.lines));
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.transfers.close(tx, s, id));
  }
}

@Module({
  imports: [SalesModule, InventoryModule, ExpiryModule, CatalogModule],
  controllers: [TransferController],
  providers: [TransferService],
  exports: [TransferService],
})
export class TransfersModule {}
