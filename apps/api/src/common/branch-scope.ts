import { E } from './errors';
import { TenantSession } from './session';

/** True when the user holds a role at the branch (shop-wide roles count). */
export function canAccessBranch(s: TenantSession, branchId: string): boolean {
  return !!(s.allBranches || s.branchIds?.has(branchId));
}

export function assertBranchAccess(s: TenantSession, branchId: string): void {
  if (!canAccessBranch(s, branchId)) throw E.forbidden('You do not work at that branch');
}

/**
 * Which branch a request is about. A branch-scoped user (e.g. a manager of one branch) can only see or change their own
 * branch's data; owners and other shop-wide roles can pass any branch, or `all`.
 * Returns undefined to mean "every branch" (only for shop-wide users).
 */
export function scopeBranch(s: TenantSession, requested?: string): string | undefined {
  if (requested === 'all') {
    if (!s.allBranches) throw E.forbidden('You can only see your own branch');
    return undefined;
  }
  if (requested) {
    assertBranchAccess(s, requested);
    return requested;
  }
  if (s.branchId) return s.branchId;
  if (s.allBranches) return undefined;
  if (s.branchIds?.size === 1) return [...s.branchIds][0];
  throw E.validation('Choose a branch');
}
