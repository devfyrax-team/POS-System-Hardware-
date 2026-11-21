import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES, ShopType } from '@pos/contracts';
import { Db } from '../db/db';
import { E } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { hashSecret, tempPassword } from '../auth/password';
import { SubscriptionService } from './subscription.service';

export function defaultShopSettings(shopType: ShopType, shopName: string) {
  return {
    costing_method: 'fifo',
    costing_effective_from: null,
    expiry_windows_days: shopType === 'hardware' ? [90, 30] : [180, 90, 30],
    expired_stock_policy: 'warn', // block | warn | allow
    below_cost_warning: true,
    cashier_price_override: false,
    low_stock_channels: ['in_app'],
    receipt: { header: shopName, footer: 'Thank you', language: 'en' },
  };
}

const ROLE_NAMES: Record<string, string> = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', storekeeper: 'Storekeeper' };

export interface ProvisionInput {
  name: string;
  shopType: ShopType;
  planCode: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword?: string;
  trial?: boolean;
  adminId?: string;
}

@Injectable()
export class ShopProvisioningService {
  constructor(private readonly db: Db, private readonly audit: AuditService, private readonly subs: SubscriptionService) {}

  /** One atomic transaction: shop, subscription, "Main" branch, system roles, owner user. */
  async create(input: ProvisionInput) {
    const shopId = randomUUID();
    const password = input.ownerPassword ?? tempPassword();
    const passwordHash = await hashSecret(password);

    return this.db.platform(async (tx) => {
      await tx.query(`INSERT INTO shop(id, name, shop_type, settings) VALUES ($1,$2,$3,$4)`, [
        shopId, input.name, input.shopType, JSON.stringify(defaultShopSettings(input.shopType, input.name)),
      ]);
      await this.subs.start(tx, shopId, input.planCode, { trial: input.trial });

      const branch = (
        await tx.query(`INSERT INTO branch(shop_id, name, code, is_default) VALUES ($1,'Main','MAIN',true) RETURNING id`, [shopId])
      ).rows[0];

      const roleIds: Record<string, string> = {};
      for (const key of SYSTEM_ROLES) {
        const r = await tx.query(
          `INSERT INTO role(shop_id, name, is_system, system_key, permissions) VALUES ($1,$2,true,$3,$4) RETURNING id`,
          [shopId, ROLE_NAMES[key], key, DEFAULT_ROLE_PERMISSIONS[key]],
        );
        roleIds[key] = r.rows[0].id;
      }

      let owner;
      try {
        owner = (
          await tx.query(
            `INSERT INTO users(shop_id, email, name, password_hash, must_change_password) VALUES ($1,lower($2),$3,$4,$5) RETURNING id`,
            [shopId, input.ownerEmail, input.ownerName, passwordHash, !input.ownerPassword],
          )
        ).rows[0];
      } catch (e: any) {
        if (e.code === '23505') throw E.conflict('Email is already registered');
        throw e;
      }
      await tx.query(`INSERT INTO user_branch_role(shop_id, user_id, branch_id, role_id) VALUES ($1,$2,NULL,$3)`, [shopId, owner.id, roleIds.owner]);

      await this.audit.record(tx, {
        shopId, actorId: input.adminId ?? null, actorType: 'platform', action: 'shop.provisioned',
        entity: 'shop', entityId: shopId, new: { name: input.name, shopType: input.shopType, plan: input.planCode },
      });

      return {
        shopId, defaultBranchId: branch.id as string, ownerUserId: owner.id as string,
        roleIds, tempPassword: input.ownerPassword ? undefined : password,
      };
    }, shopId);
  }
}
