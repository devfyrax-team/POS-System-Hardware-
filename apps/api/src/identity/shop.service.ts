import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { z, parse } from '../common/validate';
import { AuditService } from '../audit/audit.service';
import { TenantSession } from '../common/session';

export const settingsSchema = z
  .object({
    costing_method: z.enum(['fifo', 'average']),
    costing_effective_from: z.string().nullable(),
    expiry_windows_days: z.array(z.number().int().positive()).max(6),
    expired_stock_policy: z.enum(['block', 'warn', 'allow']),
    below_cost_warning: z.boolean(),
    cashier_price_override: z.boolean(),
    low_stock_channels: z.array(z.enum(['in_app', 'sms', 'whatsapp'])),
    receipt: z.object({ header: z.string().max(200), footer: z.string().max(200), language: z.enum(['en', 'si', 'ta']) }).partial(),
  })
  .partial()
  .strict();

@Injectable()
export class ShopService {
  constructor(private readonly audit: AuditService) {}

  async get(tx: Tx, shopId: string) {
    const r = (await tx.query(`SELECT id, name, shop_type, status, settings FROM shop WHERE id=$1`, [shopId])).rows[0];
    if (!r) throw E.notFound('Shop');
    return r;
  }

  /** shop_type is set by the platform and cannot be changed here. */
  async updateSettings(tx: Tx, s: TenantSession, body: unknown, name?: string) {
    const patch = parse(settingsSchema, body);
    const old = await this.get(tx, s.shopId);
    const merged = { ...old.settings, ...patch, receipt: { ...(old.settings.receipt ?? {}), ...(patch.receipt ?? {}) } };
    const r = (
      await tx.query(`UPDATE shop SET settings=$2, name=coalesce($3,name) WHERE id=$1 RETURNING id, name, shop_type, status, settings`, [s.shopId, JSON.stringify(merged), name ?? null])
    ).rows[0];
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'shop.settings_updated', entity: 'shop', entityId: s.shopId, old: old.settings, new: r.settings });
    return r;
  }
}
