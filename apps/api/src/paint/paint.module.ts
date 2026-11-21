import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { D, Decimal, roundCost, roundQty } from '@pos/money';
import { SalesModule } from '../sales/sales.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ExpiryModule } from '../inventory/expiry.module';
import { CatalogModule } from '../catalog/catalog.module';
import { Db, Tx } from '../db/db';
import { E } from '../common/errors';
import { CurrentTenant, TenantSession } from '../common/session';
import { parse, positiveDecimal, nonNegativeDecimal, z } from '../common/validate';
import { AuditService } from '../audit/audit.service';
import { RequireFeature, RequirePermission } from '../auth/decorators';
import { PricingService } from '../catalog/pricing.service';
import { ProductService } from '../catalog/product.service';
import { BatchService } from '../inventory/batch.service';
import { StockService } from '../inventory/stock.service';

export interface MixInput {
  baseProductId: string;
  baseQty: string; // in the base paint's base unit (litres)
  colourCode: string;
  colourName?: string;
  colorants: { productId: string; ml: string }[]; // total ml for the whole mix
  customerId?: string;
  price?: string; // selling price of the tinted paint per base unit; defaults to the base paint price
  preferredBatchId?: string; // so one job can use tins of one batch (colour match)
  saveFormula?: boolean;
}

/**
 * Colour tinting. A mixing transaction CONSUMES base paint and colorant (ml) and PRODUCES a tinted tin to sell.
 * Everything happens in one transaction: if any colorant is short, the base paint is not touched either.
 * Tinted paint is non-returnable. The colour code and formula are saved against the customer for reorders.
 */
@Injectable()
export class TintService {
  constructor(
    private readonly stock: StockService,
    private readonly batches: BatchService,
    private readonly products: ProductService,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  async mix(tx: Tx, s: TenantSession, i: MixInput) {
    if (!s.branchId) throw E.validation('Mixing happens at a branch: choose one first');
    const branchId = s.branchId;
    const qty = D(i.baseQty);
    if (!qty.gt(0)) throw E.validation('Quantity must be positive');
    if (!i.colorants.length) throw E.validation('A tint needs at least one colorant');
    if (!i.colourCode.trim()) throw E.validation('Colour code is required');
    const base = (await tx.query(`SELECT id, name, base_unit, decimal_qty, category, brand, size FROM product WHERE shop_id=$1 AND id=$2 AND status='active'`, [s.shopId, i.baseProductId])).rows[0];
    if (!base) throw E.notFound('Base paint');
    if (!base.decimal_qty && !qty.isInteger()) throw E.validation('This base paint is sold in whole units');
    const colourCode = i.colourCode.trim().toUpperCase();

    // lock order: all consumed products by id, like checkout
    const merged = new Map<string, Decimal>();
    for (const c of i.colorants) {
      if (!D(c.ml).gt(0)) throw E.validation('Colorant amounts must be positive');
      merged.set(c.productId, (merged.get(c.productId) ?? D(0)).plus(c.ml));
    }
    const consume: { productId: string; qtyBase: Decimal; isBase: boolean }[] = [
      { productId: base.id, qtyBase: qty, isBase: true },
      ...[...merged.entries()].map(([productId, ml]) => ({ productId, qtyBase: ml, isBase: false })),
    ].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

    let total = D(0);
    const colorantOut: { productId: string; ml: string; cost: string }[] = [];
    for (const c of consume) {
      const p = (await tx.query(`SELECT name FROM product WHERE shop_id=$1 AND id=$2 AND status='active'`, [s.shopId, c.productId])).rows[0];
      if (!p) throw E.notFound('Colorant product');
      const plan = await this.batches.plan(tx, s.shopId, branchId, c.productId, c.qtyBase.toString(), c.isBase ? i.preferredBatchId : undefined);
      let cost = D(0);
      for (const a of plan) {
        const r = await this.stock.apply(tx, {
          shopId: s.shopId, branchId, productId: c.productId, type: 'tint_out', qtyBase: D(a.qtyBase).neg().toString(), batchId: a.batchId,
          refType: 'tint', refId: colourCode, reason: `tint ${colourCode}`, userId: s.userId,
        });
        cost = cost.plus(r.cogs ?? '0');
      }
      total = total.plus(cost);
      if (!c.isBase) colorantOut.push({ productId: c.productId, ml: c.qtyBase.toString(), cost: cost.toString() });
    }

    // the tinted tin: a product of its own (non-returnable), reused for the same base paint + colour
    const tintedName = `${base.name} - ${colourCode}${i.colourName ? ` (${i.colourName})` : ''}`;
    let tinted = (await tx.query(`SELECT id, sku FROM product WHERE shop_id=$1 AND lower(name)=lower($2)`, [s.shopId, tintedName])).rows[0];
    if (!tinted) {
      let price = i.price;
      if (price === undefined) {
        const bu = (await tx.query(`SELECT id FROM product_unit WHERE shop_id=$1 AND product_id=$2 AND is_base`, [s.shopId, base.id])).rows[0];
        price = (await this.pricing.resolve(tx, s.shopId, base.id, bu.id, 'retail'))?.price;
      }
      tinted = await this.products.create(tx, s, { name: tintedName, baseUnit: base.base_unit, decimalQty: base.decimal_qty, category: base.category ?? undefined, brand: base.brand ?? undefined, size: base.size ?? undefined, price });
      await tx.query(`UPDATE product SET non_returnable = true WHERE shop_id=$1 AND id=$2`, [s.shopId, tinted.id]);
    } else if (i.price !== undefined) {
      await this.pricing.setPrice(tx, s, { productId: tinted.id, price: i.price });
    }
    const unitCost = roundCost(total.div(qty));
    await this.stock.apply(tx, {
      shopId: s.shopId, branchId, productId: tinted.id, type: 'tint_in', qtyBase: qty.toString(), unitCost: unitCost.toString(),
      refType: 'tint', refId: colourCode, reason: `tinted ${colourCode}`, userId: s.userId,
    });

    let formulaId: string | null = null;
    if (i.saveFormula !== false) {
      const per = colorantOut.map((c) => ({ productId: c.productId, mlPerUnit: roundQty(D(c.ml).div(qty)).toString() }));
      formulaId = (
        await tx.query(
          `INSERT INTO tint_formula(shop_id, customer_id, colour_code, colour_name, base_product_id, colorants, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (shop_id, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid), upper(colour_code), base_product_id)
           DO UPDATE SET colorants=EXCLUDED.colorants, colour_name=coalesce(EXCLUDED.colour_name, tint_formula.colour_name), updated_at=now() RETURNING id`,
          [s.shopId, i.customerId ?? null, colourCode, i.colourName ?? null, base.id, JSON.stringify(per), s.userId],
        )
      ).rows[0].id;
    }
    const job = (
      await tx.query(
        `INSERT INTO tint_job(shop_id, branch_id, customer_id, formula_id, base_product_id, tinted_product_id, colour_code, base_qty, colorants, total_cost, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [s.shopId, branchId, i.customerId ?? null, formulaId, base.id, tinted.id, colourCode, qty.toString(), JSON.stringify(colorantOut), total.toString(), s.userId],
      )
    ).rows[0];
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'tint.mixed', entity: 'tint_job', entityId: job.id, new: { colourCode, qty: qty.toString(), base: base.name } });
    return { jobId: job.id as string, tintedProductId: tinted.id as string, sku: tinted.sku as string, name: tintedName, qty: qty.toString(), unitCost: unitCost.toString() };
  }

  /** Reorder a customer's colour: the saved formula is scaled to the new quantity. */
  async reorder(tx: Tx, s: TenantSession, i: { customerId: string; colourCode: string; baseQty: string; baseProductId?: string; preferredBatchId?: string }) {
    const f = (
      await tx.query(
        `SELECT id, colour_name, base_product_id, colorants FROM tint_formula WHERE shop_id=$1 AND customer_id=$2 AND upper(colour_code)=upper($3) AND ($4::uuid IS NULL OR base_product_id=$4)
         ORDER BY updated_at DESC LIMIT 1`,
        [s.shopId, i.customerId, i.colourCode, i.baseProductId ?? null],
      )
    ).rows[0];
    if (!f) throw E.notFound('Saved formula for this customer and colour');
    return this.mix(tx, s, {
      baseProductId: f.base_product_id, baseQty: i.baseQty, colourCode: i.colourCode, colourName: f.colour_name ?? undefined, customerId: i.customerId,
      preferredBatchId: i.preferredBatchId,
      colorants: (f.colorants as { productId: string; mlPerUnit: string }[]).map((c) => ({ productId: c.productId, ml: D(c.mlPerUnit).times(i.baseQty).toDecimalPlaces(4).toString() })),
    });
  }

  async formulas(tx: Tx, shopId: string, customerId: string) {
    return (
      await tx.query(
        `SELECT f.id, f.colour_code, f.colour_name, f.base_product_id, p.name AS base_name, f.colorants, f.updated_at
         FROM tint_formula f JOIN product p ON p.shop_id=f.shop_id AND p.id=f.base_product_id WHERE f.shop_id=$1 AND f.customer_id=$2 ORDER BY f.updated_at DESC`,
        [shopId, customerId],
      )
    ).rows;
  }

  async jobs(tx: Tx, shopId: string, customerId?: string) {
    return (
      await tx.query(
        `SELECT j.id, j.colour_code, j.base_qty, j.customer_id, j.created_at, p.name AS tinted_name FROM tint_job j JOIN product p ON p.shop_id=j.shop_id AND p.id=j.tinted_product_id
         WHERE j.shop_id=$1 AND ($2::uuid IS NULL OR j.customer_id=$2) ORDER BY j.created_at DESC LIMIT 100`,
        [shopId, customerId ?? null],
      )
    ).rows;
  }
}

/** Dented tins: kept apart as damaged stock, then re-listed under a discounted "[DAMAGED]" item to sell. */
@Injectable()
export class DamagedStockService {
  constructor(private readonly stock: StockService, private readonly products: ProductService, private readonly audit: AuditService) {}

  async list(tx: Tx, shopId: string, branchId?: string) {
    return (
      await tx.query(
        `SELECT sb.branch_id, sb.product_id, p.name, p.sku, sb.damaged_qty FROM stock_balance sb JOIN product p ON p.shop_id=sb.shop_id AND p.id=sb.product_id
         WHERE sb.shop_id=$1 AND sb.damaged_qty > 0 AND ($2::uuid IS NULL OR sb.branch_id=$2) ORDER BY p.name`,
        [shopId, branchId ?? null],
      )
    ).rows;
  }

  async relist(tx: Tx, s: TenantSession, i: { productId: string; qty: string; price: string }) {
    if (!s.branchId) throw E.validation('Choose a branch first');
    const qty = D(i.qty);
    if (!qty.gt(0)) throw E.validation('Quantity must be positive');
    const p = (await tx.query(`SELECT name, base_unit, decimal_qty, category, brand, size, last_cost FROM product WHERE shop_id=$1 AND id=$2`, [s.shopId, i.productId])).rows[0];
    if (!p) throw E.notFound('Product');
    const took = await tx.query(`UPDATE stock_balance SET damaged_qty = damaged_qty - $4 WHERE shop_id=$1 AND branch_id=$2 AND product_id=$3 AND damaged_qty >= $4 RETURNING damaged_qty`, [s.shopId, s.branchId, i.productId, i.qty]);
    if (!took.rowCount) throw E.validation('Not enough damaged stock to re-list');
    const name = `${p.name} [DAMAGED]`;
    let item = (await tx.query(`SELECT id, sku FROM product WHERE shop_id=$1 AND lower(name)=lower($2)`, [s.shopId, name])).rows[0];
    if (!item) item = await this.products.create(tx, s, { name, baseUnit: p.base_unit, decimalQty: p.decimal_qty, category: p.category ?? undefined, brand: p.brand ?? undefined, size: p.size ?? undefined, price: i.price });
    else await tx.query(`UPDATE product_price SET price=$3, updated_at=now() WHERE shop_id=$1 AND product_id=$2`, [s.shopId, item.id, i.price]);
    await this.stock.apply(tx, {
      shopId: s.shopId, branchId: s.branchId, productId: item.id, type: 'adjustment', qtyBase: qty.toString(), unitCost: p.last_cost ?? null,
      refType: 'damaged_relist', refId: i.productId, reason: 'damaged stock re-listed at a discount', userId: s.userId,
    });
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'damaged.relisted', entity: 'product', entityId: i.productId, new: { qty: i.qty, price: i.price, itemId: item.id } });
    return { productId: item.id as string, sku: item.sku as string, name, qty: qty.toString() };
  }
}

const ctx = (s: TenantSession) => ({ shopId: s.shopId, userId: s.userId });
const mixShape = z.object({
  baseProductId: z.string().uuid(), baseQty: positiveDecimal, colourCode: z.string().min(1).max(30), colourName: z.string().max(60).optional(),
  colorants: z.array(z.object({ productId: z.string().uuid(), ml: positiveDecimal })).min(1).max(12), customerId: z.string().uuid().optional(),
  price: nonNegativeDecimal.optional(), preferredBatchId: z.string().uuid().optional(), saveFormula: z.boolean().optional(),
});

@RequireFeature('colour_tinting')
@Controller('tint')
export class TintController {
  constructor(private readonly db: Db, private readonly tint: TintService) {}

  @Post('mix')
  @RequirePermission('tint.mix')
  mix(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    return this.db.tenant(ctx(s), (tx) => this.tint.mix(tx, s, parse(mixShape, body)));
  }

  @Post('reorder')
  @RequirePermission('tint.mix')
  reorder(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ customerId: z.string().uuid(), colourCode: z.string().min(1), baseQty: positiveDecimal, baseProductId: z.string().uuid().optional(), preferredBatchId: z.string().uuid().optional() }), body);
    return this.db.tenant(ctx(s), (tx) => this.tint.reorder(tx, s, b));
  }

  @Get('formulas/:customerId')
  @RequirePermission('tint.mix')
  formulas(@CurrentTenant() s: TenantSession, @Param('customerId') id: string) {
    return this.db.tenant(ctx(s), (tx) => this.tint.formulas(tx, s.shopId, id));
  }

  @Get('jobs')
  @RequirePermission('tint.mix')
  jobs(@CurrentTenant() s: TenantSession, @Query('customerId') customerId?: string) {
    return this.db.tenant(ctx(s), (tx) => this.tint.jobs(tx, s.shopId, customerId));
  }
}

@Controller('damaged-stock')
export class DamagedStockController {
  constructor(private readonly db: Db, private readonly damaged: DamagedStockService) {}

  @Get()
  @RequirePermission('stock.count')
  list(@CurrentTenant() s: TenantSession, @Query('branchId') branchId?: string) {
    return this.db.tenant(ctx(s), (tx) => this.damaged.list(tx, s.shopId, branchId ?? s.branchId));
  }

  @Post('relist')
  @HttpCode(200)
  @RequirePermission('stock.adjust')
  relist(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ productId: z.string().uuid(), qty: positiveDecimal, price: nonNegativeDecimal }), body);
    return this.db.tenant(ctx(s), (tx) => this.damaged.relist(tx, s, b));
  }
}

@Module({
  imports: [SalesModule, InventoryModule, ExpiryModule, CatalogModule],
  controllers: [TintController, DamagedStockController],
  providers: [TintService, DamagedStockService],
  exports: [TintService, DamagedStockService],
})
export class PaintModule {}
