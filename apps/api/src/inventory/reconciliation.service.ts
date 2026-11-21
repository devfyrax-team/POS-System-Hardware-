import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { NotificationService } from './notification.service';

/** Compares each cached balance with the sum of its ledger rows and reports any difference. */
@Injectable()
export class ReconciliationService {
  constructor(private readonly notifications: NotificationService) {}

  async run(tx: Tx, shopId: string, branchId?: string) {
    const diffs = (
      await tx.query(
        `SELECT sb.branch_id, sb.product_id, sb.quantity AS balance, coalesce(m.s,0) AS ledger_sum
         FROM stock_balance sb
         LEFT JOIN (SELECT branch_id, product_id, sum(qty_base) s FROM stock_movement WHERE shop_id=$1 GROUP BY 1,2) m
           ON m.branch_id = sb.branch_id AND m.product_id = sb.product_id
         WHERE sb.shop_id=$1 AND ($2::uuid IS NULL OR sb.branch_id=$2) AND sb.quantity <> coalesce(m.s,0)`,
        [shopId, branchId ?? null],
      )
    ).rows;
    // ledger rows without a balance row are also a difference
    const orphans = (
      await tx.query(
        `SELECT m.branch_id, m.product_id, 0::numeric AS balance, sum(m.qty_base) AS ledger_sum
         FROM stock_movement m LEFT JOIN stock_balance sb ON sb.branch_id=m.branch_id AND sb.product_id=m.product_id
         WHERE m.shop_id=$1 AND sb.product_id IS NULL AND ($2::uuid IS NULL OR m.branch_id=$2) GROUP BY 1,2 HAVING sum(m.qty_base) <> 0`,
        [shopId, branchId ?? null],
      )
    ).rows;
    const all = [...diffs, ...orphans];
    for (const d of all) {
      await tx.query(
        `INSERT INTO stock_discrepancy(shop_id, branch_id, product_id, balance, ledger_sum) VALUES ($1,$2,$3,$4,$5)`,
        [shopId, d.branch_id, d.product_id, d.balance, d.ledger_sum],
      );
    }
    if (all.length) {
      const owners = await this.notifications.recipientsWithPermission(tx, shopId, null, 'stock.adjust');
      await this.notifications.notify(tx, {
        shopId, userIds: owners, type: 'stock.discrepancy', title: `Stock balance differs from ledger on ${all.length} item(s)`,
        payload: { count: all.length },
      });
    }
    return all;
  }

  async list(tx: Tx, shopId: string, includeResolved = false) {
    return (
      await tx.query(
        `SELECT d.id, d.branch_id, d.product_id, p.name, d.balance, d.ledger_sum, d.detected_at, d.resolved_at
         FROM stock_discrepancy d JOIN product p ON p.shop_id=d.shop_id AND p.id=d.product_id
         WHERE d.shop_id=$1 AND ($2 OR d.resolved_at IS NULL) ORDER BY d.id DESC LIMIT 200`,
        [shopId, includeResolved],
      )
    ).rows;
  }
}
