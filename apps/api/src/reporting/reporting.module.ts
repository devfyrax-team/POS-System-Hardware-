import { Controller, Get, Module, Param, Query } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CurrentTenant, TenantSession } from '../common/session';
import { E } from '../common/errors';
import { Db } from '../db/db';
import { RequireAnyPermission, RequirePermission } from '../auth/decorators';
import { ReportsService } from './reports.service';

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });

@Controller('reports')
export class ReportsController {
  constructor(private readonly db: Db, private readonly reports: ReportsService) {}

  /** Estimated gross profit: owner and manager only. */
  @Get('profit')
  @RequirePermission('profit.view')
  profit(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) => this.reports.profit(tx, s.shopId, { branchId: q.branchId, from: q.from, to: q.to }));
  }

  @Get('profit/by/:by')
  @RequirePermission('profit.view')
  profitBy(@CurrentTenant() s: TenantSession, @Param('by') by: string, @Query() q: any) {
    const key = by as 'item' | 'category' | 'cashier' | 'branch';
    if (!['item', 'category', 'cashier', 'branch'].includes(key)) throw E.validation('by must be item, category, cashier or branch');
    return this.db.tenant(ctx(s), (tx) => this.reports.profitBy(tx, s.shopId, key, { branchId: q.branchId, from: q.from, to: q.to }));
  }

  @Get('cost-flags')
  @RequirePermission('cost.view')
  flags(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) => this.reports.costFlags(tx, s.shopId, { from: q.from, to: q.to }));
  }

  /** Owner/manager home screen. Profit lines appear only for roles that may see profit. */
  @Get('dashboard')
  @RequireAnyPermission('report.view', 'profit.view')
  dashboard(@CurrentTenant() s: TenantSession, @Query('branchId') branchId?: string) {
    return this.db.tenant(ctx(s), (tx) => this.reports.dashboard(tx, s.shopId, { branchId: branchId ?? s.branchId, includeProfit: s.permissions!.has('profit.view') }));
  }
}

@Module({ imports: [CustomersModule, InventoryModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportingModule {}
