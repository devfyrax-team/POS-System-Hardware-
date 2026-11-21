import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { LimitService } from '../platform/limit.service';
import { TenantSession } from '../common/session';

@Injectable()
export class TerminalService {
  constructor(private readonly audit: AuditService, private readonly limits: LimitService) {}

  async register(tx: Tx, s: TenantSession, input: { branchId: string; name: string; prefix: string }) {
    const prefix = input.prefix.toUpperCase();
    if (!/^[A-Z0-9-]{2,16}$/.test(prefix)) throw E.validation('Prefix must be 2-16 chars: letters, digits or dash');
    const branch = (await tx.query(`SELECT id FROM branch WHERE shop_id=$1 AND id=$2 AND status='active'`, [s.shopId, input.branchId])).rows[0];
    if (!branch) throw E.notFound('Branch');
    await this.limits.check(tx, s.shopId, 'max_terminals_per_branch', 1, { branchId: input.branchId });
    try {
      const t = (
        await tx.query(
          `INSERT INTO terminal(shop_id, branch_id, name, prefix) VALUES ($1,$2,$3,$4) RETURNING id, branch_id, name, prefix, status`,
          [s.shopId, input.branchId, input.name, prefix],
        )
      ).rows[0];
      await tx.query(`INSERT INTO invoice_sequence(shop_id, terminal_id, next) VALUES ($1,$2,1)`, [s.shopId, t.id]);
      await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'terminal.registered', entity: 'terminal', entityId: t.id, new: t });
      return t;
    } catch (e: any) {
      if (e.code === '23505') throw E.conflict('Terminal prefix already used in this shop');
      throw e;
    }
  }

  async deactivate(tx: Tx, s: TenantSession, id: string) {
    const r = await tx.query(`UPDATE terminal SET status='inactive' WHERE shop_id=$1 AND id=$2 RETURNING id`, [s.shopId, id]);
    if (!r.rowCount) throw E.notFound('Terminal');
    await tx.query(`UPDATE refresh_token SET revoked_at=now() WHERE shop_id=$1 AND terminal_id=$2 AND revoked_at IS NULL`, [s.shopId, id]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'terminal.deactivated', entity: 'terminal', entityId: id });
  }

  async list(tx: Tx, shopId: string, branchId?: string) {
    return (
      await tx.query(
        `SELECT id, branch_id, name, prefix, status FROM terminal WHERE shop_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) ORDER BY prefix`,
        [shopId, branchId ?? null],
      )
    ).rows;
  }

  async get(tx: Tx, shopId: string, id: string) {
    const t = (await tx.query(`SELECT id, branch_id, name, prefix, status FROM terminal WHERE shop_id=$1 AND id=$2`, [shopId, id])).rows[0];
    if (!t) throw E.notFound('Terminal');
    return t;
  }
}
