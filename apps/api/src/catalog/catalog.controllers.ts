import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { E } from '../common/errors';
import { scopeBranch } from '../common/branch-scope';
import { CurrentTenant, TenantSession } from '../common/session';
import { decimalStr, nonNegativeDecimal, parse, z } from '../common/validate';
import { Db } from '../db/db';
import { RequireAnyPermission, RequireFeature, RequirePermission } from '../auth/decorators';
import { BarcodeService } from './barcode.service';
import { LabelService } from './label.service';
import { MasterCatalogService } from './master.service';
import { PricingService } from './pricing.service';
import { productInput, ProductService } from './product.service';
import { ProductSearchService } from './search.service';
import { UnitService } from './unit.service';
import { VariantGenerator } from './variant.generator';

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });

@Controller('master')
export class MasterController {
  constructor(private readonly db: Db, private readonly master: MasterCatalogService) {}

  @Get('categories')
  categories(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), async (tx) => {
      const t = (await tx.query(`SELECT shop_type FROM shop WHERE id=$1`, [s.shopId])).rows[0].shop_type;
      return this.master.categories(tx, t);
    });
  }

  @Get('products')
  search(@CurrentTenant() s: TenantSession, @Query('q') q = '', @Query('categoryId') categoryId?: string) {
    return this.db.tenant(ctx(s), (tx) => this.master.search(tx, q, { categoryId }));
  }

  @Get('products/:id/variants')
  variants(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.master.variants(tx, id));
  }

  @Post('suggest')
  @HttpCode(200)
  suggest(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().optional(), barcode: z.string().optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.master.suggestMatch(tx, b));
  }

  @Post('submissions')
  @RequirePermission('catalog.manage')
  submit(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(1), baseUnit: z.string().optional(), category: z.string().optional(), brand: z.string().optional(), size: z.string().optional(), barcode: z.string().optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.master.submit(tx, s, b));
  }
}

const patchSchema = productInput
  .omit({ units: true, price: true, barcode: true, baseUnit: true, decimalQty: true, masterProductId: true, masterVariantId: true, shortCode: true })
  .partial()
  .extend({ version: z.number().int() });

@Controller('products')
export class ProductsController {
  constructor(
    private readonly db: Db,
    private readonly products: ProductService,
    private readonly pricing: PricingService,
    private readonly units: UnitService,
    private readonly barcodes: BarcodeService,
    private readonly search: ProductSearchService,
    private readonly labels: LabelService,
    private readonly variants: VariantGenerator,
  ) {}

  // ----- reading: every signed-in user (cashiers search products); cost is never returned here -----
  @Get('search')
  doSearch(@CurrentTenant() s: TenantSession, @Query('q') q = '', @Query('limit') limit?: string) {
    return this.db.tenant(ctx(s), (tx) => this.search.search(tx, s.shopId, s.branchId, q, { limit: limit ? Number(limit) : undefined }));
  }

  @Get('lookup')
  async lookup(@CurrentTenant() s: TenantSession, @Query('code') code = '') {
    const hit = await this.db.tenant(ctx(s), (tx) => this.barcodes_lookup(tx, s.shopId, code));
    if (!hit) throw E.notFound('Item for this code');
    return hit;
  }
  private barcodes_lookup(tx: any, shopId: string, code: string) {
    return this.barcodes.lookup(tx, shopId, code);
  }

  @Get()
  list(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) =>
      this.products.list(tx, s.shopId, {
        category: q.category, needsReview: q.needsReview === undefined ? undefined : q.needsReview === 'true',
        status: q.status, branchId: scopeBranch(s, q.branchId), limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined,
      }),
    );
  }

  @Get(':id')
  get(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), async (tx) => ({
      ...(await this.products.get(tx, s.shopId, id)),
      units: await this.units.list(tx, s.shopId, id),
      barcodes: await this.barcodes.list(tx, s.shopId, id),
    }));
  }

  // ----- catalog management -----
  @Post()
  @RequirePermission('catalog.manage')
  create(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    return this.db.tenant(ctx(s), (tx) => this.products.create(tx, s, parse(productInput, body)));
  }

  @Post('from-master')
  @RequirePermission('catalog.manage')
  fromMaster(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ masterProductId: z.string().uuid(), variantId: z.string().uuid().optional(), price: nonNegativeDecimal.optional(), minLevel: nonNegativeDecimal.optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.products.createFromMaster(tx, s, b));
  }

  @Post('bulk-from-master')
  @RequirePermission('catalog.manage')
  bulk(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ categoryIds: z.array(z.string().uuid()).min(1), excludeMasterIds: z.array(z.string().uuid()).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.products.bulkSelectFromMaster(tx, s, b));
  }

  /** At the till in seconds: a cashier or a catalog manager can add an unlisted item (flagged for review). */
  @Post('quick-add')
  @RequireAnyPermission('sale.create', 'catalog.manage')
  quickAdd(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(1).max(200), unit: z.string().min(1).max(20), price: nonNegativeDecimal }), body);
    return this.db.tenant(ctx(s), (tx) => this.products.quickAdd(tx, s, b));
  }

  @Patch(':id')
  @RequirePermission('catalog.manage')
  update(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const { version, ...patch } = parse(patchSchema, body);
    return this.db.tenant(ctx(s), (tx) => this.products.update(tx, s, id, version, patch));
  }

  @Post(':id/status')
  @RequirePermission('catalog.manage')
  status(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ status: z.enum(['active', 'inactive']) }), body);
    return this.db.tenant(ctx(s), (tx) => this.products.setStatus(tx, s, id, b.status));
  }

  @Put(':id/units')
  @RequirePermission('catalog.manage')
  defineUnits(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ conversions: z.array(z.object({ unit: z.string().min(1).max(20), factor: decimalStr })).min(1) }), body);
    return this.db.tenant(ctx(s), (tx) => this.units.defineUnits(tx, s, id, b.conversions));
  }

  @Post(':id/barcodes')
  @RequirePermission('catalog.manage')
  addBarcode(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ code: z.string().min(3).max(64), unitId: z.string().uuid().optional(), type: z.enum(['manufacturer', 'internal', 'supplier']).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.barcodes.add(tx, s, { productId: id, ...b }));
  }

  @Delete('barcodes/:barcodeId')
  @HttpCode(204)
  @RequirePermission('catalog.manage')
  async removeBarcode(@CurrentTenant() s: TenantSession, @Param('barcodeId') barcodeId: string) {
    await this.db.tenant(ctx(s), (tx) => this.barcodes.remove(tx, s, barcodeId));
  }

  @Put(':id/branch-min-level')
  @HttpCode(204)
  @RequirePermission('catalog.manage')
  async branchMin(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ branchId: z.string().uuid(), minLevel: nonNegativeDecimal.nullable() }), body);
    await this.db.tenant(ctx(s), (tx) => this.products.setBranchMinLevel(tx, s, b.branchId, id, b.minLevel));
  }

  // ----- prices (owner/manager) and cost (cost.view only) -----
  @Put(':id/prices')
  @HttpCode(200)
  @RequirePermission('price.change')
  setPrice(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ price: nonNegativeDecimal, unitId: z.string().uuid().optional(), tier: z.enum(['retail', 'wholesale', 'contractor']).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.pricing.setPrice(tx, s, { productId: id, ...b }));
  }

  @Post('prices/bulk')
  @RequirePermission('price.change')
  bulkPrices(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ rows: z.array(z.object({ sku: z.string().optional(), productId: z.string().uuid().optional(), price: nonNegativeDecimal.optional(), cost: nonNegativeDecimal.optional() })).min(1).max(2000) }), body);
    return this.db.tenant(ctx(s), (tx) => this.pricing.bulkSetPrices(tx, s, b.rows));
  }

  @Get(':id/prices/history')
  @RequirePermission('price.change')
  priceHistory(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.pricing.history(tx, s.shopId, id));
  }

  // ----- labels and variants -----
  @Post('labels/render')
  @HttpCode(200)
  @RequireFeature('label_printing')
  @RequirePermission('catalog.manage')
  render(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ productIds: z.array(z.string().uuid()).min(1).max(500), template: z.enum(['shelf', 'bin', 'barcode']), includePrice: z.boolean().optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.labels.render(tx, s.shopId, b));
  }

  @Post('variants/preview')
  @HttpCode(200)
  @RequirePermission('catalog.manage')
  variantPreview(@Body() body: unknown) {
    return this.variants.preview(parse(variantSchema, body));
  }

  @Post('variants/generate')
  @RequirePermission('catalog.manage')
  variantGenerate(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(variantSchema, body);
    return this.db.tenant(ctx(s), (tx) => this.variants.generate(tx, s, b));
  }
}

const variantSchema = z.object({
  baseName: z.string().min(1), baseUnit: z.string().min(1), category: z.string().optional(), brand: z.string().optional(),
  decimalQty: z.boolean().optional(), trackBatches: z.boolean().optional(), shelfLifeDays: z.number().int().positive().optional(),
  axes: z.record(z.string(), z.array(z.string())),
});
