import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { config } from '../common/config';
import { E } from '../common/errors';
import { CurrentTenant, TenantSession } from '../common/session';
import { parse, z } from '../common/validate';
import { Db } from '../db/db';
import { AccessService } from '../identity/access.service';
import { BranchService } from '../identity/branch.service';
import { FeatureService } from '../platform/feature.service';
import { AllowWhenRestricted, Public } from './decorators';
import { AuthResult, AuthService } from './auth.service';
import { ACCESS_COOKIE, REFRESH_COOKIE, readCookie } from './guards';

function setCookies(res: any, r: Pick<AuthResult, 'accessToken' | 'refreshToken'>) {
  const base = { httpOnly: true, secure: config().cookieSecure, sameSite: 'lax' as const, path: '/' };
  res.cookie(ACCESS_COOKIE, r.accessToken, { ...base, maxAge: config().accessTtlSec * 1000 });
  if (r.refreshToken) res.cookie(REFRESH_COOKIE, r.refreshToken, { ...base, maxAge: config().refreshTtlSec * 1000, path: '/v1/auth' });
}

/** Browser clients get HTTP-only cookies; API/till wrappers can ask for tokens in the body. */
function present(req: any, r: AuthResult) {
  const body = req.headers['x-token-mode'] === 'body';
  const { accessToken, refreshToken, ...rest } = r;
  return body ? r : rest;
}

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1), terminalId: z.string().uuid().optional() });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Db,
    private readonly features: FeatureService,
    private readonly access: AccessService,
    private readonly branches: BranchService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const b = parse(loginSchema, body);
    const r = await this.auth.login({ ...b, ip: req.ip });
    setCookies(res, r);
    return present(req, r);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: any, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const raw = body?.refreshToken ?? readCookie(req.headers.cookie, REFRESH_COOKIE);
    if (!raw) throw E.unauthenticated('No refresh token');
    const r = await this.auth.refresh(raw);
    setCookies(res, r);
    return present(req, r);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: any, @Req() req: any, @Res({ passthrough: true }) res: any) {
    await this.auth.logout(body?.refreshToken ?? readCookie(req.headers.cookie, REFRESH_COOKIE));
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
  }

  @Post('pin-switch')
  @HttpCode(200)
  async pinSwitch(@CurrentTenant() s: TenantSession, @Body() body: unknown, @Req() req: any, @Res({ passthrough: true }) res: any) {
    const b = parse(z.object({ userId: z.string().uuid(), pin: z.string().regex(/^\d{4,8}$/) }), body);
    const r = await this.auth.switchUserByPin(s, b);
    setCookies(res, r);
    return present(req, r);
  }

  @AllowWhenRestricted()
  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentTenant() s: TenantSession, @Body() body: unknown) {
    const b = parse(z.object({ oldPassword: z.string(), newPassword: z.string().min(8) }), body);
    await this.db.tenant({ shopId: s.shopId, userId: s.userId }, (tx) => this.auth.changePassword(tx, s, b.oldPassword, b.newPassword));
  }

  /** Session bootstrap: who am I, what can I do, which features/limits does my shop have. */
  @AllowWhenRestricted()
  @Get('/me')
  async me(@CurrentTenant() s: TenantSession) {
    return this.db.tenant({ shopId: s.shopId, userId: s.userId }, async (tx) => {
      const r = await this.features.resolve(tx, s.shopId);
      const acc = await this.access.load(tx, s.userId, s.branchId, r.features);
      const user = (await tx.query(`SELECT id, name, email, must_change_password FROM users WHERE shop_id=$1 AND id=$2`, [s.shopId, s.userId])).rows[0];
      const shop = (await tx.query(`SELECT id, name, shop_type FROM shop WHERE id=$1`, [s.shopId])).rows[0];
      const branchMode = await this.branches.mode(tx, s.shopId);
      return {
        user, shop, session: { branchId: s.branchId, terminalId: s.terminalId },
        permissions: [...acc.permissions].sort(),
        features: [...r.features].sort(),
        limits: r.limits,
        subscription: { status: r.subscriptionStatus, plan: r.planCode },
        branchMode,
      };
    });
  }
}
