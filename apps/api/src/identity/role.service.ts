import { Injectable } from '@nestjs/common';
import { PERMISSIONS, PERMISSION_FEATURE, Permission } from '@pos/contracts';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { FeatureService } from '../platform/feature.service';
import { TenantSession } from '../common/session';

/** Shop-level roles, managed by the shop's own admin. Never touches platform data. */
@Injectable()
export class RoleService {
  constructor(private readonly audit: AuditService, private readonly features: FeatureService) {}

  async list(tx: Tx, shopId: string) {
    return (await tx.query(`SELECT id, name, is_system, system_key, permissions, approval_limits FROM role WHERE shop_id=$1 ORDER BY is_system DESC, name`, [shopId])).rows;
  }

  /** A role may only contain real permissions whose feature is enabled for this shop. */
  private async validatePermissions(tx: Tx, shopId: string, perms: string[]): Promise<Permission[]> {
    const unknown = perms.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (unknown.length) throw E.validation(`Unknown permissions: ${unknown.join(', ')}`);
    const { features } = await this.features.resolve(tx, shopId);
    const blocked = (perms as Permission[]).filter((p) => PERMISSION_FEATURE[p] && !features.has(PERMISSION_FEATURE[p]!));
    if (blocked.length) throw E.validation(`Permissions need features this shop does not have: ${blocked.join(', ')}`, { blocked });
    return [...new Set(perms)] as Permission[];
  }

  /** Creating new roles needs the `custom_roles` feature. */
  async create(tx: Tx, s: TenantSession, input: { name: string; permissions: string[]; approvalLimits?: Record<string, unknown> }) {
    await this.features.require(tx, s.shopId, 'custom_roles');
    const perms = await this.validatePermissions(tx, s.shopId, input.permissions);
    try {
      const r = (
        await tx.query(
          `INSERT INTO role(shop_id, name, permissions, approval_limits) VALUES ($1,$2,$3,$4) RETURNING id, name, is_system, permissions, approval_limits`,
          [s.shopId, input.name, perms, JSON.stringify(input.approvalLimits ?? {})],
        )
      ).rows[0];
      await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'role.created', entity: 'role', entityId: r.id, new: r });
      return r;
    } catch (e: any) {
      if (e.code === '23505') throw E.conflict('A role with this name already exists');
      throw e;
    }
  }

  async clone(tx: Tx, s: TenantSession, roleId: string, name: string) {
    const src = (await tx.query(`SELECT permissions, approval_limits FROM role WHERE shop_id=$1 AND id=$2`, [s.shopId, roleId])).rows[0];
    if (!src) throw E.notFound('Role');
    return this.create(tx, s, { name, permissions: src.permissions, approvalLimits: src.approval_limits });
  }

  /** The Owner role is fixed. Other roles (system or custom) are editable per shop. */
  async update(tx: Tx, s: TenantSession, roleId: string, input: { name?: string; permissions?: string[]; approvalLimits?: Record<string, unknown> }) {
    const old = (await tx.query(`SELECT id, name, is_system, system_key, permissions, approval_limits FROM role WHERE shop_id=$1 AND id=$2`, [s.shopId, roleId])).rows[0];
    if (!old) throw E.notFound('Role');
    if (old.system_key === 'owner') throw E.forbidden('The Owner role cannot be changed');
    if (old.is_system && input.name && input.name !== old.name) throw E.forbidden('System roles cannot be renamed');
    const perms = input.permissions ? await this.validatePermissions(tx, s.shopId, input.permissions) : null;
    const r = (
      await tx.query(
        `UPDATE role SET name=coalesce($3,name), permissions=coalesce($4,permissions), approval_limits=coalesce($5,approval_limits)
         WHERE shop_id=$1 AND id=$2 RETURNING id, name, is_system, permissions, approval_limits`,
        [s.shopId, roleId, input.name ?? null, perms, input.approvalLimits ? JSON.stringify(input.approvalLimits) : null],
      )
    ).rows[0];
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'role.updated', entity: 'role', entityId: roleId, old, new: r });
    return r;
  }

  async remove(tx: Tx, s: TenantSession, roleId: string) {
    const role = (await tx.query(`SELECT is_system FROM role WHERE shop_id=$1 AND id=$2`, [s.shopId, roleId])).rows[0];
    if (!role) throw E.notFound('Role');
    if (role.is_system) throw E.forbidden('System roles cannot be deleted');
    const used = (await tx.query(`SELECT count(*)::int c FROM user_branch_role WHERE shop_id=$1 AND role_id=$2`, [s.shopId, roleId])).rows[0].c;
    if (used) throw E.conflict('Role is assigned to users; reassign them first');
    await tx.query(`DELETE FROM role WHERE shop_id=$1 AND id=$2`, [s.shopId, roleId]);
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'role.deleted', entity: 'role', entityId: roleId });
  }
}
