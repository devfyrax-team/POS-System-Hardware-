import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CustomersModule } from '../customers/customers.module';
import { CurrentTenant, TenantSession } from '../common/session';
import { decimalStr, nonNegativeDecimal, parse, positiveDecimal, z } from '../common/validate';
import { Db } from '../db/db';
import { RequireAnyPermission, RequirePermission } from '../auth/decorators';
import { PurchaseService } from './purchase.service';
import { SupplierService } from './supplier.service';

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });
const supplierShape = z.object({
  name: z.string().min(1).max(120), phone: z.string().max(30).optional(), email: z.string().email().optional(), address: z.string().max(300).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(), returnTerms: z.string().max(500).optional(),
});
const lineShape = z.object({ productId: z.string().uuid(), unitId: z.string().uuid().optional(), unit: z.string().optional(), qty: positiveDecimal, unitCost: nonNegativeDecimal });

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly db: Db, private readonly suppliers: SupplierService) {}

  @Get()
  @RequireAnyPermission('purchase.manage', 'stock.receive')
  list(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.suppliers.list(tx, s.shopId));
  }

  @Post()
  @RequirePermission('purchase.manage')
  create(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    return this.db.tenant(ctx(s), (tx) => this.suppliers.create(tx, s, parse(supplierShape, body)));
  }

  @Get(':id')
  @RequirePermission('purchase.manage')
  get(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.suppliers.get(tx, s.shopId, id));
  }

  @Patch(':id')
  @RequirePermission('purchase.manage')
  update(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const { version, status, ...rest } = parse(supplierShape.partial().extend({ version: z.number().int(), status: z.enum(['active', 'inactive']).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.suppliers.update(tx, s, id, version, { ...rest, status }));
  }

  @Get(':id/statement')
  @RequirePermission('purchase.manage')
  statement(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.suppliers.statement(tx, s.shopId, id));
  }

  @Post(':id/payments')
  @RequirePermission('purchase.manage')
  pay(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(
      z.object({ amount: positiveDecimal, method: z.enum(['cash', 'bank_transfer', 'cheque', 'card']), reference: z.string().max(100).optional(), cheque: z.object({ bank: z.string().optional(), chequeNo: z.string(), chequeDate: z.string() }).optional() }),
      body,
    );
    return this.db.tenant(ctx(s), (tx) => this.suppliers.pay(tx, s, { supplierId: id, ...b }));
  }
}

@Controller()
export class PurchasingController {
  constructor(private readonly db: Db, private readonly purchases: PurchaseService) {}

  @Post('purchase-orders')
  @RequirePermission('purchase.manage')
  createPo(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ supplierId: z.string().uuid(), expectedDate: z.string().optional(), note: z.string().optional(), lines: z.array(lineShape).min(1) }), body);
    return this.db.tenant(ctx(s), (tx) => this.purchases.createOrder(tx, s, b));
  }

  @Get('purchase-orders')
  @RequireAnyPermission('purchase.manage', 'stock.receive')
  listPo(@CurrentTenant() s: TenantSession, @Query('status') status?: string) {
    return this.db.tenant(ctx(s), (tx) => this.purchases.listOrders(tx, s.shopId, status));
  }

  @Get('purchase-orders/:id')
  @RequireAnyPermission('purchase.manage', 'stock.receive')
  getPo(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.purchases.getOrder(tx, s.shopId, id));
  }

  @Post('purchase-orders/:id/approve')
  @HttpCode(200)
  @RequirePermission('purchase.manage')
  approvePo(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.purchases.approveOrder(tx, s, id));
  }

  @Post('purchase-orders/:id/cancel')
  @HttpCode(204)
  @RequirePermission('purchase.manage')
  async cancelPo(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.purchases.cancelOrder(tx, s, id));
  }

  /** Receiving goods: storekeepers and purchasing staff. Never blocked by a cost change. */
  @Post('purchases')
  @RequireAnyPermission('stock.receive', 'purchase.manage')
  receive(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(
      z.object({
        supplierId: z.string().uuid(), poId: z.string().uuid().optional(), supplierInvoiceNo: z.string().max(60).optional(), note: z.string().optional(),
        landedCosts: z.array(z.object({ label: z.string(), amount: nonNegativeDecimal })).optional(),
        lines: z.array(lineShape.extend({ poLineId: z.string().uuid().optional(), batchNo: z.string().optional(), mfgDate: z.string().optional(), expiryDate: z.string().optional() })).min(1),
      }),
      body,
    );
    return this.db.tenant(ctx(s), (tx) => this.purchases.receive(tx, s, b));
  }

  @Get('purchases')
  @RequireAnyPermission('purchase.manage', 'stock.receive')
  list(@CurrentTenant() s: TenantSession, @Query('supplierId') supplierId?: string) {
    return this.db.tenant(ctx(s), (tx) => this.purchases.listPurchases(tx, s.shopId, supplierId));
  }

  @Get('purchases/:id')
  @RequireAnyPermission('purchase.manage', 'stock.receive')
  get(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.purchases.getPurchase(tx, s.shopId, id));
  }

  @Post('purchase-returns')
  @RequirePermission('purchase.manage')
  returnGoods(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ purchaseId: z.string().uuid(), reason: z.string().min(1), lines: z.array(z.object({ purchaseLineId: z.string().uuid(), qty: positiveDecimal })).min(1) }), body);
    return this.db.tenant(ctx(s), (tx) => this.purchases.returnToSupplier(tx, s, b));
  }

  @Get('products/:id/purchase-history')
  @RequirePermission('purchase.manage')
  history(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.purchases.priceHistory(tx, s.shopId, id));
  }
}

@Module({
  imports: [CatalogModule, InventoryModule, CustomersModule],
  controllers: [SuppliersController, PurchasingController],
  providers: [SupplierService, PurchaseService],
  exports: [SupplierService, PurchaseService],
})
export class PurchasingModule {}

export { decimalStr, Put };
