import { Body, Controller, Get, HttpCode, Injectable, Module, OnModuleInit, Post, Query } from '@nestjs/common';
import { D } from '@pos/money';
import { SalesModule } from '../sales/sales.module';
import { InventoryModule } from './inventory.module';
import { CatalogModule } from '../catalog/catalog.module';
import { Db, Tx } from '../db/db';
import { E } from '../common/errors';
import { CurrentTenant, TenantSession } from '../common/session';
import { parse, z } from '../common/validate';
import { AuditService } from '../audit/audit.service';
import { RequireAnyPermission, RequireFeature, RequirePermission } from '../auth/decorators';
import { FeatureService } from '../platform/feature.service';
import { JobQueue } from '../jobs/job-queue';
import { OutboxService } from '../jobs/outbox.service';
import { BatchService } from './batch.service';
import { NotificationService } from './notification.service';
import { StockService } from './stock.service';

const DEFAULT_WINDOWS = [180, 90, 30];

@Injectable()
export class ExpiryService {
  constructor(
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly features: FeatureService,
  ) {}

  /** Warning windows (days) are configurable per category, with a shop-wide default (six months ahead for paint). */
  windowsFor(settings: any, category?: string | null): number[] {
    const byCat = settings?.expiry_windows_by_category?.[category ?? ''];
    const w: number[] = Array.isArray(byCat) ? byCat : Array.isArray(settings?.expiry_windows_days) ? settings.expiry_windows_days : DEFAULT_WINDOWS;
    return [...new Set(w)].sort((a, b) => a - b);
  }

  /** The band is the tightest window the batch has fallen into (0 = already expired); null = not near expiry. */
  bandFor(daysLeft: number, windows: number[]): number | null {
    if (daysLeft < 0) return 0;
    return windows.find((w) => daysLeft <= w) ?? null;
  }

  /** Daily job: alert once per batch each time it enters a more urgent window. */
  async scan(tx: Tx, shopId: string): Promise<number> {
    if (!(await this.features.has(tx, shopId, 'batch_expiry'))) return 0;
    const settings = (await tx.query(`SELECT settings FROM shop WHERE id=$1`, [shopId])).rows[0].settings;
    const rows = (
      await tx.query(
        `SELECT b.id, b.branch_id, b.product_id, p.name, p.category, b.batch_no, b.qty_remaining, b.unit_cost, (b.expiry_date - current_date) AS days_left, s.band
         FROM stock_batch b JOIN product p ON p.shop_id=b.shop_id AND p.id=b.product_id LEFT JOIN expiry_alert_state s ON s.batch_id=b.id
         WHERE b.shop_id=$1 AND b.qty_remaining > 0 AND b.expiry_date IS NOT NULL`,
        [shopId],
      )
    ).rows;
    let alerts = 0;
    for (const r of rows) {
      const band = this.bandFor(Number(r.days_left), this.windowsFor(settings, r.category));
      if (band === null) continue;
      if (r.band !== null && band >= r.band) continue; // already alerted at this or a tighter band
      await tx.query(
        `INSERT INTO expiry_alert_state(shop_id, batch_id, band) VALUES ($1,$2,$3) ON CONFLICT (batch_id) DO UPDATE SET band=EXCLUDED.band, updated_at=now()`,
        [shopId, r.id, band],
      );
      await this.outbox.publish(tx, shopId, 'stock.expiry', {
        batchId: r.id, branchId: r.branch_id, productId: r.product_id, name: r.name, batchNo: r.batch_no, band, daysLeft: Number(r.days_left),
        qty: D(r.qty_remaining).toString(), value: D(r.qty_remaining).times(r.unit_cost ?? 0).toDecimalPlaces(2).toString(),
      });
      alerts++;
    }
    return alerts;
  }

  /** Near-expiry stock at cost, by branch and supplier, with next steps. */
  async nearExpiry(tx: Tx, shopId: string, f: { branchId?: string; withinDays?: number; expired?: boolean }) {
    const multi = await this.features.has(tx, shopId, 'branch_transfers');
    const rows = (
      await tx.query(
        `SELECT b.id AS batch_id, b.branch_id, br.name AS branch, b.product_id, p.name, b.batch_no, b.expiry_date, (b.expiry_date - current_date) AS days_left,
                b.qty_remaining, b.unit_cost, b.supplier_id, s.name AS supplier, s.return_terms
         FROM stock_batch b JOIN product p ON p.shop_id=b.shop_id AND p.id=b.product_id JOIN branch br ON br.shop_id=b.shop_id AND br.id=b.branch_id
         LEFT JOIN supplier s ON s.shop_id=b.shop_id AND s.id=b.supplier_id
         WHERE b.shop_id=$1 AND b.qty_remaining > 0 AND b.expiry_date IS NOT NULL AND ($2::uuid IS NULL OR b.branch_id=$2)
           AND (($3::boolean IS TRUE AND b.expiry_date < current_date) OR ($3::boolean IS NOT TRUE AND b.expiry_date <= current_date + $4::int))
         ORDER BY b.expiry_date, p.name LIMIT 500`,
        [shopId, f.branchId ?? null, f.expired ?? false, f.withinDays ?? 180],
      )
    ).rows;
    const items = rows.map((r) => {
      const value = D(r.qty_remaining).times(r.unit_cost ?? 0).toDecimalPlaces(2);
      const actions = Number(r.days_left) < 0 ? ['write_off'] : ['mark_down'];
      if (Number(r.days_left) >= 0 && r.supplier_id && r.return_terms) actions.push('return_to_supplier');
      if (Number(r.days_left) >= 0 && multi) actions.push('transfer_to_faster_branch');
      return { batchId: r.batch_id, branchId: r.branch_id, branch: r.branch, productId: r.product_id, name: r.name, batchNo: r.batch_no, expiryDate: r.expiry_date, daysLeft: Number(r.days_left), qty: D(r.qty_remaining).toString(), value: value.toString(), supplierId: r.supplier_id, supplier: r.supplier, returnTerms: r.return_terms, actions };
    });
    const byBranch = new Map<string, { branch: string; value: ReturnType<typeof D> }>();
    const bySupplier = new Map<string, { supplier: string; value: ReturnType<typeof D> }>();
    for (const i of items) {
      const b = byBranch.get(i.branchId) ?? { branch: i.branch, value: D(0) };
      byBranch.set(i.branchId, { ...b, value: b.value.plus(i.value) });
      const k = i.supplierId ?? 'none';
      const s = bySupplier.get(k) ?? { supplier: i.supplier ?? '(unknown)', value: D(0) };
      bySupplier.set(k, { ...s, value: s.value.plus(i.value) });
    }
    return {
      items,
      totalValue: items.reduce((a, i) => a.plus(i.value), D(0)).toString(),
      byBranch: [...byBranch.entries()].map(([id, v]) => ({ branchId: id, branch: v.branch, value: v.value.toString() })),
      bySupplier: [...bySupplier.entries()].map(([id, v]) => ({ supplierId: id === 'none' ? null : id, supplier: v.supplier, value: v.value.toString() })),
    };
  }

  /** Expired stock is written off through the ledger (type "expired"), by an authorized user. */
  async writeOff(tx: Tx, s: TenantSession, input: { batchIds: string[]; reason?: string }) {
    let qtyTotal = D(0);
    let valueTotal = D(0);
    for (const id of [...input.batchIds].sort()) {
      const b = (await tx.query(`SELECT id, branch_id, product_id, qty_remaining, unit_cost, (expiry_date < current_date) AS expired FROM stock_batch WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, id])).rows[0];
      if (!b) throw E.notFound('Batch');
      if (!b.expired) throw E.conflict('Only expired batches can be written off');
      if (!D(b.qty_remaining).gt(0)) continue;
      await this.stock.apply(tx, {
        shopId: s.shopId, branchId: b.branch_id, productId: b.product_id, type: 'expired', qtyBase: D(b.qty_remaining).neg().toString(), batchId: b.id,
        refType: 'expiry_writeoff', refId: b.id, reason: input.reason ?? 'expired stock written off', userId: s.userId,
      });
      qtyTotal = qtyTotal.plus(b.qty_remaining);
      valueTotal = valueTotal.plus(D(b.qty_remaining).times(b.unit_cost ?? 0));
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'expiry.written_off', entity: 'stock_batch', new: { batches: input.batchIds.length, qty: qtyTotal.toString(), value: valueTotal.toDecimalPlaces(2).toString() } });
    return { qty: qtyTotal.toString(), value: valueTotal.toDecimalPlaces(2).toString() };
  }

  /** Proposal for returning expiring stock to suppliers, using the return terms stored on each supplier. */
  async supplierReturnProposal(tx: Tx, shopId: string, withinDays = 90) {
    const r = await this.nearExpiry(tx, shopId, { withinDays });
    const groups = new Map<string, { supplierId: string; supplier: string; returnTerms: string; value: ReturnType<typeof D>; batches: any[] }>();
    type G = { supplierId: string; supplier: string; returnTerms: string; value: ReturnType<typeof D>; batches: any[] };
    for (const i of r.items.filter((x) => x.actions.includes('return_to_supplier'))) {
      const g: G = groups.get(i.supplierId!) ?? { supplierId: i.supplierId!, supplier: i.supplier!, returnTerms: i.returnTerms!, value: D(0), batches: [] };
      g.value = g.value.plus(i.value);
      g.batches.push({ batchId: i.batchId, name: i.name, batchNo: i.batchNo, qty: i.qty, expiryDate: i.expiryDate, value: i.value });
      groups.set(i.supplierId!, g);
    }
    return [...groups.values()].map((g) => ({ ...g, value: g.value.toString() }));
  }
}

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });

@RequireFeature('batch_expiry')
@Controller()
export class ExpiryController {
  constructor(private readonly db: Db, private readonly batches: BatchService, private readonly expiry: ExpiryService) {}

  @Get('batches')
  @RequireAnyPermission('stock.count', 'stock.receive', 'report.view', 'sale.create')
  list(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) => this.batches.list(tx, s.shopId, { branchId: q.branchId ?? s.branchId, productId: q.productId, includeEmpty: q.includeEmpty === 'true' }));
  }

  @Get('reports/near-expiry')
  @RequireAnyPermission('stock.count', 'report.view')
  near(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) => this.expiry.nearExpiry(tx, s.shopId, { branchId: q.branchId, withinDays: q.withinDays ? Number(q.withinDays) : undefined }));
  }

  @Get('reports/expired')
  @RequireAnyPermission('stock.count', 'report.view')
  expired(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) => this.expiry.nearExpiry(tx, s.shopId, { branchId: q.branchId, expired: true }));
  }

  @Get('reports/supplier-returns')
  @RequireAnyPermission('purchase.manage', 'report.view')
  supplierReturns(@CurrentTenant() s: TenantSession, @Query('withinDays') d?: string) {
    return this.db.tenant(ctx(s), (tx) => this.expiry.supplierReturnProposal(tx, s.shopId, d ? Number(d) : 90));
  }

  @Post('batches/write-off')
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  writeOff(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ batchIds: z.array(z.string().uuid()).min(1), reason: z.string().optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.expiry.writeOff(tx, s, b));
  }
}

@Module({
  imports: [SalesModule, InventoryModule, CatalogModule],
  controllers: [ExpiryController],
  providers: [BatchService, ExpiryService],
  exports: [BatchService, ExpiryService],
})
export class ExpiryModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobQueue,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
    private readonly expiry: ExpiryService,
  ) {}

  onModuleInit() {
    // Expiry alert -> in-app notification for everyone who receives stock alerts at that branch.
    this.outbox.on('stock.expiry', async (e, db: Db) => {
      await db.platform(async (tx) => {
        const users = await this.notifications.recipientsWithPermission(tx, e.shop_id!, e.payload.branchId, 'lowstock.receive_alerts');
        const expired = e.payload.band === 0;
        await this.notifications.notify(tx, {
          shopId: e.shop_id!, userIds: users, branchId: e.payload.branchId, type: expired ? 'stock.expired' : 'stock.expiring',
          title: expired ? `Expired: ${e.payload.name}` : `Expiring in ${e.payload.daysLeft} days: ${e.payload.name}`,
          body: `Batch ${e.payload.batchNo ?? '-'}: ${e.payload.qty} left, worth ${e.payload.value}`, payload: e.payload,
        });
      }, e.shop_id!);
    });
    this.jobs.register('expiry.scan', async (_j, db: Db) => {
      const shops = await db.platform(async (tx) => (await tx.query(`SELECT id FROM shop WHERE status='active'`)).rows);
      for (const sh of shops) await db.platform((tx) => this.expiry.scan(tx, sh.id), sh.id);
    });
  }
}
