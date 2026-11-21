import { Injectable } from '@nestjs/common';
import { PERMISSION_FEATURE, Permission } from '@pos/contracts';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { FeatureService } from '../platform/feature.service';
import { LimitService } from '../platform/limit.service';
import { hashSecret, tempPassword } from '../auth/password';
import { TenantSession } from '../common/session';
import { Access, AccessService } from './access.service';

/**
 * Shop-admin functions: users and role assignment.
 * Guard-rails: always keep one active Owner; nobody can hand out more than they hold;
 * a non-owner (e.g. Manager) can only act inside branches where they hold a role.
 */
@Injectable()
export class UserAdminService {
  constructor(
    private readonly audit: AuditService,
    private readonly features: FeatureService,
    private readonly limits: LimitService,
    private readonly access: AccessService,
  ) {}

  private async actorAccess(tx: Tx, s: TenantSession): Promise<Access> {
    const { features } = await this.features.resolve(tx, s.shopId);
    return this.access.load(tx, s.userId, undefined, features);
  }

  /** Role permissions that actually apply in this shop (feature-gated ones removed). */
  private async effectivePerms(tx: Tx, shopId: string, perms: string[]): Promise<Set<Permission>> {
    const { features } = await this.features.resolve(tx, shopId);
    return new Set((perms as Permission[]).filter((p) => !PERMISSION_FEATURE[p] || features.has(PERMISSION_FEATURE[p]!)));
  }

  private async assertCanAssign(tx: Tx, s: TenantSession, acc: Access, roleId: string, branchId: string | null) {
    const role = (await tx.query(`SELECT id, system_key, permissions FROM role WHERE shop_id=$1 AND id=$2`, [s.shopId, roleId])).rows[0];
    if (!role) throw E.notFound('Role');
    if (role.system_key === 'owner' && !acc.isOwner) throw E.forbidden('Only an Owner can assign the Owner role');
    const eff = await this.effectivePerms(tx, s.shopId, role.permissions);
    for (const p of eff) if (!acc.permissions.has(p)) throw E.forbidden(`You cannot grant "${p}" because you do not hold it`);
    if (!acc.allBranches) {
      if (branchId === null) throw E.forbidden('You can only assign roles within your own branches');
      if (!acc.branchIds.has(branchId)) throw E.forbidden('You can only assign roles within your own branches');
    }
    if (branchId) {
      const b = (await tx.query(`SELECT id FROM branch WHERE shop_id=$1 AND id=$2 AND status='active'`, [s.shopId, branchId])).rows[0];
      if (!b) throw E.notFound('Branch');
    }
    return role;
  }

  private async assertTargetInScope(tx: Tx, s: TenantSession, acc: Access, targetUserId: string) {
    const u = (await tx.query(`SELECT id, email, name, status FROM users WHERE shop_id=$1 AND id=$2`, [s.shopId, targetUserId])).rows[0];
    if (!u) throw E.notFound('User');
    if (acc.allBranches) return u;
    const rows = (await tx.query(`SELECT branch_id, role_id FROM user_branch_role WHERE shop_id=$1 AND user_id=$2`, [s.shopId, targetUserId])).rows;
    // A branch-scoped admin may only manage users whose roles are all inside their own branches.
    for (const r of rows) if (r.branch_id === null || !acc.branchIds.has(r.branch_id)) throw E.forbidden('This user is outside your branch scope');
    return u;
  }

  /** Active owners other than `excludeUserId` (counting only shop-wide owner assignments). */
  private async otherOwners(tx: Tx, shopId: string, excludeUserId: string): Promise<number> {
    return (
      await tx.query(
        `SELECT count(DISTINCT u.id)::int c FROM users u
         JOIN user_branch_role ubr ON ubr.shop_id=u.shop_id AND ubr.user_id=u.id
         JOIN role r ON r.shop_id=ubr.shop_id AND r.id=ubr.role_id
         WHERE u.shop_id=$1 AND u.status='active' AND r.system_key='owner' AND u.id <> $2`,
        [shopId, excludeUserId],
      )
    ).rows[0].c;
  }

  private async holdsOwnerRole(tx: Tx, shopId: string, userId: string): Promise<boolean> {
    return (
      (await tx.query(
        `SELECT 1 FROM user_branch_role ubr JOIN role r ON r.shop_id=ubr.shop_id AND r.id=ubr.role_id
         WHERE ubr.shop_id=$1 AND ubr.user_id=$2 AND r.system_key='owner' LIMIT 1`,
        [shopId, userId],
      )).rowCount > 0
    );
  }

  async list(tx: Tx, shopId: string) {
    const users = (await tx.query(`SELECT id, email, name, status, must_change_password, created_at FROM users WHERE shop_id=$1 ORDER BY name`, [shopId])).rows;
    const roles = (
      await tx.query(
        `SELECT ubr.user_id, ubr.branch_id, r.id role_id, r.name role_name FROM user_branch_role ubr JOIN role r ON r.shop_id=ubr.shop_id AND r.id=ubr.role_id WHERE ubr.shop_id=$1`,
        [shopId],
      )
    ).rows;
    return users.map((u) => ({ ...u, roles: roles.filter((r) => r.user_id === u.id) }));
  }

  async invite(tx: Tx, s: TenantSession, input: { email: string; name: string; roleId: string; branchId: string | null; password?: string }) {
    const acc = await this.actorAccess(tx, s);
    await this.assertCanAssign(tx, s, acc, input.roleId, input.branchId);
    await this.limits.check(tx, s.shopId, 'max_users');
    const password = input.password ?? tempPassword();
    try {
      const u = (
        await tx.query(
          `INSERT INTO users(shop_id, email, name, password_hash, must_change_password) VALUES ($1,lower($2),$3,$4,$5) RETURNING id, email, name, status`,
          [s.shopId, input.email, input.name, await hashSecret(password), !input.password],
        )
      ).rows[0];
      await tx.query(`INSERT INTO user_branch_role(shop_id, user_id, branch_id, role_id) VALUES ($1,$2,$3,$4)`, [s.shopId, u.id, input.branchId, input.roleId]);
      await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'user.created', entity: 'user', entityId: u.id, new: { email: u.email, roleId: input.roleId, branchId: input.branchId } });
      return { ...u, tempPassword: input.password ? undefined : password };
    } catch (e: any) {
      if (e.code === '23505') throw E.conflict('Email is already registered');
      throw e;
    }
  }

  async assignBranchRole(tx: Tx, s: TenantSession, userId: string, branchId: string | null, roleId: string) {
    const acc = await this.actorAccess(tx, s);
    await this.assertTargetInScope(tx, s, acc, userId);
    await this.assertCanAssign(tx, s, acc, roleId, branchId);
    await tx.query(
      `INSERT INTO user_branch_role(shop_id, user_id, branch_id, role_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [s.shopId, userId, branchId, roleId],
    );
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'user.role_assigned', entity: 'user', entityId: userId, new: { branchId, roleId } });
  }

  async removeBranchRole(tx: Tx, s: TenantSession, userId: string, branchId: string | null, roleId: string) {
    const acc = await this.actorAccess(tx, s);
    await this.assertTargetInScope(tx, s, acc, userId);
    const role = (await tx.query(`SELECT system_key FROM role WHERE shop_id=$1 AND id=$2`, [s.shopId, roleId])).rows[0];
    if (!role) throw E.notFound('Role');
    if (role.system_key === 'owner') {
      if (!acc.isOwner) throw E.forbidden('Only an Owner can change Owner assignments');
      if ((await this.otherOwners(tx, s.shopId, userId)) < 1) throw E.conflict('A shop must keep at least one Owner');
    }
    const r = await tx.query(
      `DELETE FROM user_branch_role WHERE shop_id=$1 AND user_id=$2 AND role_id=$3 AND branch_id IS NOT DISTINCT FROM $4`,
      [s.shopId, userId, roleId, branchId],
    );
    if (!r.rowCount) throw E.notFound('Role assignment');
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'user.role_removed', entity: 'user', entityId: userId, old: { branchId, roleId } });
  }

  async deactivate(tx: Tx, s: TenantSession, userId: string) {
    const acc = await this.actorAccess(tx, s);
    await this.assertTargetInScope(tx, s, acc, userId);
    if (userId === s.userId) throw E.conflict('You cannot deactivate yourself');
    if (await this.holdsOwnerRole(tx, s.shopId, userId)) {
      if (!acc.isOwner) throw E.forbidden('Only an Owner can deactivate an Owner');
      if ((await this.otherOwners(tx, s.shopId, userId)) < 1) throw E.conflict('A shop must keep at least one active Owner');
    }
    await tx.query(`UPDATE users SET status='inactive', version=version+1 WHERE shop_id=$1 AND id=$2`, [s.shopId, userId]);
    await tx.query(`UPDATE refresh_token SET revoked_at=now() WHERE shop_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [s.shopId, userId]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'user.deactivated', entity: 'user', entityId: userId });
  }

  async reactivate(tx: Tx, s: TenantSession, userId: string) {
    const acc = await this.actorAccess(tx, s);
    await this.assertTargetInScope(tx, s, acc, userId);
    await this.limits.check(tx, s.shopId, 'max_users');
    await tx.query(`UPDATE users SET status='active', version=version+1 WHERE shop_id=$1 AND id=$2`, [s.shopId, userId]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'user.reactivated', entity: 'user', entityId: userId });
  }

  async resetPassword(tx: Tx, s: TenantSession, userId: string) {
    const acc = await this.actorAccess(tx, s);
    await this.assertTargetInScope(tx, s, acc, userId);
    if ((await this.holdsOwnerRole(tx, s.shopId, userId)) && !acc.isOwner) throw E.forbidden('Only an Owner can reset an Owner password');
    const password = tempPassword();
    await tx.query(`UPDATE users SET password_hash=$3, must_change_password=true, version=version+1 WHERE shop_id=$1 AND id=$2`, [s.shopId, userId, await hashSecret(password)]);
    await tx.query(`UPDATE refresh_token SET revoked_at=now() WHERE shop_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [s.shopId, userId]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'user.password_reset', entity: 'user', entityId: userId });
    return { tempPassword: password };
  }

  /** PIN for quick switching at a till. A user can set their own; admins can set others' within scope. */
  async setPin(tx: Tx, s: TenantSession, userId: string, pin: string) {
    if (!/^\d{4,8}$/.test(pin)) throw E.validation('PIN must be 4 to 8 digits');
    if (userId !== s.userId) {
      const acc = await this.actorAccess(tx, s);
      if (!acc.permissions.has('user.manage')) throw E.forbidden();
      await this.assertTargetInScope(tx, s, acc, userId);
    }
    const r = await tx.query(`UPDATE users SET pin_hash=$3, version=version+1 WHERE shop_id=$1 AND id=$2 RETURNING id`, [s.shopId, userId, await hashSecret(pin)]);
    if (!r.rowCount) throw E.notFound('User');
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'user.pin_set', entity: 'user', entityId: userId });
  }
}
