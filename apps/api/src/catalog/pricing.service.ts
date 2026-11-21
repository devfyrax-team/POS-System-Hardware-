import { Injectable } from '@nestjs/common';
import { D, roundCost } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { FeatureService } from '../platform/feature.service';

export type Tier = 'retail' | 'wholesale' | 'contractor';

@Injectable()
export class PricingService {
  constructor(private readonly audit: AuditService, private readonly features: FeatureService) {}

  /**
   * The owner can change a price whenever they like. It applies to the next sale whichever batch the stock
   * came from. History is recorded for reporting only; nothing is blocked or approved.
   */
  async setPrice(tx: Tx, s: TenantSession, input: { productId: string; unitId?: string; tier?: Tier; price: string }) {
    const tier = input.tier ?? 'retail';
    if (tier !== 'retail') await this.features.require(tx, s.shopId, 'price_tiers');
    if (!D(input.price).gte(0)) throw E.validation('Price must not be negative');
    const unit = (
      await tx.query(
        `SELECT id FROM product_unit WHERE shop_id=$1 AND product_id=$2 AND ($3::uuid IS NULL AND is_base OR id=$3)`,
        [s.shopId, input.productId, input.unitId ?? null],
      )
    ).rows[0];
    if (!unit) throw E.notFound('Product unit');
    const old = (await tx.query(`SELECT price FROM product_price WHERE product_id=$1 AND unit_id=$2 AND tier=$3`, [input.productId, unit.id, tier])).rows[0];
    if (old && D(old.price).equals(input.price)) return { changed: false, price: old.price };
    await tx.query(
      `INSERT INTO product_price(shop_id, product_id, unit_id, tier, price) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (product_id, unit_id, tier) DO UPDATE SET price=EXCLUDED.price, updated_at=now()`,
      [s.shopId, input.productId, unit.id, tier, input.price],
    );
    await tx.query(
      `INSERT INTO price_history(shop_id, product_id, unit_id, tier, old_price, new_price, changed_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [s.shopId, input.productId, unit.id, tier, old?.price ?? null, input.price, s.userId],
    );
    await this.audit.record(tx, {
      shopId: s.shopId, actorId: s.userId, terminalId: s.terminalId ?? null, action: 'price.changed', entity: 'product', entityId: input.productId,
      old: old ? { price: old.price, tier } : null, new: { price: input.price, tier },
    });
    return { changed: true, price: input.price };
  }

  /** Price-grid screen: many rows at once (selling price and optional purchase cost). */
  async bulkSetPrices(tx: Tx, s: TenantSession, rows: { sku?: string; productId?: string; price?: string; cost?: string }[]) {
    let updated = 0;
    for (const r of rows) {
      const p = (
        await tx.query(`SELECT id FROM product WHERE shop_id=$1 AND (($2::uuid IS NOT NULL AND id=$2) OR ($2::uuid IS NULL AND sku=$3))`, [s.shopId, r.productId ?? null, r.sku ?? null])
      ).rows[0];
      if (!p) throw E.notFound(`Product ${r.sku ?? r.productId}`);
      if (r.price !== undefined) {
        const res = await this.setPrice(tx, s, { productId: p.id, price: r.price });
        if (res.changed) updated++;
      }
      if (r.cost !== undefined) {
        await tx.query(`UPDATE product SET last_cost=$3 WHERE shop_id=$1 AND id=$2`, [s.shopId, p.id, roundCost(r.cost).toString()]);
        updated++;
      }
    }
    return { updated };
  }

  /** Explicit price for (unit, tier) -> retail price for the unit -> base-unit retail price x factor. */
  async resolve(tx: Tx, shopId: string, productId: string, unitId: string, tier: Tier = 'retail'): Promise<{ price: string; source: 'tier' | 'unit' | 'derived' } | null> {
    const q = async (unit: string, t: string) =>
      (await tx.query(`SELECT price FROM product_price WHERE shop_id=$1 AND product_id=$2 AND unit_id=$3 AND tier=$4`, [shopId, productId, unit, t])).rows[0]?.price as string | undefined;
    const exact = await q(unitId, tier);
    if (exact !== undefined) return { price: exact, source: 'tier' };
    if (tier !== 'retail') {
      const retail = await q(unitId, 'retail');
      if (retail !== undefined) return { price: retail, source: 'unit' };
    }
    const base = (await tx.query(`SELECT id, factor FROM product_unit WHERE shop_id=$1 AND product_id=$2 AND is_base`, [shopId, productId])).rows[0];
    const unit = (await tx.query(`SELECT factor FROM product_unit WHERE shop_id=$1 AND id=$2`, [shopId, unitId])).rows[0];
    if (!base || !unit) return null;
    const basePrice = await q(base.id, 'retail');
    if (basePrice === undefined) return null;
    return { price: D(basePrice).times(unit.factor).toDecimalPlaces(4).toString(), source: 'derived' };
  }

  async history(tx: Tx, shopId: string, productId: string, limit = 50) {
    return (
      await tx.query(
        `SELECT id, unit_id, tier, old_price, new_price, changed_by, created_at FROM price_history WHERE shop_id=$1 AND product_id=$2 ORDER BY id DESC LIMIT $3`,
        [shopId, productId, limit],
      )
    ).rows;
  }
}
