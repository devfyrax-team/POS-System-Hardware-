import { Injectable } from '@nestjs/common';
import { FEATURE_SHOP_TYPES, FeatureKey, LimitKey, ShopType } from '@pos/contracts';
import { Tx } from '../db/db';
import { E } from '../common/errors';

export interface Resolved {
  shopType: ShopType;
  shopStatus: 'active' | 'suspended';
  subscriptionStatus: string;
  planCode: string;
  features: Set<FeatureKey>;
  limits: Partial<Record<LimitKey, number | null>>; // missing/null = unlimited
}

/**
 * effective feature = shop override (if present and unexpired) else plan feature,
 * then filtered by what the shop type allows.
 */
@Injectable()
export class FeatureService {
  async resolve(tx: Tx, shopId: string): Promise<Resolved> {
    const shop = (await tx.query(`SELECT shop_type, status FROM shop WHERE id=$1`, [shopId])).rows[0];
    if (!shop) throw E.notFound('Shop');
    const sub = (
      await tx.query(
        `SELECT s.status, s.plan_id, p.code FROM subscription s JOIN plan p ON p.id = s.plan_id WHERE s.shop_id=$1`,
        [shopId],
      )
    ).rows[0];
    if (!sub) throw E.subscriptionRestricted('Shop has no subscription');

    const planFeatures = (await tx.query(`SELECT feature_key FROM plan_feature WHERE plan_id=$1`, [sub.plan_id])).rows;
    const overrides = (
      await tx.query(
        `SELECT feature_key, enabled FROM shop_feature_override
         WHERE shop_id=$1 AND (expires_at IS NULL OR expires_at > now())`,
        [shopId],
      )
    ).rows;

    const features = new Set<string>(planFeatures.map((r) => r.feature_key));
    for (const o of overrides) {
      if (o.enabled) features.add(o.feature_key);
      else features.delete(o.feature_key);
    }
    for (const f of [...features]) {
      const allowed = FEATURE_SHOP_TYPES[f as FeatureKey];
      if (allowed && !allowed.includes(shop.shop_type)) features.delete(f);
    }

    const limits: Partial<Record<LimitKey, number | null>> = {};
    for (const r of (await tx.query(`SELECT limit_key, value FROM plan_limit WHERE plan_id=$1`, [sub.plan_id])).rows) {
      limits[r.limit_key as LimitKey] = r.value;
    }
    for (const r of (
      await tx.query(
        `SELECT limit_key, value FROM shop_limit_override WHERE shop_id=$1 AND (expires_at IS NULL OR expires_at > now())`,
        [shopId],
      )
    ).rows) {
      limits[r.limit_key as LimitKey] = r.value;
    }

    return {
      shopType: shop.shop_type,
      shopStatus: shop.status,
      subscriptionStatus: sub.status,
      planCode: sub.code,
      features: features as Set<FeatureKey>,
      limits,
    };
  }

  async has(tx: Tx, shopId: string, key: FeatureKey): Promise<boolean> {
    return (await this.resolve(tx, shopId)).features.has(key);
  }

  async require(tx: Tx, shopId: string, key: FeatureKey): Promise<void> {
    if (!(await this.has(tx, shopId, key))) throw E.featureNotEnabled(key);
  }
}
