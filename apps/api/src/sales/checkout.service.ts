import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { D, Decimal, lineTotal, roundMoney, sum } from '@pos/money';
import { PaymentMethod } from '@pos/contracts';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { IdempotencyService } from '../common/idempotency.service';
import { TenantSession } from '../common/session';
import { z, decimalStr, nonNegativeDecimal, positiveDecimal } from '../common/validate';
import { AuditService } from '../audit/audit.service';
import { PricingService, Tier } from '../catalog/pricing.service';
import { UnitService } from '../catalog/unit.service';
import { ApprovalService } from '../identity/approval.service';
import { StockService } from '../inventory/stock.service';
import { OutboxService } from '../jobs/outbox.service';
import { CheckoutHooks } from './checkout.hooks';
import { InvoiceNumberService } from './invoice-number.service';

export const cartLineSchema = z.object({
  productId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  unit: z.string().optional(),
  qty: positiveDecimal,
  priceOverride: nonNegativeDecimal.optional(),
  discount: nonNegativeDecimal.optional(), // amount off this line
  batchId: z.string().uuid().optional(),
});

export const checkoutSchema = z.object({
  customerId: z.string().uuid().optional(),
  tier: z.enum(['retail', 'wholesale', 'contractor']).optional(),
  lines: z.array(cartLineSchema).min(1).max(200),
  payments: z
    .array(
      z.object({
        method: z.enum(['cash', 'card', 'bank_transfer', 'cheque', 'credit']),
        amount: positiveDecimal,
        reference: z.string().max(100).optional(),
        cheque: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(10),
  billDiscount: nonNegativeDecimal.optional(),
  approvals: z.record(z.string(), z.string()).optional(), // action -> supervisor override token
  note: z.string().max(300).optional(),
});
export type CartLine = z.infer<typeof cartLineSchema>;
export type CheckoutCmd = z.infer<typeof checkoutSchema> & { idempotencyKey: string };

const DEFAULT_DISCOUNT_LIMIT_PCT = 5;

interface Prepared {
  idx: number;
  productId: string;
  name: string;
  unitId: string;
  unit: string;
  qtyUnit: string;
  qtyBase: string;
  factor: string;
  priceList: Decimal;
  priceCharged: Decimal;
  overridden: boolean;
  discount: Decimal;
  lineTotal: Decimal;
  batchId?: string;
  preferredBatchId?: string;
}

/**
 * The sale. One database transaction saves the sale, lines (with cost), payments, stock decrement and ledger rows.
 * The server recomputes every price and total itself; the till's numbers are only a request.
 * Lock order (deadlock-free): customer row -> stock rows ordered by product id -> this terminal's invoice counter.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly idem: IdempotencyService,
    private readonly pricing: PricingService,
    private readonly units: UnitService,
    private readonly stock: StockService,
    private readonly invoices: InvoiceNumberService,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly hooks: CheckoutHooks,
  ) {}

  async checkout(tx: Tx, s: TenantSession, cmd: CheckoutCmd) {
    if (!s.terminalId || !s.branchId) throw E.validation('Sales must be made on a registered terminal');
    const terminalId = s.terminalId;
    const branchId = s.branchId;
    const perms = s.permissions;
    if (!perms) throw E.forbidden();

    const replay = await this.idem.claim(tx, s.shopId, cmd.idempotencyKey, IdempotencyService.hashRequest(cmd));
    if (replay) return { ...(replay.body as object), replayed: true };

    // 1. customer first (global lock order); also decides the price tier
    let tier: Tier = (cmd.tier as Tier) ?? 'retail';
    if (cmd.customerId) {
      if (!this.hooks.lockCustomer) throw E.validation('Customers are not available for this shop');
      const c = await this.hooks.lockCustomer(tx, s, cmd.customerId);
      if (!cmd.tier) tier = c.tier;
    }
    if (tier !== 'retail' && !s.features?.has('price_tiers')) tier = 'retail'; // tiers are a plan feature

    const settings = (await tx.query(`SELECT settings FROM shop WHERE id=$1`, [s.shopId])).rows[0].settings as Record<string, any>;

    // 2. validate cart and recompute prices (server decides)
    const prepared: Prepared[] = [];
    const approverIds = new Set<string>();
    const needApproval = (action: string): string => {
      const token = cmd.approvals?.[action];
      if (!token) throw E.approvalRequired(action);
      const id = this.approvals.verify(token, s, { action });
      approverIds.add(id);
      return id;
    };

    for (let i = 0; i < cmd.lines.length; i++) {
      const l = cmd.lines[i];
      const p = (await tx.query(`SELECT id, name, status FROM product WHERE shop_id=$1 AND id=$2`, [s.shopId, l.productId])).rows[0];
      if (!p || p.status !== 'active') throw E.validation(`Item ${i + 1} is not available for sale`, { line: i + 1, productId: l.productId });
      const u = await this.units.toBase(tx, s.shopId, l.productId, { unitId: l.unitId, unit: l.unit }, l.qty);
      const listed = await this.pricing.resolve(tx, s.shopId, l.productId, u.unitId, tier);
      let priceList: Decimal;
      let priceCharged: Decimal;
      let overridden = false;
      if (l.priceOverride !== undefined) {
        if (!perms.has('price.override_on_sale') && !settings.cashier_price_override) needApproval('price.override');
        priceCharged = D(l.priceOverride);
        priceList = listed ? D(listed.price) : priceCharged;
        overridden = !priceCharged.equals(priceList);
      } else {
        if (!listed) throw E.validation(`"${p.name}" has no price set`, { line: i + 1, productId: l.productId });
        priceList = D(listed.price);
        priceCharged = priceList;
      }
      const gross = roundMoney(priceCharged.times(l.qty));
      const discount = roundMoney(l.discount ?? 0);
      if (discount.gt(gross)) throw E.validation(`Discount is larger than the line total (item ${i + 1})`);
      prepared.push({
        idx: i, productId: p.id, name: p.name, unitId: u.unitId, unit: u.unit, qtyUnit: u.qtyUnit, qtyBase: u.qtyBase, factor: u.factor,
        priceList, priceCharged, overridden, discount, lineTotal: lineTotal(priceCharged, l.qty, discount), preferredBatchId: l.batchId,
      });
    }

    const subtotal = sum(prepared.map((x) => x.lineTotal));
    const billDiscount = roundMoney(cmd.billDiscount ?? 0);
    if (billDiscount.gt(subtotal)) throw E.validation('Bill discount is larger than the bill');
    const total = subtotal.minus(billDiscount);

    // large-discount rule: role limit (%), above which a supervisor must approve
    const grossBeforeDiscount = sum(prepared.map((x) => roundMoney(x.priceCharged.times(x.qtyUnit))));
    const discountTotal = sum(prepared.map((x) => x.discount)).plus(billDiscount);
    if (discountTotal.gt(0) && !perms.has('discount.large')) {
      const limit = await this.discountLimitPct(tx, s);
      const pct = grossBeforeDiscount.isZero() ? D(0) : discountTotal.div(grossBeforeDiscount).times(100);
      if (pct.gt(limit)) needApproval('discount.large');
    }

    // 3. payments
    const methodSum = (m: PaymentMethod) => sum(cmd.payments.filter((p) => p.method === m).map((p) => p.amount));
    const cashTendered = methodSum('cash');
    const nonCash = sum(cmd.payments.filter((p) => p.method !== 'cash').map((p) => p.amount));
    if (nonCash.gt(total)) throw E.validation('Non-cash payments are more than the bill total');
    const cashNeeded = total.minus(nonCash);
    if (cashTendered.lt(cashNeeded)) throw E.validation('Payments do not cover the bill total', { total: total.toString(), short: cashNeeded.minus(cashTendered).toString() });
    const change = cashTendered.minus(cashNeeded);
    const creditAmount = methodSum('credit');
    if (creditAmount.gt(0) && !cmd.customerId) throw E.validation('Credit needs a customer');
    if (creditAmount.gt(0) && !this.hooks.charge) throw E.validation('Credit sales are not available for this shop');

    // 4. stock: lines in product-id order (no deadlocks); the update is late to keep locks short
    const order = [...prepared].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.idx - b.idx));
    const results = new Map<number, { cogs: Decimal; estimated: boolean; movementId: number; batchId: string | null; batchNo?: string | null; expired?: boolean }>();
    const saleId = randomUUID();
    const shorts: { line: number; productId: string; name: string; requested: string; available: string }[] = [];
    for (const l of order) {
      // batch-tracked items: earliest expiry first unless the cashier chose a batch (may split across batches)
      let allocs: { batchId: string | null; qtyBase: string; batchNo?: string | null; expired?: boolean }[] = [{ batchId: null, qtyBase: l.qtyBase }];
      if (this.hooks.allocateBatch) {
        try {
          const a = await this.hooks.allocateBatch(tx, s, { productId: l.productId, qtyBase: l.qtyBase, preferredBatchId: l.preferredBatchId });
          allocs = a.allocations ?? [{ batchId: a.batchId, qtyBase: l.qtyBase }];
        } catch (e: any) {
          if (e?.code !== 'STOCK_SHORT') throw e;
          shorts.push({ line: l.idx + 1, productId: l.productId, name: l.name, requested: l.qtyBase, available: e.details?.available ?? '0' });
          continue;
        }
      }
      try {
        let cogs = D(0);
        let estimated = false;
        let movementId = 0;
        for (const a of allocs) {
          const whole = allocs.length === 1;
          const r = await this.stock.apply(tx, {
            shopId: s.shopId, branchId, productId: l.productId, type: 'sale', qtyBase: D(a.qtyBase).neg().toString(), batchId: a.batchId,
            unit: whole ? l.unit : undefined, qtyUnit: whole ? l.qtyUnit : undefined, factor: whole ? l.factor : undefined, refType: 'sale', refId: saleId, userId: s.userId,
          });
          cogs = cogs.plus(r.cogs ?? '0');
          estimated = estimated || r.estimated;
          movementId = r.movementId;
        }
        results.set(l.idx, { cogs, estimated, movementId, batchId: allocs[0].batchId, batchNo: allocs[0].batchNo, expired: allocs.some((a) => a.expired) });
      } catch (e: any) {
        if (e?.code !== 'STOCK_SHORT') throw e;
        shorts.push({ line: l.idx + 1, productId: l.productId, name: l.name, requested: l.qtyBase, available: e.details?.available ?? '0' });
      }
    }
    if (shorts.length) throw E.stockShort({ lines: shorts });

    // 5. invoice number (per terminal), then the sale rows
    const inv = await this.invoices.next(tx, s.shopId, terminalId);
    const cogsTotal = sum([...results.values()].map((r) => r.cogs));
    const hasEstimated = [...results.values()].some((r) => r.estimated);
    const approver = approverIds.size ? [...approverIds][0] : null;
    await tx.query(
      `INSERT INTO sale(id, shop_id, branch_id, terminal_id, cashier_id, customer_id, invoice_no, idempotency_key, price_tier, subtotal, bill_discount,
         total, paid, tendered, change_due, cogs_total, has_estimated_cost, approver_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        saleId, s.shopId, branchId, terminalId, s.userId, cmd.customerId ?? null, inv.invoiceNo, cmd.idempotencyKey, tier, subtotal.toString(),
        billDiscount.toString(), total.toString(), cashTendered.minus(change).plus(nonCash).toString(), cashTendered.isZero() ? null : cashTendered.toString(),
        change.toString(), cogsTotal.toString(), hasEstimated, approver, cmd.note ?? null,
      ],
    );

    const lineOut: any[] = [];
    for (const l of prepared) {
      const r = results.get(l.idx)!;
      const belowCost = l.lineTotal.lt(r.cogs);
      const row = (
        await tx.query(
          `INSERT INTO sale_line(shop_id, sale_id, line_no, product_id, unit_id, unit, qty_unit, qty_base, factor, price_list, price_charged, price_overridden,
             discount, line_total, cogs, cost_estimated, below_cost, batch_id, movement_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
          [
            s.shopId, saleId, l.idx + 1, l.productId, l.unitId, l.unit, l.qtyUnit, l.qtyBase, l.factor, l.priceList.toString(), l.priceCharged.toString(),
            l.overridden, l.discount.toString(), l.lineTotal.toString(), r.cogs.toString(), r.estimated, belowCost, r.batchId, r.movementId,
          ],
        )
      ).rows[0];
      lineOut.push({
        lineId: row.id, lineNo: l.idx + 1, productId: l.productId, name: l.name, qty: l.qtyUnit, unit: l.unit, price: l.priceCharged.toString(),
        discount: l.discount.toString(), lineTotal: l.lineTotal.toString(), belowCost: settings.below_cost_warning === false ? undefined : belowCost || undefined,
        batchNo: r.batchNo ?? undefined, expired: r.expired || undefined,
      });
    }

    const paymentsOut: any[] = [];
    let cashLeft = cashTendered.minus(change); // cash actually applied to the bill (tendered minus change)
    const lastCash = cmd.payments.map((p) => p.method).lastIndexOf('cash');
    for (let pi = 0; pi < cmd.payments.length; pi++) {
      const p = cmd.payments[pi];
      let amount = roundMoney(p.amount);
      if (p.method === 'cash') {
        amount = pi === lastCash ? cashLeft : Decimal.min(roundMoney(p.amount), cashLeft);
        cashLeft = cashLeft.minus(amount);
        if (amount.isZero()) continue;
      }
      await tx.query(
        `INSERT INTO payment(shop_id, branch_id, terminal_id, sale_id, method, amount, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [s.shopId, branchId, terminalId, saleId, p.method, amount.toString(), p.reference ?? null, s.userId],
      );
      paymentsOut.push({ method: p.method, amount: amount.toString(), reference: p.reference });
      if (p.method === 'credit') await this.hooks.charge!(tx, s, { customerId: cmd.customerId!, amount: amount.toString(), saleId, invoiceNo: inv.invoiceNo });
      if (p.method === 'cheque' && this.hooks.cheque) await this.hooks.cheque(tx, s, { saleId, amount: amount.toString(), reference: p.reference, customerId: cmd.customerId, details: p.cheque });
    }

    await this.audit.record(tx, {
      shopId: s.shopId, actorId: s.userId, approverId: approver, terminalId, action: 'sale.completed', entity: 'sale', entityId: saleId,
      new: { invoiceNo: inv.invoiceNo, total: total.toString(), lines: prepared.length },
    });
    await this.outbox.publish(tx, s.shopId, 'sale.completed', { saleId, branchId, total: total.toString() });

    const body = {
      saleId, invoiceNo: inv.invoiceNo, total: total.toString(), subtotal: subtotal.toString(), billDiscount: billDiscount.toString(),
      paid: total.toString(), tendered: cashTendered.isZero() ? undefined : cashTendered.toString(), change: change.toString(),
      lines: lineOut, payments: paymentsOut, replayed: false,
    };
    await this.idem.complete(tx, s.shopId, cmd.idempotencyKey, 201, body);
    return body;
  }

  /** Highest "max discount %" among the user's roles at this branch (default 5%). */
  private async discountLimitPct(tx: Tx, s: TenantSession): Promise<Decimal> {
    const r = (
      await tx.query(
        `SELECT max((r.approval_limits->>'maxDiscountPct')::numeric) AS m FROM user_branch_role ubr
         JOIN role r ON r.shop_id=ubr.shop_id AND r.id=ubr.role_id
         WHERE ubr.shop_id=$1 AND ubr.user_id=$2 AND (ubr.branch_id IS NULL OR ubr.branch_id=$3)`,
        [s.shopId, s.userId, s.branchId],
      )
    ).rows[0];
    return r?.m === null || r?.m === undefined ? D(DEFAULT_DISCOUNT_LIMIT_PCT) : D(r.m);
  }
}

export { decimalStr };
