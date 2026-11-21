import { Body, Controller, Get, Header, HttpCode, Injectable, Module, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { D } from '@pos/money';
import { Db, Tx } from '../db/db';
import { E } from '../common/errors';
import { CurrentSession, CurrentTenant, PlatformSession, TenantSession } from '../common/session';
import { parse, positiveDecimal, z } from '../common/validate';
import { AuditService } from '../audit/audit.service';
import { AllowWhenRestricted, PlatformOnly, RequirePermission } from '../auth/decorators';
import { JobQueue } from '../jobs/job-queue';
import { NotificationService } from '../inventory/notification.service';
import { InventoryModule } from '../inventory/inventory.module';
import { SubscriptionService } from './subscription.service';

const GRACE_DAYS = 7;
const RESTRICTED_TO_CANCELLED_DAYS = 30;

/** The platform's OWN billing: invoices and payments live in separate tables and screens from a shop's sales and customers. */
@Injectable()
export class PlatformBillingService {
  constructor(private readonly audit: AuditService, private readonly subs: SubscriptionService) {}

  async createInvoice(tx: Tx, adminId: string, shopId: string, period: 'monthly' | 'annual' = 'monthly') {
    const sub = (
      await tx.query(`SELECT s.plan_id, p.price_monthly, p.price_annual, p.code FROM subscription s JOIN plan p ON p.id=s.plan_id WHERE s.shop_id=$1`, [shopId])
    ).rows[0];
    if (!sub) throw E.notFound('Subscription');
    const amount = period === 'annual' ? sub.price_annual : sub.price_monthly;
    const n = (await tx.query(`SELECT nextval('platform_invoice_seq') AS n`)).rows[0].n;
    const number = `PINV-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`;
    const inv = (
      await tx.query(
        `INSERT INTO platform_invoice(shop_id, number, plan_id, period, amount, due_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days') RETURNING id, number, amount, status, due_at`,
        [shopId, number, sub.plan_id, period, amount],
      )
    ).rows[0];
    await this.audit.record(tx, { shopId, actorId: adminId, actorType: 'platform', action: 'billing.invoice_created', entity: 'platform_invoice', entityId: inv.id, new: { number, amount: D(amount).toString(), period } });
    return inv;
  }

  /** Payments can be partial; the invoice is paid (and the subscription extended) once it is covered in full. */
  async recordPayment(tx: Tx, adminId: string, invoiceId: string, i: { amount: string; method: string; reference?: string }) {
    const inv = (await tx.query(`SELECT id, shop_id, amount, status, period FROM platform_invoice WHERE id=$1 FOR UPDATE`, [invoiceId])).rows[0];
    if (!inv) throw E.notFound('Invoice');
    if (inv.status !== 'open') throw E.conflict(`Invoice is ${inv.status}`);
    const paid = D((await tx.query(`SELECT coalesce(sum(amount),0) s FROM platform_payment WHERE invoice_id=$1`, [invoiceId])).rows[0].s);
    if (paid.plus(i.amount).gt(inv.amount)) throw E.validation('Payment is more than the invoice balance', { balance: D(inv.amount).minus(paid).toString() });
    await tx.query(`INSERT INTO platform_payment(invoice_id, shop_id, amount, method, reference, recorded_by) VALUES ($1,$2,$3,$4,$5,$6)`, [invoiceId, inv.shop_id, i.amount, i.method, i.reference ?? null, adminId]);
    const settled = paid.plus(i.amount).equals(inv.amount);
    if (settled) {
      await tx.query(`UPDATE platform_invoice SET status='paid', paid_at=now() WHERE id=$1`, [invoiceId]);
      const days = inv.period === 'annual' ? 365 : 30;
      await tx.query(
        `UPDATE subscription SET status='active', grace_until=NULL, trial_ends_at=NULL, billing_period=$2,
           current_period_end = greatest(coalesce(current_period_end, now()), now()) + ($3 || ' days')::interval, updated_at=now() WHERE shop_id=$1`,
        [inv.shop_id, inv.period, String(days)],
      );
      await this.audit.record(tx, { shopId: inv.shop_id, actorId: adminId, actorType: 'platform', action: 'billing.invoice_paid', entity: 'platform_invoice', entityId: invoiceId });
    }
    return { invoiceId, paid: paid.plus(i.amount).toString(), balance: D(inv.amount).minus(paid).minus(i.amount).toString(), status: settled ? 'paid' : 'open' };
  }

  async list(tx: Tx, f: { shopId?: string; status?: string }) {
    return (
      await tx.query(
        `SELECT i.id, i.shop_id, s.name AS shop, i.number, i.period, i.amount, i.status, i.issued_at, i.due_at, i.paid_at,
                (SELECT coalesce(sum(amount),0) FROM platform_payment p WHERE p.invoice_id=i.id) AS paid
         FROM platform_invoice i JOIN shop s ON s.id=i.shop_id WHERE ($1::uuid IS NULL OR i.shop_id=$1) AND ($2::text IS NULL OR i.status=$2) ORDER BY i.issued_at DESC LIMIT 200`,
        [f.shopId ?? null, f.status ?? null],
      )
    ).rows;
  }
}

/**
 * Daily lifecycle: trial / paid period ends -> past_due (grace period with warnings) -> restricted (read-only)
 * -> cancelled (data export stays available). Moves nothing that was paid up.
 */
@Injectable()
export class SubscriptionLifecycleService {
  constructor(private readonly subs: SubscriptionService, private readonly notifications: NotificationService) {}

  /** Finds shops that moved to a new stage, then updates each in its own shop-bound transaction (so owners can be notified). */
  async run(db: Db) {
    const due = await db.platform(async (tx) => ({
      pastDue: (await tx.query(`SELECT shop_id FROM subscription WHERE (status='trial' AND trial_ends_at < now()) OR (status='active' AND current_period_end < now())`)).rows,
      restricted: (await tx.query(`SELECT shop_id FROM subscription WHERE status='past_due' AND grace_until < now()`)).rows,
      cancelled: (await tx.query(`SELECT shop_id FROM subscription WHERE status='restricted' AND updated_at < now() - ($1 || ' days')::interval`, [String(RESTRICTED_TO_CANCELLED_DAYS)])).rows,
    }));
    const move = async (rows: { shop_id: string }[], status: 'past_due' | 'restricted' | 'cancelled', title: string, grace = false) => {
      for (const r of rows) {
        await db.platform(async (tx) => {
          await this.subs.setStatus(tx, null, r.shop_id, status);
          if (grace) await tx.query(`UPDATE subscription SET grace_until = now() + ($2 || ' days')::interval WHERE shop_id=$1`, [r.shop_id, String(GRACE_DAYS)]);
          const owners = await this.notifications.recipientsWithPermission(tx, r.shop_id, null, 'shop.settings');
          await this.notifications.notify(tx, { shopId: r.shop_id, userIds: owners, type: `subscription.${status}`, title });
        }, r.shop_id);
      }
    };
    await move(due.pastDue, 'past_due', `Your subscription payment is due. Pay within ${GRACE_DAYS} days to avoid read-only mode`, true);
    await move(due.restricted, 'restricted', 'Your shop is now read-only until the subscription is paid');
    await move(due.cancelled, 'cancelled', 'Your subscription was cancelled. Export your data while it is still available');
    return { toPastDue: due.pastDue.length, toRestricted: due.restricted.length, toCancelled: due.cancelled.length };
  }
}

/** Every shop can take all of its own data out: products, sales, customers, suppliers, stock history. */
@Injectable()
export class ExportService {
  async exportShop(tx: Tx, shopId: string) {
    const q = async (sql: string) => (await tx.query(sql, [shopId])).rows;
    return {
      exportedAt: new Date().toISOString(),
      shop: (await q(`SELECT id, name, shop_type, settings, created_at FROM shop WHERE id=$1`))[0],
      branches: await q(`SELECT * FROM branch WHERE shop_id=$1`),
      products: await q(`SELECT id, sku, short_code, name, name_si, category, brand, size, base_unit, status FROM product WHERE shop_id=$1 ORDER BY name`),
      units: await q(`SELECT product_id, unit, factor, is_base FROM product_unit WHERE shop_id=$1`),
      barcodes: await q(`SELECT product_id, code, type FROM product_barcode WHERE shop_id=$1`),
      prices: await q(`SELECT product_id, tier, price FROM product_price WHERE shop_id=$1`),
      stock: await q(`SELECT branch_id, product_id, quantity, damaged_qty FROM stock_balance WHERE shop_id=$1`),
      stockMovements: await q(`SELECT id, branch_id, product_id, type, qty_base, unit_cost, ref_type, ref_id, reason, created_at FROM stock_movement WHERE shop_id=$1 ORDER BY id`),
      customers: await q(`SELECT id, name, phone, email, type, credit_limit, balance FROM customer WHERE shop_id=$1`),
      creditEntries: await q(`SELECT customer_id, entry_type, amount, sale_id, due_date, note, created_at FROM credit_entry WHERE shop_id=$1 ORDER BY id`),
      suppliers: await q(`SELECT id, name, phone, email, payment_terms_days, return_terms FROM supplier WHERE shop_id=$1`),
      supplierLedger: await q(`SELECT supplier_id, entry_type, amount, ref_type, ref_id, created_at FROM supplier_ledger WHERE shop_id=$1 ORDER BY id`),
      purchases: await q(`SELECT id, number, supplier_id, supplier_invoice_no, total, created_at FROM purchase WHERE shop_id=$1`),
      sales: await q(`SELECT id, invoice_no, branch_id, cashier_id, customer_id, subtotal, bill_discount, total, created_at FROM sale WHERE shop_id=$1 ORDER BY created_at`),
      saleLines: await q(`SELECT sale_id, product_id, unit, qty_unit, price_charged, discount, line_total FROM sale_line WHERE shop_id=$1`),
      payments: await q(`SELECT sale_id, kind, method, amount, reference, created_at FROM payment WHERE shop_id=$1`),
      returns: await q(`SELECT id, number, sale_id, total, created_at FROM sales_return WHERE shop_id=$1`),
      cheques: await q(`SELECT direction, cheque_no, cheque_date, amount, status FROM cheque WHERE shop_id=$1`),
    };
  }
}

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });

@Controller()
export class ShopBillingController {
  constructor(private readonly db: Db, private readonly billing: PlatformBillingService, private readonly exporter: ExportService, private readonly audit: AuditService) {}

  /** Read-only view of the shop's own platform invoices. */
  @AllowWhenRestricted()
  @Get('billing/invoices')
  @RequirePermission('shop.settings')
  invoices(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), (tx) => this.billing.list(tx, { shopId: s.shopId }));
  }

  /** Available even when the subscription is restricted or cancelled (data portability). */
  @AllowWhenRestricted()
  @Get('export')
  @RequirePermission('shop.settings')
  @Header('Content-Disposition', 'attachment; filename="shop-export.json"')
  async export(@CurrentTenant() s: TenantSession) {
    return this.db.tenant(ctx(s), async (tx) => {
      await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'shop.exported', entity: 'shop', entityId: s.shopId });
      return this.exporter.exportShop(tx, s.shopId);
    });
  }
}

@PlatformOnly()
@Controller('admin')
export class AdminBillingController {
  constructor(private readonly db: Db, private readonly billing: PlatformBillingService, private readonly lifecycle: SubscriptionLifecycleService) {}

  @Post('shops/:id/invoices')
  createInvoice(@CurrentSession() a: PlatformSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ period: z.enum(['monthly', 'annual']).optional() }), body ?? {});
    return this.db.platform((tx) => this.billing.createInvoice(tx, a.adminId, id, b.period), id);
  }

  @Get('invoices')
  list(@Query('shopId') shopId?: string, @Query('status') status?: string) {
    return this.db.platform((tx) => this.billing.list(tx, { shopId, status }));
  }

  @Post('invoices/:id/payments')
  pay(@CurrentSession() a: PlatformSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ amount: positiveDecimal, method: z.string().min(1), reference: z.string().optional() }), body);
    return this.db.platform((tx) => this.billing.recordPayment(tx, a.adminId, id, b));
  }

  /** Runs the daily lifecycle now (also scheduled by the worker). */
  @Post('subscriptions/run-lifecycle')
  @HttpCode(200)
  run() {
    return this.lifecycle.run(this.db);
  }

  @Get('analytics')
  async analytics() {
    return (await this.db.platform((tx) => tx.query(`SELECT platform_stats() AS s`))).rows[0].s;
  }

  /** Queue and event health for the platform team. */
  @Get('system-health')
  health() {
    return this.db.platform(async (tx) => ({
      jobs: Object.fromEntries((await tx.query(`SELECT status, count(*)::int c FROM job GROUP BY status`)).rows.map((r) => [r.status, r.c])),
      deadJobs: (await tx.query(`SELECT id, type, last_error, created_at FROM job WHERE status='dead' ORDER BY id DESC LIMIT 20`)).rows,
      oldestQueuedSeconds: (await tx.query(`SELECT coalesce(extract(epoch FROM now() - min(run_at))::int, 0) AS s FROM job WHERE status='queued' AND run_at <= now()`)).rows[0].s,
      outboxBacklog: (await tx.query(`SELECT count(*)::int c FROM outbox_event WHERE processed_at IS NULL`)).rows[0].c,
    }));
  }
}

@Module({
  imports: [InventoryModule],
  controllers: [ShopBillingController, AdminBillingController],
  providers: [PlatformBillingService, SubscriptionLifecycleService, ExportService],
  exports: [PlatformBillingService, SubscriptionLifecycleService, ExportService],
})
export class BillingModule implements OnModuleInit {
  constructor(private readonly jobs: JobQueue, private readonly lifecycle: SubscriptionLifecycleService) {}

  onModuleInit() {
    this.jobs.register('subscription.lifecycle', async (_j, db: Db) => void (await this.lifecycle.run(db)));
  }
}
