import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Patch } from '@nestjs/common';
import { FEATURES, LIMITS, SHOP_TYPES } from '@pos/contracts';
import { E } from '../common/errors';
import { CurrentSession, PlatformSession } from '../common/session';
import { parse, z } from '../common/validate';
import { Db } from '../db/db';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Public, PlatformOnly } from '../auth/decorators';
import { ACCESS_COOKIE } from '../auth/guards';
import { AdminFeatureService } from './admin-feature.service';
import { FeatureService } from './feature.service';
import { ShopProvisioningService } from './provisioning.service';
import { SubscriptionService } from './subscription.service';

/** Super Admin API (admin subdomain). Shops never reach these routes. */
@PlatformOnly()
@Controller('admin')
export class AdminController {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly provisioning: ShopProvisioningService,
    private readonly adminFeatures: AdminFeatureService,
    private readonly features: FeatureService,
    private readonly subs: SubscriptionService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: any) {
    const b = parse(z.object({ email: z.string().email(), password: z.string() }), body);
    const r = await this.auth.adminLogin({ ...b, ip: req.ip });
    req.res.cookie(ACCESS_COOKIE, r.accessToken, { httpOnly: true, sameSite: 'lax', path: '/' });
    return req.headers['x-token-mode'] === 'body' ? r : { admin: r.admin, expiresIn: r.expiresIn };
  }

  @Get('plans')
  plans() {
    return this.db.platform(async (tx) => {
      const plans = (await tx.query(`SELECT id, code, name, price_monthly, price_annual, trial_days, active FROM plan ORDER BY price_monthly`)).rows;
      const feats = (await tx.query(`SELECT plan_id, feature_key FROM plan_feature`)).rows;
      const lims = (await tx.query(`SELECT plan_id, limit_key, value FROM plan_limit`)).rows;
      return plans.map((p) => ({
        ...p,
        features: feats.filter((f) => f.plan_id === p.id).map((f) => f.feature_key),
        limits: Object.fromEntries(lims.filter((l) => l.plan_id === p.id).map((l) => [l.limit_key, l.value])),
      }));
    });
  }

  @Get('catalog')
  catalog() {
    return { features: FEATURES, limits: LIMITS, shopTypes: SHOP_TYPES };
  }

  @Get('shops')
  shops() {
    return this.db.platform(async (tx) =>
      (await tx.query(
        `SELECT s.id, s.name, s.shop_type, s.status, s.created_at, sub.status AS subscription_status, p.code AS plan
         FROM shop s LEFT JOIN subscription sub ON sub.shop_id = s.id LEFT JOIN plan p ON p.id = sub.plan_id ORDER BY s.created_at DESC`,
      )).rows,
    );
  }

  @Post('shops')
  create(@CurrentSession() a: PlatformSession, @Body() body: unknown) {
    const b = parse(
      z.object({
        name: z.string().min(1).max(120), shopType: z.enum(SHOP_TYPES), planCode: z.string(),
        ownerName: z.string().min(1), ownerEmail: z.string().email(), ownerPassword: z.string().min(8).optional(), trial: z.boolean().optional(),
      }),
      body,
    );
    return this.provisioning.create({ ...b, adminId: a.adminId });
  }

  @Get('shops/:id')
  view(@Param('id') id: string) {
    return this.db.platform(async (tx) => {
      const shop = (await tx.query(`SELECT id, name, shop_type, status, created_at FROM shop WHERE id=$1`, [id])).rows[0];
      if (!shop) throw E.notFound('Shop');
      const resolved = await this.features.resolve(tx, id);
      const overrides = (await tx.query(`SELECT feature_key, enabled, expires_at, reason FROM shop_feature_override WHERE shop_id=$1`, [id])).rows;
      const limitOverrides = (await tx.query(`SELECT limit_key, value, expires_at, reason FROM shop_limit_override WHERE shop_id=$1`, [id])).rows;
      const counts = (
        await tx.query(
          `SELECT (SELECT count(*)::int FROM users WHERE shop_id=$1 AND status='active') users,
                  (SELECT count(*)::int FROM branch WHERE shop_id=$1 AND status='active') branches,
                  (SELECT count(*)::int FROM terminal WHERE shop_id=$1 AND status='active') terminals`,
          [id],
        )
      ).rows[0];
      return { shop, plan: resolved.planCode, subscription: resolved.subscriptionStatus, features: [...resolved.features].sort(), limits: resolved.limits, overrides, limitOverrides, usage: counts };
    }, id);
  }

  @Patch('shops/:id/status')
  setStatus(@CurrentSession() a: PlatformSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ status: z.enum(['active', 'suspended']) }), body);
    return this.db.platform(async (tx) => {
      const r = await tx.query(`UPDATE shop SET status=$2 WHERE id=$1 RETURNING id, status`, [id, b.status]);
      if (!r.rowCount) throw E.notFound('Shop');
      await this.audit.record(tx, { shopId: id, actorId: a.adminId, actorType: 'platform', action: `shop.${b.status}`, entity: 'shop', entityId: id });
      return r.rows[0];
    }, id);
  }

  @Put('shops/:id/features')
  @HttpCode(204)
  async setFeature(@CurrentSession() a: PlatformSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ key: z.string(), enabled: z.boolean(), expiresAt: z.string().datetime().nullable().optional(), reason: z.string().optional() }), body);
    await this.db.platform((tx) => this.adminFeatures.setFeatureOverride(tx, a.adminId, id, b), id);
  }

  @Delete('shops/:id/features/:key')
  @HttpCode(204)
  async clearFeature(@CurrentSession() a: PlatformSession, @Param('id') id: string, @Param('key') key: string) {
    await this.db.platform((tx) => this.adminFeatures.clearFeatureOverride(tx, a.adminId, id, key), id);
  }

  @Put('shops/:id/limits')
  @HttpCode(204)
  async setLimit(@CurrentSession() a: PlatformSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ key: z.string(), value: z.number().int().min(0), expiresAt: z.string().datetime().nullable().optional(), reason: z.string().optional() }), body);
    await this.db.platform((tx) => this.adminFeatures.setLimitOverride(tx, a.adminId, id, b), id);
  }

  @Put('shops/:id/plan')
  @HttpCode(204)
  async changePlan(@CurrentSession() a: PlatformSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ planCode: z.string() }), body);
    await this.db.platform((tx) => this.subs.changePlan(tx, a.adminId, id, b.planCode), id);
  }

  @Put('shops/:id/subscription-status')
  @HttpCode(204)
  async setSubStatus(@CurrentSession() a: PlatformSession, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ status: z.enum(['trial', 'active', 'past_due', 'restricted', 'cancelled']) }), body);
    await this.db.platform((tx) => this.subs.setStatus(tx, a.adminId, id, b.status), id);
  }
}
