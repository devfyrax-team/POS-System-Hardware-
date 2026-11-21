import { Body, Controller, Get, Header, HttpCode, Module, OnModuleInit, Param, Post, Put } from '@nestjs/common';
import { assertBranchAccess, scopeBranch } from '../common/branch-scope';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CurrentTenant, TenantSession } from '../common/session';
import { parse, z } from '../common/validate';
import { Db } from '../db/db';
import { RequireFeature, RequirePermission } from '../auth/decorators';
import { JobQueue } from '../jobs/job-queue';
import { ImportService } from './import.service';

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });

@RequireFeature('bulk_import')
@RequirePermission('import.manage')
@Controller('imports')
export class ImportController {
  constructor(private readonly db: Db, private readonly imports: ImportService) {}

  @Post()
  upload(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ branchId: z.string().uuid().optional(), rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).min(1) }), body);
    if (b.branchId) assertBranchAccess(s, b.branchId);
    return this.db.tenant(ctx(s), (tx) => this.imports.upload(tx, s, b));
  }

  @Post(':id/validate')
  @HttpCode(200)
  validate(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.imports.validate(tx, s, id));
  }

  @Put(':id/decisions')
  decide(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ rowIds: z.array(z.coerce.number()).optional(), decision: z.enum(['create', 'use_existing', 'skip']), allReview: z.boolean().optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.imports.setDecision(tx, s, id, b));
  }

  @Get(':id')
  preview(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.imports.preview(tx, s, id));
  }

  @Get(':id/errors.csv')
  @Header('Content-Type', 'text/csv')
  errors(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.imports.errorCsv(tx, s, id));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.imports.confirm(tx, s, id));
  }

  @Post(':id/undo')
  @HttpCode(200)
  undo(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.imports.undo(tx, s, id));
  }
}

@Module({ imports: [CatalogModule, InventoryModule], controllers: [ImportController], providers: [ImportService], exports: [ImportService] })
export class ImportModule implements OnModuleInit {
  constructor(private readonly jobs: JobQueue, private readonly imports: ImportService) {}

  onModuleInit() {
    this.jobs.register('import.process', (job, db) => this.imports.process(db, job.shop_id!, job.payload.batchId));
  }
}
