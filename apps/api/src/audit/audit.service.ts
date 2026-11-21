import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';

export interface AuditEntry {
  shopId: string | null;
  actorId?: string | null;
  actorType?: 'user' | 'platform' | 'system';
  approverId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  old?: unknown;
  new?: unknown;
  terminalId?: string | null;
}

/** Insert-only audit trail. Always called in the same transaction as the change it records. */
@Injectable()
export class AuditService {
  async record(tx: Tx, e: AuditEntry): Promise<void> {
    await tx.query(
      `INSERT INTO audit_log(shop_id, actor_id, actor_type, approver_id, action, entity, entity_id, old_value, new_value, terminal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        e.shopId, e.actorId ?? null, e.actorType ?? 'user', e.approverId ?? null, e.action,
        e.entity ?? null, e.entityId ?? null,
        e.old === undefined ? null : JSON.stringify(e.old),
        e.new === undefined ? null : JSON.stringify(e.new),
        e.terminalId ?? null,
      ],
    );
  }

  async query(
    tx: Tx,
    f: { action?: string; entity?: string; actorId?: string; from?: string; to?: string; limit?: number; beforeId?: number },
  ) {
    const where: string[] = [];
    const p: any[] = [];
    const add = (sql: string, v: any) => {
      p.push(v);
      where.push(sql.replace('?', `$${p.length}`));
    };
    if (f.action) add('action = ?', f.action);
    if (f.entity) add('entity = ?', f.entity);
    if (f.actorId) add('actor_id = ?', f.actorId);
    if (f.from) add('created_at >= ?', f.from);
    if (f.to) add('created_at <= ?', f.to);
    if (f.beforeId) add('id < ?', f.beforeId);
    p.push(Math.min(f.limit ?? 50, 200));
    const r = await tx.query(
      `SELECT id, actor_id, actor_type, approver_id, action, entity, entity_id, old_value, new_value, terminal_id, created_at
       FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${p.length}`,
      p,
    );
    return r.rows;
  }
}
