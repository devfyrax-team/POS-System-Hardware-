import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureKey, Permission } from '@pos/contracts';
import { E } from '../common/errors';
import { Session, TenantSession } from '../common/session';
import { Db } from '../db/db';
import { AccessService } from '../identity/access.service';
import { FeatureService, Resolved } from '../platform/feature.service';
import { META } from './decorators';
import { TokenService } from './token.service';

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export const ACCESS_COOKIE = 'pos_at';
export const REFRESH_COOKIE = 'pos_rt';

/** Guard 1: who is calling? Fills req.session from the access token (cookie or Bearer). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: TokenService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(META.PUBLIC, targets);
    const platformOnly = this.reflector.getAllAndOverride<boolean>(META.PLATFORM_ONLY, targets);

    const bearer = (req.headers.authorization as string | undefined)?.match(/^Bearer (.+)$/i)?.[1];
    const claims = this.tokens.verify<any>(bearer ?? readCookie(req.headers.cookie, ACCESS_COOKIE));

    if (claims?.typ === 'access') {
      if (claims.plat) req.session = { kind: 'platform', adminId: claims.aid } as Session;
      else req.session = { kind: 'tenant', userId: claims.uid, shopId: claims.sid, branchId: claims.bid, terminalId: claims.tid } as Session;
    }
    if (isPublic) return true;
    if (!req.session) throw E.unauthenticated();
    if (platformOnly && req.session.kind !== 'platform') throw E.forbidden('Platform administrators only');
    if (!platformOnly && req.session.kind !== 'tenant') throw E.forbidden('Shop users only');
    return true;
  }
}

/** Guard 2: tenant + subscription. Shop must be active; a restricted/cancelled subscription is read-only. */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: Db, private readonly features: FeatureService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const s: Session | undefined = req.session;
    if (!s || s.kind !== 'tenant') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    const allowRestricted = this.reflector.getAllAndOverride<boolean>(META.ALLOW_RESTRICTED, targets);

    const r: Resolved = await this.db.tenant({ shopId: s.shopId, userId: s.userId }, (tx) => this.features.resolve(tx, s.shopId));
    req.resolved = r;
    s.features = r.features;
    s.limits = r.limits;

    if (r.shopStatus === 'suspended') throw E.subscriptionRestricted('This shop is suspended');
    const readOnly = r.subscriptionStatus === 'restricted' || r.subscriptionStatus === 'cancelled';
    const safe = req.method === 'GET' || req.method === 'HEAD';
    if (readOnly && !safe && !allowRestricted) throw E.subscriptionRestricted();
    if (r.subscriptionStatus === 'past_due') ctx.switchToHttp().getResponse().setHeader('X-Subscription-Warning', 'past_due');
    return true;
  }
}

/** Guard 3: @RequireFeature. */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const need = this.reflector.getAllAndOverride<FeatureKey[]>(META.FEATURES, [ctx.getHandler(), ctx.getClass()]);
    if (!need?.length) return true;
    const s: TenantSession | undefined = ctx.switchToHttp().getRequest().session;
    if (!s || s.kind !== 'tenant') return true;
    for (const f of need) if (!s.features?.has(f)) throw E.featureNotEnabled(f);
    return true;
  }
}

/** Guard 4: @RequirePermission. Permissions are the union of the user's roles at the session branch, minus disabled features. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly db: Db, private readonly access: AccessService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const need = this.reflector.getAllAndOverride<Permission[]>(META.PERMISSIONS, [ctx.getHandler(), ctx.getClass()]);
    const s: TenantSession | undefined = ctx.switchToHttp().getRequest().session;
    if (!need?.length || !s || s.kind !== 'tenant') return true;
    const acc = await this.db.tenant({ shopId: s.shopId, userId: s.userId }, async (tx) => {
      const u = (await tx.query(`SELECT status FROM users WHERE shop_id=$1 AND id=$2`, [s.shopId, s.userId])).rows[0];
      if (!u || u.status !== 'active') throw E.unauthenticated('Account is inactive');
      return this.access.load(tx, s.userId, s.branchId, s.features ?? new Set());
    });
    s.permissions = acc.permissions;
    s.allBranches = acc.allBranches;
    s.branchIds = acc.branchIds;
    for (const p of need) if (!acc.permissions.has(p)) throw E.forbidden(`Missing permission: ${p}`);
    return true;
  }
}
