import { Body, Controller, Get, HttpCode, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { D } from '@pos/money';
import { E } from '../common/errors';
import { SalesModule } from '../sales/sales.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CurrentTenant, TenantSession } from '../common/session';
import { decimalStr, parse, positiveDecimal, z } from '../common/validate';
import { Db } from '../db/db';
import { RequireAnyPermission, RequireFeature, RequirePermission } from '../auth/decorators';
import { ChequeService } from './cheque.service';
import { CreditService } from './credit.service';
import { CustomerService } from './customer.service';

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });
const chequeShape = z.object({ bank: z.string().max(60).optional(), chequeNo: z.string().min(1).max(30), chequeDate: z.string() });
const customerShape = z.object({
  name: z.string().min(1).max(120), phone: z.string().max(30).optional(), email: z.string().email().optional(), address: z.string().max(300).optional(),
  type: z.enum(['retail', 'contractor', 'wholesale']).optional(), creditLimit: decimalStr.optional(), dueDays: z.number().int().min(0).max(365).optional(), notes: z.string().max(500).optional(),
});

@Controller('customers')
export class CustomersController {
  constructor(private readonly db: Db, private readonly customers: CustomerService, private readonly credit: CreditService) {}

  @Get('search')
  @RequireAnyPermission('sale.create', 'customer.manage')
  search(@CurrentTenant() s: TenantSession, @Query('q') q = '') {
    return this.db.tenant(ctx(s), (tx) => this.customers.search(tx, s.shopId, q));
  }

  @Post()
  @RequirePermission('customer.manage')
  create(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(customerShape, body);
    if (b.creditLimit !== undefined && D(b.creditLimit).gt(0) && !s.features?.has('credit_sales')) throw E.featureNotEnabled('credit_sales');
    if ((b.creditLimit !== undefined || b.dueDays !== undefined) && !s.permissions!.has('credit.manage')) {
      const { creditLimit, dueDays, ...rest } = b;
      return this.db.tenant(ctx(s), (tx) => this.customers.create(tx, s, rest));
    }
    return this.db.tenant(ctx(s), (tx) => this.customers.create(tx, s, b));
  }

  @Get()
  @RequirePermission('customer.manage')
  list(@CurrentTenant() s: TenantSession, @Query('withBalance') wb?: string) {
    return this.db.tenant(ctx(s), (tx) => this.customers.list(tx, s.shopId, { withBalance: wb === 'true' }));
  }

  @Get('overdue')
  @RequireAnyPermission('credit.manage', 'report.view')
  overdue(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.customers.overdue(tx, s.shopId));
  }

  @Get('ageing')
  @RequireAnyPermission('credit.manage', 'report.view')
  ageing(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.customers.ageing(tx, s.shopId));
  }

  @Get(':id')
  @RequireAnyPermission('customer.manage', 'sale.create')
  get(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.customers.get(tx, s.shopId, id));
  }

  @Patch(':id')
  @RequirePermission('customer.manage')
  update(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const { version, status, ...rest } = parse(customerShape.partial().extend({ version: z.number().int(), status: z.enum(['active', 'inactive']).optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.customers.update(tx, s, id, version, { ...rest, status }, s.permissions!.has('credit.manage')));
  }

  @Get(':id/statement')
  @RequirePermission('customer.manage')
  statement(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) => this.customers.statement(tx, s.shopId, id, { from: q.from, to: q.to }));
  }

  /** Customer pays down their account: partial payments are normal. */
  @Post(':id/payments')
  @RequireFeature('credit_sales')
  @RequirePermission('payment.take')
  pay(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ amount: positiveDecimal, method: z.enum(['cash', 'card', 'bank_transfer', 'cheque']), reference: z.string().max(100).optional(), cheque: chequeShape.optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.credit.recordPayment(tx, s, { customerId: id, ...b }));
  }
}

@RequireFeature('cheques')
@Controller('cheques')
export class ChequesController {
  constructor(private readonly db: Db, private readonly cheques: ChequeService) {}

  @Get()
  @RequireAnyPermission('credit.manage', 'report.view', 'purchase.manage')
  list(@CurrentTenant() s: TenantSession, @Query() q: any) {
    return this.db.tenant(ctx(s), (tx) => this.cheques.list(tx, s.shopId, { status: q.status, direction: q.direction, dueWithinDays: q.dueWithinDays ? Number(q.dueWithinDays) : undefined }));
  }

  @Post(':id/deposit')
  @HttpCode(200)
  @RequireAnyPermission('credit.manage', 'purchase.manage')
  deposit(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.cheques.transition(tx, s, id, 'deposited'));
  }

  @Post(':id/clear')
  @HttpCode(200)
  @RequireAnyPermission('credit.manage', 'purchase.manage')
  clear(@CurrentTenant() s: TenantSession, @Param('id') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.cheques.transition(tx, s, id, 'cleared'));
  }

  /** A bounced cheque reverses the payment and restores the balance; the bank fee can be charged to the customer. */
  @Post(':id/bounce')
  @HttpCode(200)
  @RequireAnyPermission('credit.manage', 'purchase.manage')
  bounce(@CurrentTenant() s: TenantSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ fee: decimalStr.optional() }), body ?? {});
    return this.db.tenant(ctx(s), (tx) => this.cheques.transition(tx, s, id, 'bounced', b));
  }
}

const services = [CustomerService, ChequeService, CreditService];

@Module({ imports: [SalesModule, InventoryModule], controllers: [CustomersController, ChequesController], providers: services, exports: services })
export class CustomersModule {}
