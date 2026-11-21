import { Injectable } from '@nestjs/common';
import { FEATURES, LIMITS } from '@pos/contracts';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { AuditService } from '../audit/audit.service';

/** Super Admin only: per-shop feature and limit grants. */
@Injectable()
export class AdminFeatureService {
  constructor(private readonly audit: AuditService) {}

  async setFeatureOverride(
    tx: Tx, adminId: string, shopId: string,
    input: { key: string; enabled: boolean; expiresAt?: string | null; reason?: string },
  ) {
    if (!(FEATURES as readonly string[]).includes(input.key)) throw E.validation(`Unknown feature ${input.key}`);
    const old = (await tx.query(`SELECT enabled, expires_at FROM shop_feature_override WHERE shop_id=$1 AND feature_key=$2`, [shopId, input.key])).rows[0];
    await tx.query(
      `INSERT INTO shop_feature_override(shop_id, feature_key, enabled, expires_at, reason, granted_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (shop_id, feature_key) DO UPDATE
         SET enabled=EXCLUDED.enabled, expires_at=EXCLUDED.expires_at, reason=EXCLUDED.reason, granted_by=EXCLUDED.granted_by`,
      [shopId, input.key, input.enabled, input.expiresAt ?? null, input.reason ?? null, adminId],
    );
    await this.audit.record(tx, {
      shopId, actorId: adminId, actorType: 'platform', action: 'feature.override_set',
      entity: 'feature', entityId: input.key, old, new: { enabled: input.enabled, expiresAt: input.expiresAt ?? null },
    });
  }

  async clearFeatureOverride(tx: Tx, adminId: string, shopId: string, key: string) {
    await tx.query(`DELETE FROM shop_feature_override WHERE shop_id=$1 AND feature_key=$2`, [shopId, key]);
    await this.audit.record(tx, { shopId, actorId: adminId, actorType: 'platform', action: 'feature.override_cleared', entity: 'feature', entityId: key });
  }

  async setLimitOverride(tx: Tx, adminId: string, shopId: string, input: { key: string; value: number; expiresAt?: string | null; reason?: string }) {
    if (!(LIMITS as readonly string[]).includes(input.key)) throw E.validation(`Unknown limit ${input.key}`);
    await tx.query(
      `INSERT INTO shop_limit_override(shop_id, limit_key, value, expires_at, reason, granted_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (shop_id, limit_key) DO UPDATE
         SET value=EXCLUDED.value, expires_at=EXCLUDED.expires_at, reason=EXCLUDED.reason, granted_by=EXCLUDED.granted_by`,
      [shopId, input.key, input.value, input.expiresAt ?? null, input.reason ?? null, adminId],
    );
    await this.audit.record(tx, {
      shopId, actorId: adminId, actorType: 'platform', action: 'limit.override_set',
      entity: 'limit', entityId: input.key, new: { value: input.value, expiresAt: input.expiresAt ?? null },
    });
  }

  async clearLimitOverride(tx: Tx, adminId: string, shopId: string, key: string) {
    await tx.query(`DELETE FROM shop_limit_override WHERE shop_id=$1 AND limit_key=$2`, [shopId, key]);
    await this.audit.record(tx, { shopId, actorId: adminId, actorType: 'platform', action: 'limit.override_cleared', entity: 'limit', entityId: key });
  }

  /** Daily job: delete lapsed overrides so the plan value applies again. */
  async expireOverrides(tx: Tx): Promise<number> {
    const a = await tx.query(`DELETE FROM shop_feature_override WHERE expires_at IS NOT NULL AND expires_at <= now()`);
    const b = await tx.query(`DELETE FROM shop_limit_override WHERE expires_at IS NOT NULL AND expires_at <= now()`);
    return a.rowCount + b.rowCount;
  }
}
