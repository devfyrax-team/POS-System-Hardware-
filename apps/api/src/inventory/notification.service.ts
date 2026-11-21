import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';

/** In-app notifications. SMS/WhatsApp plug in later behind the same call (channel interface deferred). */
@Injectable()
export class NotificationService {
  async notify(tx: Tx, p: { shopId: string; userIds: string[]; branchId?: string | null; type: string; title: string; body?: string; payload?: unknown }) {
    for (const u of [...new Set(p.userIds)]) {
      await tx.query(
        `INSERT INTO notification(shop_id, user_id, branch_id, type, title, body, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [p.shopId, u, p.branchId ?? null, p.type, p.title, p.body ?? null, JSON.stringify(p.payload ?? {})],
      );
    }
  }

  /** Active users who hold `permission` in the branch (shop-wide roles count). */
  async recipientsWithPermission(tx: Tx, shopId: string, branchId: string | null, permission: string): Promise<string[]> {
    const r = await tx.query(
      `SELECT DISTINCT u.id FROM users u
       JOIN user_branch_role ubr ON ubr.shop_id=u.shop_id AND ubr.user_id=u.id
       JOIN role r ON r.shop_id=ubr.shop_id AND r.id=ubr.role_id
       WHERE u.shop_id=$1 AND u.status='active' AND $3 = ANY(r.permissions)
         AND (ubr.branch_id IS NULL OR $2::uuid IS NULL OR ubr.branch_id = $2)`,
      [shopId, branchId, permission],
    );
    return r.rows.map((x) => x.id);
  }

  async list(tx: Tx, shopId: string, userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
    return (
      await tx.query(
        `SELECT id, type, title, body, payload, branch_id, read_at, created_at FROM notification
         WHERE shop_id=$1 AND user_id=$2 AND ($3::boolean IS NOT TRUE OR read_at IS NULL) ORDER BY id DESC LIMIT $4`,
        [shopId, userId, opts.unreadOnly ?? false, Math.min(opts.limit ?? 50, 200)],
      )
    ).rows;
  }

  async markRead(tx: Tx, shopId: string, userId: string, id: number) {
    const r = await tx.query(`UPDATE notification SET read_at=now() WHERE shop_id=$1 AND user_id=$2 AND id=$3 AND read_at IS NULL`, [shopId, userId, id]);
    if (!r.rowCount) throw E.notFound('Notification');
  }

  async unreadCount(tx: Tx, shopId: string, userId: string): Promise<number> {
    return (await tx.query(`SELECT count(*)::int c FROM notification WHERE shop_id=$1 AND user_id=$2 AND read_at IS NULL`, [shopId, userId])).rows[0].c;
  }
}
