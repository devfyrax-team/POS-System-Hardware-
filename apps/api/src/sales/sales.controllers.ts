import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { E } from '../common/errors';
import { CurrentTenant, TenantSession } from '../common/session';
import { parse, z, decimalStr, positiveDecimal } from '../common/validate';
import { Db } from '../db/db';
import { RequireAnyPermission, RequireFeature, RequirePermission } from '../auth/decorators';
import { CheckoutService, checkoutSchema } from './checkout.service';
import { HeldBillService, QuotationService, DeliveryNoteService } from './held-quote.service';
import { ReceiptService } from './receipt.service';
import { SaleQueryService } from './sale-query.service';
import { VoidReturnService } from './void-return.service';
import { StockService } from '../inventory/stock.service';

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });

@Controller()
export class SalesController {
  constructor(
    private readonly db: Db,
    private readonly checkout: CheckoutService,
    private readonly queries: SaleQueryService,
    private readonly voids: VoidReturnService,
    private readonly receipts: ReceiptService,
    private readonly held: HeldBillService,
    private readonly stock: StockService,
  ) {}

  /** The Idempotency-Key header is required: a retry after a poor connection can never create a second bill. */
  @Post('sales')
  @RequirePermission('sale.create', 'payment.take')
  async create(@CurrentTenant() s: TenantSession, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: any) {
    if (!key || key.length < 8 || key.length > 100) throw E.validation('Idempotency-Key header is required (8-100 chars)');
    const cmd = { ...parse(checkoutSchema, body), idempotencyKey: key };
    const out: any = await this.db.tenant(ctx(s), (tx) => this.checkout.checkout(tx, s, cmd));
    res.status(out.replayed ? 200 : 201);
    return out;
  }

  @Get('sales/summary')
  @RequireAnyPermission('sale.create', 'report.view')
  summary(@CurrentTenant() s: TenantSession, @Query() q: any) {
    const wide = s.permissions!.has('report.view');
    return this.db.tenant(ctx(s), (tx) =>
      this.queries.summary(tx, s.shopId, {
        branchId: q.branchId ?? s.branchId, terminalId: q.terminalId, cashierId: wide ? q.cashierId : s.userId, from: q.from, to: q.to,
      }),
    );
  }

  @Get('sales')
  @RequireAnyPermission('sale.create', 'report.view')
  list(@CurrentTenant() s: TenantSession, @Query() q: any) {
    const wide = s.permissions!.has('report.view');
    return this.db.tenant(ctx(s), (tx) =>
      this.queries.list(tx, s.shopId, {
        branchId: q.branchId ?? s.branchId, cashierId: wide ? q.cashierId : s.userId, terminalId: q.terminalId, from: q.from, to: q.to,
        invoiceNo: q.invoiceNo, limit: q.limit ? Number(q.limit) : undefined, beforeCreatedAt: q.before,
      }),
    );
  }

  @Get('sales/:id')
  @RequireAnyPermission('sale.create', 'report.view')
  get(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.queries.get(tx, s.shopId, id, { onlyCashierId: s.permissions!.has('report.view') ? undefined : s.userId }));
  }

  @Get('sales/:id/receipt')
  @RequireAnyPermission('sale.create', 'report.view')
  receipt(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Query('lang') lang?: 'en' | 'si' | 'ta') {
    return this.db.tenant(ctx(s), async (tx) => {
      await this.queries.get(tx, s.shopId, id, { onlyCashierId: s.permissions!.has('report.view') ? undefined : s.userId });
      return this.receipts.render(tx, s.shopId, id, { lang });
    });
  }

  /** Needs sale.void, or a supervisor override token for this sale. */
  @Post('sales/:id/void')
  @HttpCode(200)
  @RequireAnyPermission('sale.create', 'sale.void')
  voidSale(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ reason: z.string().min(1), approvalToken: z.string().optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.voids.void(tx, s, id, b));
  }

  @Post('returns')
  @RequireAnyPermission('sale.create', 'sale.refund')
  createReturn(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(
      z.object({
        saleId: z.string().uuid(),
        lines: z.array(z.object({ saleLineId: z.string().uuid(), qty: positiveDecimal, disposition: z.enum(['sellable', 'damaged']).optional() })).min(1),
        reason: z.string().min(1),
        refundMethod: z.enum(['cash', 'card', 'bank_transfer', 'cheque', 'account_credit']),
        approvalToken: z.string().optional(),
      }),
      body,
    );
    return this.db.tenant(ctx(s), (tx) => this.voids.createReturn(tx, s, b));
  }

  // ----- held bills (per terminal) -----
  @Post('held-bills')
  @RequirePermission('sale.create')
  hold(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ label: z.string().max(60).optional(), cart: z.unknown() }), body);
    return this.db.tenant(ctx(s), (tx) => this.held.hold(tx, s, b));
  }

  @Get('held-bills')
  @RequirePermission('sale.create')
  heldList(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.held.list(tx, s));
  }

  @Post('held-bills/:id/recall')
  @HttpCode(200)
  @RequirePermission('sale.create')
  recall(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.held.recall(tx, s, id));
  }

  /** Quick live check at add-to-cart time. It warns; it does not reserve anything. The server decides at pay. */
  @Get('stock/check')
  @RequirePermission('sale.create')
  check(@CurrentTenant() s: TenantSession, @Query('productIds') ids = '') {
    return this.db.tenant(ctx(s), async (tx) => {
      const list = ids.split(',').filter(Boolean).slice(0, 100);
      const out: Record<string, string> = {};
      for (const id of list) out[id] = await this.stock.available(tx, s.branchId ?? '00000000-0000-0000-0000-000000000000', id);
      return out;
    });
  }
}

@RequireFeature('quotations')
@Controller('quotations')
export class QuotationController {
  constructor(private readonly db: Db, private readonly quotes: QuotationService) {}

  @Post()
  @RequirePermission('sale.create')
  create(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(
      z.object({
        customerId: z.string().uuid().optional(), customerName: z.string().max(120).optional(), validDays: z.number().int().min(1).max(365).optional(), note: z.string().max(300).optional(),
        lines: z.array(z.object({ productId: z.string().uuid(), unitId: z.string().uuid().optional(), unit: z.string().optional(), qty: positiveDecimal, price: decimalStr.optional() })).min(1),
      }),
      body,
    );
    return this.db.tenant(ctx(s), (tx) => this.quotes.create(tx, s, b));
  }

  @Get()
  @RequirePermission('sale.create')
  list(@CurrentTenant() s: TenantSession, @Query('status') status?: string) {
    return this.db.tenant(ctx(s), (tx) => this.quotes.list(tx, s.shopId, status));
  }

  @Get(':id')
  @RequirePermission('sale.create')
  get(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.quotes.get(tx, s.shopId, id));
  }

  @Post(':id/convert')
  @HttpCode(200)
  @RequirePermission('sale.create', 'payment.take')
  convert(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(checkoutSchema.pick({ payments: true, customerId: true, approvals: true, billDiscount: true }), body);
    return this.db.tenant(ctx(s), (tx) => this.quotes.convert(tx, s, id, b as any));
  }

  @Post(':id/cancel')
  @HttpCode(204)
  @RequirePermission('sale.create')
  async cancel(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    await this.db.tenant(ctx(s), (tx) => this.quotes.cancel(tx, s, id));
  }
}

@RequireFeature('delivery_notes')
@Controller('delivery-notes')
export class DeliveryNoteController {
  constructor(private readonly db: Db, private readonly notes: DeliveryNoteService) {}

  @Post()
  @RequirePermission('sale.create')
  create(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ saleId: z.string().uuid(), lines: z.array(z.object({ saleLineId: z.string().uuid(), qty: positiveDecimal })).min(1), note: z.string().optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.notes.create(tx, s, b));
  }

  @Get('sale/:saleId')
  @RequirePermission('sale.create')
  status(@CurrentTenant() s: TenantSession, @Param('saleId') saleId: string) {
    return this.db.tenant(ctx(s), (tx) => this.notes.status(tx, s.shopId, saleId));
  }
}
