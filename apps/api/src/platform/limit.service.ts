import { Injectable } from '@nestjs/common';
import { LimitKey } from '@pos/contracts';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { FeatureService } from './feature.service';

export type UsageCounter = (tx: Tx, shopId: string, scope?: { branchId?: string }) => Promise<number>;

@Injectable()
export class LimitService {
  private counters = new Map<LimitKey, UsageCounter>();

  constructor(private readonly features: FeatureService) {
    this.register('max_users', async (tx, s) => this.count(tx, `SELECT count(*)::int c FROM users WHERE shop_id=$1 AND status='active'`, [s]));
    this.register('max_branches', async (tx, s) => this.count(tx, `SELECT count(*)::int c FROM branch WHERE shop_id=$1 AND status='active'`, [s]));
    this.register('max_terminals_per_branch', async (tx, s, sc) =>
      this.count(tx, `SELECT count(*)::int c FROM terminal WHERE shop_id=$1 AND branch_id=$2 AND status='active'`, [s, sc?.branchId]),
    );
  }

  /** Later phases register their own counters (e.g. max_products). */
  register(key: LimitKey, counter: UsageCounter) {
    this.counters.set(key, counter);
  }

  private async count(tx: Tx, sql: string, params: any[]): Promise<number> {
    return (await tx.query(sql, params)).rows[0].c;
  }

  async usage(tx: Tx, shopId: string, key: LimitKey, scope?: { branchId?: string }): Promise<number> {
    const c = this.counters.get(key);
    return c ? c(tx, shopId, scope) : 0;
  }

  /** Throws PLAN_LIMIT when usage + delta would exceed the shop's effective limit. */
  async check(tx: Tx, shopId: string, key: LimitKey, delta = 1, scope?: { branchId?: string }): Promise<void> {
    const { limits } = await this.features.resolve(tx, shopId);
    const limit = limits[key];
    if (limit === undefined || limit === null) return; // unlimited
    const used = await this.usage(tx, shopId, key, scope);
    if (used + delta > limit) throw E.planLimit(key, limit);
  }
}
