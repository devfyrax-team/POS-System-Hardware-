import { Injectable } from '@nestjs/common';
import { LIMITS, LimitKey } from '@pos/contracts';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { LimitService } from './limit.service';

export type SubStatus = 'trial' | 'active' | 'past_due' | 'restricted' | 'cancelled';

@Injectable()
export class SubscriptionService {
  constructor(private readonly audit: AuditService, private readonly limits: LimitService) {}

  private async planByCode(tx: Tx, code: string) {
    const p = (await tx.query(`SELECT id, code, trial_days FROM plan WHERE code=$1 AND active`, [code])).rows[0];
    if (!p) throw E.notFound(`Plan ${code}`);
    return p;
  }

  async start(tx: Tx, shopId: string, planCode: string, opts: { trial?: boolean; period?: 'monthly' | 'annual' } = {}) {
    const plan = await this.planByCode(tx, planCode);
    const trial = !!opts.trial && plan.trial_days > 0;
    await tx.query(
      `INSERT INTO subscription(shop_id, plan_id, status, billing_period, trial_ends_at, current_period_end)
       VALUES ($1,$2,$3,$4, $5, $6)`,
      [
        shopId, plan.id, trial ? 'trial' : 'active', opts.period ?? 'monthly',
        trial ? new Date(Date.now() + plan.trial_days * 86400_000) : null,
        trial ? null : new Date(Date.now() + (opts.period === 'annual' ? 365 : 30) * 86400_000),
      ],
    );
  }

  /** Upgrades apply at once; downgrades are checked against current usage. */
  async changePlan(tx: Tx, adminId: string | null, shopId: string, planCode: string) {
    const plan = await this.planByCode(tx, planCode);
    const cur = (await tx.query(`SELECT plan_id FROM subscription WHERE shop_id=$1`, [shopId])).rows[0];
    if (!cur) throw E.notFound('Subscription');

    const newLimits: Partial<Record<LimitKey, number>> = {};
    for (const r of (await tx.query(`SELECT limit_key, value FROM plan_limit WHERE plan_id=$1`, [plan.id])).rows) newLimits[r.limit_key as LimitKey] = r.value;
    for (const r of (
      await tx.query(`SELECT limit_key, value FROM shop_limit_override WHERE shop_id=$1 AND (expires_at IS NULL OR expires_at > now())`, [shopId])
    ).rows) newLimits[r.limit_key as LimitKey] = r.value;

    const violations: { resource: string; used: number; limit: number; branchId?: string }[] = [];
    for (const k of LIMITS) {
      const lim = newLimits[k];
      if (lim === undefined) continue;
      if (k === 'max_terminals_per_branch') {
        const rows = (
          await tx.query(`SELECT branch_id, count(*)::int c FROM terminal WHERE shop_id=$1 AND status='active' GROUP BY branch_id`, [shopId])
        ).rows;
        for (const r of rows) if (r.c > lim) violations.push({ resource: k, used: r.c, limit: lim, branchId: r.branch_id });
      } else {
        const used = await this.limits.usage(tx, shopId, k);
        if (used > lim) violations.push({ resource: k, used, limit: lim });
      }
    }
    if (violations.length) throw E.conflict('Current usage exceeds the new plan limits', { violations });

    await tx.query(`UPDATE subscription SET plan_id=$2, updated_at=now() WHERE shop_id=$1`, [shopId, plan.id]);
    await this.audit.record(tx, {
      shopId, actorId: adminId, actorType: 'platform', action: 'subscription.plan_changed',
      entity: 'subscription', entityId: shopId, new: { plan: planCode },
    });
  }

  async setStatus(tx: Tx, adminId: string | null, shopId: string, status: SubStatus) {
    const r = await tx.query(`UPDATE subscription SET status=$2, updated_at=now() WHERE shop_id=$1 RETURNING status`, [shopId, status]);
    if (!r.rowCount) throw E.notFound('Subscription');
    await this.audit.record(tx, {
      shopId, actorId: adminId, actorType: adminId ? 'platform' : 'system', action: 'subscription.status_changed',
      entity: 'subscription', entityId: shopId, new: { status },
    });
  }
}
