import { Injectable } from '@nestjs/common';
import { D } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { nextCounter } from '../common/counter';
import { TenantSession } from '../common/session';
import { z, decimalStr, nonNegativeDecimal } from '../common/validate';
import { AuditService } from '../audit/audit.service';
import { FeatureService } from '../platform/feature.service';
import { LimitService } from '../platform/limit.service';

export const productInput = z.object({
  name: z.string().min(1).max(200),
  nameSi: z.string().max(200).optional(),
  altNames: z.array(z.string().max(100)).max(10).optional(),
  category: z.string().max(100).optional(),
  brand: z.string().max(100).optional(),
  size: z.string().max(60).optional(),
  baseUnit: z.string().min(1).max(20),
  decimalQty: z.boolean().optional(),
  trackBatches: z.boolean().optional(),
  shelfLifeDays: z.number().int().positive().optional(),
  minLevel: nonNegativeDecimal.optional(),
  shortCode: z.string().regex(/^[A-Za-z0-9]{1,12}$/).optional(),
  barcode: z.string().min(3).max(64).optional(),
  units: z.array(z.object({ unit: z.string().min(1).max(20), factor: decimalStr })).max(10).optional(),
  price: nonNegativeDecimal.optional(), // retail price per base unit
  lastCost: nonNegativeDecimal.optional(),
  favourite: z.boolean().optional(),
  needsReview: z.boolean().optional(),
  masterProductId: z.string().uuid().optional(),
  masterVariantId: z.string().uuid().optional(),
});
export type ProductInput = z.infer<typeof productInput>;

const COLS = `id, sku, short_code, name, name_si, alt_names, category, brand, size, base_unit, decimal_qty, track_batches,
  shelf_life_days, min_level, status, needs_review, favourite, version, master_product_id, master_variant_id, created_at`;

@Injectable()
export class ProductService {
  constructor(
    private readonly audit: AuditService,
    private readonly features: FeatureService,
    private readonly limits: LimitService,
  ) {
    this.limits.register('max_products', async (tx, shopId) =>
      (await tx.query(`SELECT count(*)::int c FROM product WHERE shop_id=$1 AND status='active'`, [shopId])).rows[0].c,
    );
  }

  /** Internal: insert product + base unit + extra units + optional retail price/barcode. Caller checks limits. */
  private async insert(tx: Tx, s: TenantSession, p: ProductInput) {
    if (p.trackBatches) await this.features.require(tx, s.shopId, 'batch_expiry');
    const n = await nextCounter(tx, s.shopId, 'sku');
    const sku = `SKU-${String(n).padStart(6, '0')}`;
    let shortCode = p.shortCode?.toUpperCase();
    if (!shortCode) {
      const letter = (p.name.match(/[A-Za-z]/)?.[0] ?? 'X').toUpperCase();
      shortCode = `${letter}${await nextCounter(tx, s.shopId, `short_${letter}`)}`;
    }
    let row;
    try {
      row = (
        await tx.query(
          `INSERT INTO product(shop_id, sku, short_code, name, name_si, alt_names, category, brand, size, base_unit, decimal_qty,
             track_batches, shelf_life_days, min_level, last_cost, favourite, needs_review, master_product_id, master_variant_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING ${COLS}`,
          [
            s.shopId, sku, shortCode, p.name, p.nameSi ?? null, p.altNames ?? [], p.category ?? null, p.brand ?? null, p.size ?? null,
            p.baseUnit, p.decimalQty ?? false, p.trackBatches ?? false, p.shelfLifeDays ?? null, p.minLevel ?? '0', p.lastCost ?? null,
            p.favourite ?? false, p.needsReview ?? false, p.masterProductId ?? null, p.masterVariantId ?? null,
          ],
        )
      ).rows[0];
    } catch (e: any) {
      if (e.code === '23505') {
        if (String(e.constraint).includes('master')) throw E.conflict('This catalog product is already in your shop');
        throw E.conflict('SKU or short code already exists');
      }
      throw e;
    }
    const base = (
      await tx.query(`INSERT INTO product_unit(shop_id, product_id, unit, factor, is_base) VALUES ($1,$2,$3,1,true) RETURNING id`, [s.shopId, row.id, p.baseUnit])
    ).rows[0];
    for (const u of p.units ?? []) {
      if (u.unit.toLowerCase() === p.baseUnit.toLowerCase()) continue;
      if (!D(u.factor).gt(0)) throw E.validation(`Factor for ${u.unit} must be positive`);
      await tx.query(`INSERT INTO product_unit(shop_id, product_id, unit, factor) VALUES ($1,$2,$3,$4)`, [s.shopId, row.id, u.unit, u.factor]);
    }
    if (p.price !== undefined) {
      await tx.query(`INSERT INTO product_price(shop_id, product_id, unit_id, tier, price) VALUES ($1,$2,$3,'retail',$4)`, [s.shopId, row.id, base.id, p.price]);
      await tx.query(`INSERT INTO price_history(shop_id, product_id, unit_id, tier, old_price, new_price, changed_by) VALUES ($1,$2,$3,'retail',NULL,$4,$5)`, [s.shopId, row.id, base.id, p.price, s.userId]);
    }
    if (p.barcode) {
      try {
        await tx.query(`INSERT INTO product_barcode(shop_id, product_id, unit_id, code) VALUES ($1,$2,$3,$4)`, [s.shopId, row.id, base.id, p.barcode]);
      } catch (e: any) {
        if (e.code === '23505') throw E.conflict(`Barcode ${p.barcode} is already used by another item`);
        throw e;
      }
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'product.created', entity: 'product', entityId: row.id, new: { sku, name: p.name } });
    return row;
  }

  async create(tx: Tx, s: TenantSession, p: ProductInput) {
    await this.limits.check(tx, s.shopId, 'max_products');
    return this.insert(tx, s, p);
  }

  /** Created at the till in seconds (name, unit, price) and flagged for review. */
  async quickAdd(tx: Tx, s: TenantSession, input: { name: string; unit: string; price: string }) {
    return this.create(tx, s, { name: input.name, baseUnit: input.unit, price: input.price, needsReview: true });
  }

  async createFromMaster(tx: Tx, s: TenantSession, input: { masterProductId: string; variantId?: string; price?: string; minLevel?: string }) {
    const m = (await tx.query(`SELECT * FROM master_product WHERE id=$1 AND status='approved'`, [input.masterProductId])).rows[0];
    if (!m) throw E.notFound('Catalog product');
    let name = m.name_en;
    let barcode = m.barcode ?? undefined;
    if (input.variantId) {
      const v = (await tx.query(`SELECT label, barcode FROM master_variant WHERE id=$1 AND master_product_id=$2`, [input.variantId, m.id])).rows[0];
      if (!v) throw E.notFound('Variant');
      name = `${m.name_en} - ${v.label}`;
      barcode = v.barcode ?? undefined;
    }
    const cat = m.category_id ? (await tx.query(`SELECT name FROM master_category WHERE id=$1`, [m.category_id])).rows[0]?.name : undefined;
    // manufacturer barcode may already be used by a custom item in this shop: skip silently rather than fail the selection
    if (barcode && (await tx.query(`SELECT 1 FROM product_barcode WHERE shop_id=$1 AND code=$2`, [s.shopId, barcode])).rowCount) barcode = undefined;
    return this.create(tx, s, {
      name, nameSi: m.name_si ?? undefined, altNames: m.alt_names, category: cat, brand: m.brand ?? undefined, size: m.size ?? undefined,
      baseUnit: m.base_unit, decimalQty: m.decimal_qty, price: input.price, minLevel: input.minLevel, barcode,
      masterProductId: m.id, masterVariantId: input.variantId,
    });
  }

  /** Tick categories, untick items: bulk-create shop products from the master catalog. Existing ones are skipped. */
  async bulkSelectFromMaster(tx: Tx, s: TenantSession, input: { categoryIds: string[]; excludeMasterIds?: string[] }) {
    const shopType = (await tx.query(`SELECT shop_type FROM shop WHERE id=$1`, [s.shopId])).rows[0].shop_type;
    const rows = (
      await tx.query(
        `SELECT m.id FROM master_product m JOIN master_category c ON c.id = m.category_id
         WHERE m.status='approved' AND m.category_id = ANY($1) AND ($2 = 'both' OR c.shop_type IN ('both', $2))
           AND NOT (m.id = ANY($3))
           AND NOT EXISTS (SELECT 1 FROM product p WHERE p.shop_id=$4 AND p.master_product_id = m.id)
         ORDER BY m.name_en`,
        [input.categoryIds, shopType, input.excludeMasterIds ?? [], s.shopId],
      )
    ).rows;
    await this.limits.check(tx, s.shopId, 'max_products', rows.length);
    let created = 0;
    for (const r of rows) {
      const m = (await tx.query(`SELECT * FROM master_product WHERE id=$1`, [r.id])).rows[0];
      const cat = m.category_id ? (await tx.query(`SELECT name FROM master_category WHERE id=$1`, [m.category_id])).rows[0]?.name : undefined;
      await this.insert(tx, s, {
        name: m.name_en, nameSi: m.name_si ?? undefined, altNames: m.alt_names, category: cat, brand: m.brand ?? undefined, size: m.size ?? undefined,
        baseUnit: m.base_unit, decimalQty: m.decimal_qty, masterProductId: m.id,
      });
      created++;
    }
    return { created };
  }

  async get(tx: Tx, shopId: string, id: string) {
    const p = (await tx.query(`SELECT ${COLS} FROM product WHERE shop_id=$1 AND id=$2`, [shopId, id])).rows[0];
    if (!p) throw E.notFound('Product');
    return p;
  }

  async list(tx: Tx, shopId: string, f: { category?: string; needsReview?: boolean; status?: string; limit?: number; offset?: number } = {}) {
    return (
      await tx.query(
        `SELECT ${COLS} FROM product WHERE shop_id=$1 AND ($2::text IS NULL OR category=$2) AND ($3::boolean IS NULL OR needs_review=$3)
           AND status = coalesce($4,'active') ORDER BY name LIMIT $5 OFFSET $6`,
        [shopId, f.category ?? null, f.needsReview ?? null, f.status ?? null, Math.min(f.limit ?? 100, 500), f.offset ?? 0],
      )
    ).rows;
  }

  /** Optimistic concurrency: a stale edit is rejected with VERSION_CONFLICT. */
  async update(tx: Tx, s: TenantSession, id: string, version: number, patch: Partial<Omit<ProductInput, 'units' | 'price' | 'barcode'>>) {
    if (patch.trackBatches) await this.features.require(tx, s.shopId, 'batch_expiry');
    const old = await this.get(tx, s.shopId, id);
    const r = await tx.query(
      `UPDATE product SET name=coalesce($4,name), name_si=coalesce($5,name_si), alt_names=coalesce($6,alt_names), category=coalesce($7,category),
         brand=coalesce($8,brand), size=coalesce($9,size), track_batches=coalesce($10,track_batches), shelf_life_days=coalesce($11,shelf_life_days),
         min_level=coalesce($12,min_level), favourite=coalesce($13,favourite), needs_review=coalesce($14,needs_review), last_cost=coalesce($15,last_cost),
         version=version+1
       WHERE shop_id=$1 AND id=$2 AND version=$3 RETURNING ${COLS}`,
      [
        s.shopId, id, version, patch.name ?? null, patch.nameSi ?? null, patch.altNames ?? null, patch.category ?? null, patch.brand ?? null,
        patch.size ?? null, patch.trackBatches ?? null, patch.shelfLifeDays ?? null, patch.minLevel ?? null, patch.favourite ?? null,
        patch.needsReview ?? null, patch.lastCost ?? null,
      ],
    );
    if (!r.rowCount) throw E.versionConflict();
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'product.updated', entity: 'product', entityId: id, old: { name: old.name, version: old.version }, new: patch });
    return r.rows[0];
  }

  async setStatus(tx: Tx, s: TenantSession, id: string, status: 'active' | 'inactive') {
    if (status === 'active') await this.limits.check(tx, s.shopId, 'max_products');
    const r = await tx.query(`UPDATE product SET status=$3, version=version+1 WHERE shop_id=$1 AND id=$2 RETURNING ${COLS}`, [s.shopId, id, status]);
    if (!r.rowCount) throw E.notFound('Product');
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: `product.${status === 'active' ? 'activated' : 'deactivated'}`, entity: 'product', entityId: id });
    return r.rows[0];
  }

  /** Minimum stock level at a branch: branch override wins, otherwise the product default. */
  async minLevel(tx: Tx, shopId: string, branchId: string, productId: string): Promise<string> {
    const r = (
      await tx.query(
        `SELECT coalesce(bp.min_level, p.min_level) AS m FROM product p
         LEFT JOIN branch_product bp ON bp.branch_id=$2 AND bp.product_id=p.id
         WHERE p.shop_id=$1 AND p.id=$3`,
        [shopId, branchId, productId],
      )
    ).rows[0];
    if (!r) throw E.notFound('Product');
    return r.m;
  }

  async setBranchMinLevel(tx: Tx, s: TenantSession, branchId: string, productId: string, minLevel: string | null) {
    await this.get(tx, s.shopId, productId);
    await tx.query(
      `INSERT INTO branch_product(shop_id, branch_id, product_id, min_level) VALUES ($1,$2,$3,$4)
       ON CONFLICT (branch_id, product_id) DO UPDATE SET min_level = EXCLUDED.min_level`,
      [s.shopId, branchId, productId, minLevel],
    );
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'product.branch_min_level', entity: 'product', entityId: productId, new: { branchId, minLevel } });
  }
}
