import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FeatureKey, LimitKey, Permission } from '@pos/contracts';

/** What the server knows about the caller. IDs come from here, never from the request body. */
export interface TenantSession {
  kind: 'tenant';
  userId: string;
  shopId: string;
  branchId?: string;
  terminalId?: string;
  // Filled lazily by guards:
  permissions?: Set<Permission>;
  allBranches?: boolean;
  branchIds?: Set<string>;
  features?: Set<FeatureKey>;
  limits?: Partial<Record<LimitKey, number | null>>;
}

export interface PlatformSession {
  kind: 'platform';
  adminId: string;
}

export type Session = TenantSession | PlatformSession;

export const CurrentSession = createParamDecorator((_d: unknown, ctx: ExecutionContext): Session => {
  return ctx.switchToHttp().getRequest().session;
});

export const CurrentTenant = createParamDecorator((_d: unknown, ctx: ExecutionContext): TenantSession => {
  return ctx.switchToHttp().getRequest().session;
});
