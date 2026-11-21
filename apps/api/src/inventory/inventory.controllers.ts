import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { assertBranchAccess, scopeBranch } from '../common/branch-scope';
import { CurrentTenant, TenantSession } from '../common/session';
import { decimalStr, parse, z } from '../common/validate';
import { Db } from '../db/db';
import { RequireAnyPermission, RequirePermission } from '../auth/decorators';
import { ProductService } from '../catalog/product.service';
import { AdjustmentService } from './adjustment.service';
import { CostingService } from './costing.service';
import { LowStockService } from './lowstock.service';
import { NotificationService } from './notification.service';
import { ReconciliationService } from './reconciliation.service';
import { StockService } from './stock.service';
import { StocktakeService } from './stocktake.service';

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });

@Controller()
export class InventoryController {
  constructor(
    private readonly db: Db,
    private readonly stock: StockService,
    private readonly adjustments: AdjustmentService,
    private readonly stocktakes: StocktakeService,
    private readonly low: LowStockService,
    private readonly recon: ReconciliationService,
    private readonly costing: CostingService,
    private readonly notifications: NotificationService,
    private readonly products: ProductService,
  ) {}

  /** Quantities only (cashiers see stock). Cost and valuation are separate and need cost.view. */
  @Get('stock')
  balances(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) =>
      this.stock.balances(tx, s.shopId, { branchId: scopeBranch(s, q.branchId), productId: q.productId, limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined }),
    );
  }

  @Get('stock/movements')
  @RequireAnyPermission('stock.count', 'stock.receive', 'report.view')
  movements(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) =>
      this.stock.movements(tx, s.shopId, { branchId: scopeBranch(s, q.branchId), productId: q.productId, limit: q.limit ? Number(q.limit) : undefined, beforeId: q.beforeId ? Number(q.beforeId) : undefined }),
    );
  }

  @Post('stock/opening')
  @RequirePermission('stock.receive')
  opening(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ branchId: z.string().uuid(), lines: z.array(z.object({ productId: z.string().uuid(), qtyBase: decimalStr, unitCost: decimalStr.optional() })).min(1).max(1000) }), body);
    assertBranchAccess(s, b.branchId);
    return this.db.tenant(ctx(s), (tx) => this.adjustments.postOpening(tx, s, b));
  }

  @Get('stock/low')
  @RequirePermission('lowstock.receive_alerts')
  lowList(@CurrentTenant() s: TenantSession, @Query('branchId') branchId?: string) {
    return this.db.tenant(ctx(s), (tx) => this.low.list(tx, s.shopId, scopeBranch(s, branchId)));
  }

  @Get('stock/valuation')
  @RequirePermission('cost.view')
  valuation(@CurrentTenant() s: TenantSession, @Query('branchId') branchId?: string) {
    return this.db.tenant(ctx(s), (tx) => this.costing.valuation(tx, s.shopId, scopeBranch(s, branchId)));
  }

  /** Cost of one product: layers, last known cost, and whether any cost is only an estimate. cost.view only. */
  @Get('products/:id/cost')
  @RequirePermission('cost.view')
  productCost(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), async (tx) => {
      await this.products.get(tx, s.shopId, id);
      const layers = (
        await tx.query(
          `SELECT id, branch_id, qty_in, qty_remaining, unit_cost, estimated, source_type, received_at FROM cost_layer
           WHERE shop_id=$1 AND product_id=$2 AND qty_remaining > 0 ORDER BY received_at, id`,
          [s.shopId, id],
        )
      ).rows;
      const last = await this.costing.lastKnownCost(tx, s.shopId, s.branchId ?? '00000000-0000-0000-0000-000000000000', id);
      return { productId: id, lastKnownCost: last?.toString() ?? null, missingCost: last === null, hasEstimatedLayers: layers.some((l) => l.estimated), layers };
    });
  }

  @Post('stock/reconcile')
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  reconcile(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.recon.run(tx, s.shopId, scopeBranch(s)));
  }

  @Get('stock/discrepancies')
  @RequirePermission('stock.adjust')
  discrepancies(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.recon.list(tx, s.shopId));
  }

  // ----- adjustments -----
  @Post('adjustments')
  @RequirePermission('stock.adjust_request')
  requestAdjustment(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(
      z.object({
        branchId: z.string().uuid(), reason: z.string().min(1),
        lines: z.array(z.object({ productId: z.string().uuid(), kind: z.enum(['adjustment', 'damaged', 'expired']).optional(), qtyDelta: decimalStr, unitCost: decimalStr.optional() })).min(1),
      }),
      body,
    );
    assertBranchAccess(s, b.branchId);
    return this.db.tenant(ctx(s), (tx) => this.adjustments.request(tx, s, b));
  }

  @Get('adjustments')
  @RequirePermission('stock.adjust_request')
  listAdjustments(@CurrentTenant() s: TenantSession, @Query('status') status?: string) {
    return this.db.tenant(ctx(s), (tx) => this.adjustments.list(tx, s.shopId, status));
  }

  @Post('adjustments/:id/approve')
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  approve(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.adjustments.approve(tx, s, id));
  }

  @Post('adjustments/:id/reject')
  @HttpCode(204)
  @RequirePermission('stock.adjust')
  async reject(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: any) {
    await this.db.tenant(ctx(s), (tx) => this.adjustments.reject(tx, s, id, body?.note));
  }

  // ----- stocktake -----
  @Post('stocktakes')
  @RequirePermission('stock.count')
  openCount(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ branchId: z.string().uuid(), scope: z.string().optional(), category: z.string().optional(), productIds: z.array(z.string().uuid()).optional() }), body);
    assertBranchAccess(s, b.branchId);
    return this.db.tenant(ctx(s), (tx) => this.stocktakes.open(tx, s, b));
  }

  @Put('stocktakes/:id/counts')
  @RequirePermission('stock.count')
  count(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ productId: z.string().uuid(), qty: decimalStr, mode: z.enum(['set', 'add']).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.stocktakes.recordCount(tx, s, id, b.productId, b.qty, b.mode));
  }

  @Get('stocktakes/:id/review')
  @RequirePermission('stock.count')
  review(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.stocktakes.review(tx, s, id));
  }

  @Post('stocktakes/:id/post')
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  postCount(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: any) {
    return this.db.tenant(ctx(s), (tx) => this.stocktakes.post(tx, s, id, { zeroUncounted: !!body?.zeroUncounted }));
  }

  @Post('stocktakes/:id/cancel')
  @HttpCode(204)
  @RequirePermission('stock.count')
  async cancel(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.stocktakes.cancel(tx, s, id));
  }

  // ----- notifications (in-app) -----
  @Get('notifications')
  notificationList(@CurrentTenant() s: TenantSession, @Query('unread') unread?: string) {
    return this.db.tenant(ctx(s), (tx) => this.notifications.list(tx, s.shopId, s.userId, { unreadOnly: unread === 'true' }));
  }

  @Get('notifications/unread-count')
  async unread(@CurrentTenant() s: TenantSession) {
    return { count: await this.db.tenant(ctx(s), (tx) => this.notifications.unreadCount(tx, s.shopId, s.userId)) };
  }

  @Post('notifications/:id/read')
  @HttpCode(204)
  async markRead(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.notifications.markRead(tx, s.shopId, s.userId, Number(id)));
  }
}
