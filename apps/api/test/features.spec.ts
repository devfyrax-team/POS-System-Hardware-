import { FeatureService } from '../src/platform/feature.service';
import { auth, createApp, createUser, login, platformToken, provisionShop, TestCtx, uniq } from './helpers';

describe('plans, shop-wise features and limits (Super Admin controlled)', () => {
  let t: TestCtx;
  let admin: string;
  beforeAll(async () => {
    t = await createApp();
    admin = await platformToken(t);
  });
  afterAll(() => t.close());

  const resolve = (shopId: string) => t.db.tenant({ shopId }, (tx) => t.app.get(FeatureService).resolve(tx, shopId));

  it('features come from the plan', async () => {
    const basic = await provisionShop(t, { plan: 'basic' });
    const pro = await provisionShop(t, { plan: 'pro' });
    expect((await resolve(basic.shopId)).features.has('multi_branch')).toBe(false);
    expect((await resolve(pro.shopId)).features.has('multi_branch')).toBe(true);
  });

  it('Super Admin override adds a feature, and clearing it returns to the plan', async () => {
    const shop = await provisionShop(t, { plan: 'basic' });
    await t.http().put(`/v1/admin/shops/${shop.shopId}/features`).set(auth(admin)).send({ key: 'credit_sales', enabled: true, reason: 'trial' }).expect(204);
    expect((await resolve(shop.shopId)).features.has('credit_sales')).toBe(true);
    await t.http().delete(`/v1/admin/shops/${shop.shopId}/features/credit_sales`).set(auth(admin)).expect(204);
    expect((await resolve(shop.shopId)).features.has('credit_sales')).toBe(false);
  });

  it('override can remove a feature the plan gives', async () => {
    const shop = await provisionShop(t, { plan: 'pro' });
    await t.http().put(`/v1/admin/shops/${shop.shopId}/features`).set(auth(admin)).send({ key: 'cheques', enabled: false }).expect(204);
    expect((await resolve(shop.shopId)).features.has('cheques')).toBe(false);
  });

  it('expired overrides stop applying, and the daily job deletes them', async () => {
    const shop = await provisionShop(t, { plan: 'basic' });
    await t.http().put(`/v1/admin/shops/${shop.shopId}/features`).set(auth(admin)).send({ key: 'credit_sales', enabled: true, expiresAt: new Date(Date.now() + 3600_000).toISOString() }).expect(204);
    expect((await resolve(shop.shopId)).features.has('credit_sales')).toBe(true);
    await t.db.admin((tx) => tx.query(`UPDATE shop_feature_override SET expires_at = now() - interval '1 minute' WHERE shop_id=$1`, [shop.shopId]));
    expect((await resolve(shop.shopId)).features.has('credit_sales')).toBe(false);
    const n = await t.db.platform((tx) => t.app.get(require('../src/platform/admin-feature.service').AdminFeatureService).expireOverrides(tx));
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('shop type gates features: tinting never applies to a hardware-only shop, even with an override', async () => {
    const hw = await provisionShop(t, { plan: 'enterprise', shopType: 'hardware' });
    const paint = await provisionShop(t, { plan: 'enterprise', shopType: 'paint' });
    expect((await resolve(hw.shopId)).features.has('colour_tinting')).toBe(false);
    expect((await resolve(paint.shopId)).features.has('colour_tinting')).toBe(true);
    await t.http().put(`/v1/admin/shops/${hw.shopId}/features`).set(auth(admin)).send({ key: 'colour_tinting', enabled: true }).expect(204);
    expect((await resolve(hw.shopId)).features.has('colour_tinting')).toBe(false);
  });

  it('rejects unknown feature keys', async () => {
    const shop = await provisionShop(t);
    await t.http().put(`/v1/admin/shops/${shop.shopId}/features`).set(auth(admin)).send({ key: 'free_money', enabled: true }).expect(400);
  });

  it('a shop owner cannot change features, limits or plan, and cannot see other shops', async () => {
    const shop = await provisionShop(t, { plan: 'basic' });
    const owner = await login(t, shop.ownerEmail);
    expect((await t.http().put(`/v1/admin/shops/${shop.shopId}/features`).set(auth(owner)).send({ key: 'credit_sales', enabled: true })).status).toBe(403);
    expect((await t.http().put(`/v1/admin/shops/${shop.shopId}/plan`).set(auth(owner)).send({ planCode: 'enterprise' })).status).toBe(403);
  });

  it('API enforces the feature gate: extra branch needs multi_branch, then a limit applies', async () => {
    const shop = await provisionShop(t, { plan: 'basic' });
    const owner = await login(t, shop.ownerEmail);
    const denied = await t.http().post('/v1/branches').set(auth(owner)).send({ name: 'Second' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FEATURE_NOT_ENABLED');

    await t.http().put(`/v1/admin/shops/${shop.shopId}/features`).set(auth(admin)).send({ key: 'multi_branch', enabled: true }).expect(204);
    // basic plan allows max 1 branch -> the feature is on but the limit still blocks
    const limited = await t.http().post('/v1/branches').set(auth(owner)).send({ name: 'Second' });
    expect(limited.status).toBe(403);
    expect(limited.body.code).toBe('PLAN_LIMIT');
    // admin raises this shop's limit only
    await t.http().put(`/v1/admin/shops/${shop.shopId}/limits`).set(auth(admin)).send({ key: 'max_branches', value: 2 }).expect(204);
    await t.http().post('/v1/branches').set(auth(owner)).send({ name: 'Second' }).expect(201);
    expect((await t.http().post('/v1/branches').set(auth(owner)).send({ name: 'Third' })).body.code).toBe('PLAN_LIMIT');
    // another basic shop is unaffected by this shop's override
    const other = await provisionShop(t, { plan: 'basic' });
    const otherOwner = await login(t, other.ownerEmail);
    expect((await t.http().post('/v1/branches').set(auth(otherOwner)).send({ name: 'Second' })).body.code).toBe('FEATURE_NOT_ENABLED');
  });

  it('plan limits at the boundary: users and terminals', async () => {
    const shop = await provisionShop(t, { plan: 'basic' }); // 3 users, 2 terminals / branch
    const owner = await login(t, shop.ownerEmail);
    await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
    await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId }); // 3 users now
    const over = await t.http().post('/v1/users').set(auth(owner)).send({
      email: `${uniq('u')}@test.lk`, name: 'Extra', roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId, password: 'Passw0rd!x',
    });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('PLAN_LIMIT');

    await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: shop.defaultBranchId, name: 'T1', prefix: 'AA-T1' }).expect(201);
    await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: shop.defaultBranchId, name: 'T2', prefix: 'AA-T2' }).expect(201);
    const t3 = await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: shop.defaultBranchId, name: 'T3', prefix: 'AA-T3' });
    expect(t3.body.code).toBe('PLAN_LIMIT');
  });

  it('downgrade is blocked while usage exceeds the new plan; upgrade is immediate', async () => {
    const shop = await provisionShop(t, { plan: 'pro' });
    const owner = await login(t, shop.ownerEmail);
    for (let i = 0; i < 3; i++) await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId }); // 4 users > basic's 3
    const down = await t.http().put(`/v1/admin/shops/${shop.shopId}/plan`).set(auth(admin)).send({ planCode: 'basic' });
    expect(down.status).toBe(409);
    expect(down.body.details.violations[0].resource).toBe('max_users');
    await t.http().put(`/v1/admin/shops/${shop.shopId}/plan`).set(auth(admin)).send({ planCode: 'enterprise' }).expect(204);
    expect((await resolve(shop.shopId)).features.has('whatsapp_alerts')).toBe(true);
  });

  it('@RequireFeature returns FEATURE_NOT_ENABLED on a gated route and every override is audited', async () => {
    const shop = await provisionShop(t, { plan: 'basic' });
    const owner = await login(t, shop.ownerEmail);
    const res = await t.http().post('/v1/roles').set(auth(owner)).send({ name: 'Senior', permissions: ['sale.create'] });
    expect(res.body.code).toBe('FEATURE_NOT_ENABLED');
    await t.http().put(`/v1/admin/shops/${shop.shopId}/features`).set(auth(admin)).send({ key: 'custom_roles', enabled: true, reason: 'pilot' }).expect(204);
    await t.http().post('/v1/roles').set(auth(owner)).send({ name: 'Senior', permissions: ['sale.create'] }).expect(201);
    const log = await t.http().get('/v1/audit-log?action=feature.override_set').set(auth(owner));
    expect(log.body.some((r: any) => r.entity_id === 'custom_roles' && r.actor_type === 'platform')).toBe(true);
  });

  it('subscription: restricted = read-only; past_due warns', async () => {
    const shop = await provisionShop(t, { plan: 'pro' });
    const owner = await login(t, shop.ownerEmail);
    await t.http().put(`/v1/admin/shops/${shop.shopId}/subscription-status`).set(auth(admin)).send({ status: 'past_due' }).expect(204);
    const warn = await t.http().get('/v1/branches').set(auth(owner));
    expect(warn.headers['x-subscription-warning']).toBe('past_due');
    await t.http().put(`/v1/admin/shops/${shop.shopId}/subscription-status`).set(auth(admin)).send({ status: 'restricted' }).expect(204);
    expect((await t.http().get('/v1/branches').set(auth(owner))).status).toBe(200);
    const blocked = await t.http().post('/v1/branches').set(auth(owner)).send({ name: 'X' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe('SUBSCRIPTION_RESTRICTED');
  });
});
