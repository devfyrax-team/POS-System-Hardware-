import { Injectable } from '@nestjs/common';
import { FeatureKey, PERMISSION_FEATURE, Permission } from '@pos/contracts';
import { Tx } from '../db/db';

export interface Access {
  permissions: Set<Permission>;
  allBranches: boolean; // holds at least one shop-wide (branch NULL) role
  branchIds: Set<string>; // branches where the user holds any role
  isOwner: boolean;
}

@Injectable()
export class AccessService {
  /**
   * Permissions are the union of the user's roles that apply at `branchId`
   * (shop-wide roles always apply). Without a branch (back office) all roles apply.
   * Permissions whose feature is disabled for the shop are removed.
   */
  async load(tx: Tx, userId: string, branchId: string | undefined, features: Set<FeatureKey>): Promise<Access> {
    const rows = (
      await tx.query(
        `SELECT ubr.branch_id, r.permissions, r.system_key
         FROM user_branch_role ubr JOIN role r ON r.shop_id = ubr.shop_id AND r.id = ubr.role_id
         WHERE ubr.user_id = $1`,
        [userId],
      )
    ).rows;
    const perms = new Set<Permission>();
    let allBranches = false;
    let isOwner = false;
    const branchIds = new Set<string>();
    for (const r of rows) {
      if (r.branch_id === null) allBranches = true;
      else branchIds.add(r.branch_id);
      const applies = !branchId || r.branch_id === null || r.branch_id === branchId;
      if (!applies) continue;
      if (r.system_key === 'owner') isOwner = true;
      for (const p of r.permissions as Permission[]) perms.add(p);
    }
    for (const p of [...perms]) {
      const need = PERMISSION_FEATURE[p];
      if (need && !features.has(need)) perms.delete(p);
    }
    return { permissions: perms, allBranches, branchIds, isOwner };
  }
}
