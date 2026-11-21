import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { FeatureService } from '../platform/feature.service';
import { LimitService } from '../platform/limit.service';
import { TenantSession } from '../common/session';

@Injectable()
export class BranchService {
  constructor(
    private readonly audit: AuditService,
    private readonly features: FeatureService,
    private readonly limits: LimitService,
  ) {}

  async list(tx: Tx, shopId: string) {
    return (await tx.query(`SELECT id, name, code, status, is_default FROM branch WHERE shop_id=$1 ORDER BY is_default DESC, name`, [shopId])).rows;
  }

  /** The first branch ("Main") exists from provisioning; extra branches need `multi_branch` and a free slot. */
  async create(tx: Tx, s: TenantSession, input: { name: string; code?: string }) {
    const active = (await tx.query(`SELECT count(*)::int c FROM branch WHERE shop_id=$1 AND status='active'`, [s.shopId])).rows[0].c;
    if (active >= 1) await this.features.require(tx, s.shopId, 'multi_branch');
    await this.limits.check(tx, s.shopId, 'max_branches');
    try {
      const b = (
        await tx.query(`INSERT INTO branch(shop_id, name, code) VALUES ($1,$2,$3) RETURNING id, name, code, status, is_default`, [s.shopId, input.name, input.code ?? null])
      ).rows[0];
      await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'branch.created', entity: 'branch', entityId: b.id, new: b });
      return b;
    } catch (e: any) {
      if (e.code === '23505') throw E.conflict('A branch with this name already exists');
      throw e;
    }
  }

  async update(tx: Tx, s: TenantSession, id: string, input: { name?: string; code?: string }) {
    const old = (await tx.query(`SELECT id, name, code FROM branch WHERE shop_id=$1 AND id=$2`, [s.shopId, id])).rows[0];
    if (!old) throw E.notFound('Branch');
    const r = (
      await tx.query(`UPDATE branch SET name=coalesce($3,name), code=coalesce($4,code) WHERE shop_id=$1 AND id=$2 RETURNING id, name, code, status, is_default`, [s.shopId, id, input.name ?? null, input.code ?? null])
    ).rows[0];
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'branch.updated', entity: 'branch', entityId: id, old, new: r });
    return r;
  }

  async deactivate(tx: Tx, s: TenantSession, id: string) {
    const active = (await tx.query(`SELECT count(*)::int c FROM branch WHERE shop_id=$1 AND status='active'`, [s.shopId])).rows[0].c;
    if (active <= 1) throw E.conflict('A shop must keep at least one active branch');
    const r = await tx.query(`UPDATE branch SET status='inactive' WHERE shop_id=$1 AND id=$2 AND status='active' RETURNING id`, [s.shopId, id]);
    if (!r.rowCount) throw E.notFound('Active branch');
    await tx.query(`UPDATE terminal SET status='inactive' WHERE shop_id=$1 AND branch_id=$2`, [s.shopId, id]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'branch.deactivated', entity: 'branch', entityId: id });
  }

  /** Single-branch mode: the UI hides branch pickers when exactly one active branch exists and multi_branch is off. */
  async mode(tx: Tx, shopId: string): Promise<{ mode: 'single' | 'multi'; singleBranchId?: string }> {
    const rows = (await tx.query(`SELECT id FROM branch WHERE shop_id=$1 AND status='active'`, [shopId])).rows;
    const f = await this.features.has(tx, shopId, 'multi_branch');
    if (rows.length === 1 && !f) return { mode: 'single', singleBranchId: rows[0].id };
    return { mode: 'multi' };
  }
}
