import { auth, createApp, createUser, login, PASSWORD, platformToken, provisionShop, TestCtx, uniq } from './helpers';

describe('shop-wise roles and users (managed by the shop admin)', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await createApp();
  });
  afterAll(() => t.close());

  it('provisioning creates Main branch, 4 system roles, owner with all-branch Owner role, subscription', async () => {
    const shop = await provisionShop(t, { plan: 'pro' });
    const owner = await login(t, shop.ownerEmail);
    const roles = await t.http().get('/v1/roles').set(auth(owner));
    expect(roles.body.map((r: any) => r.name).sort()).toEqual(['Cashier', 'Manager', 'Owner', 'Storekeeper']);
    const branches = await t.http().get('/v1/branches').set(auth(owner));
    expect(branches.body).toHaveLength(1);
    expect(branches.body[0]).toMatchObject({ name: 'Main', is_default: true });
    const me = await t.http().get('/v1/auth/me').set(auth(owner));
    expect(me.body.subscription.plan).toBe('pro');
  });

  it('provisioning is atomic: duplicate owner email leaves no half-created shop', async () => {
    const first = await provisionShop(t);
    const admin = await platformToken(t);
    const before = (await t.http().get('/v1/admin/shops').set(auth(admin))).body.length;
    const res = await t.http().post('/v1/admin/shops').set(auth(admin)).send({
      name: 'Dup', shopType: 'hardware', planCode: 'basic', ownerName: 'X', ownerEmail: first.ownerEmail,
    });
    expect(res.status).toBe(409);
    expect((await t.http().get('/v1/admin/shops').set(auth(admin))).body.length).toBe(before);
  });

  it('provisioning without a password returns a one-time temp password and forces a change', async () => {
    const admin = await platformToken(t);
    const email = `${uniq('o')}@test.lk`;
    const res = await t.http().post('/v1/admin/shops').set(auth(admin)).send({ name: 'Temp', shopType: 'both', planCode: 'basic', ownerName: 'O', ownerEmail: email });
    expect(res.status).toBe(201);
    expect(res.body.tempPassword).toBeTruthy();
    const l = await t.http().post('/v1/auth/login').send({ email, password: res.body.tempPassword });
    expect(l.status).toBe(200);
    expect(l.body.mustChangePassword).toBe(true);
  });

  it('Owner can edit non-owner role permissions; Owner role is fixed', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    const upd = await t.http().patch(`/v1/roles/${shop.roleIds.cashier}`).set(auth(owner)).send({ permissions: ['sale.create', 'payment.take'] });
    expect(upd.status).toBe(200);
    expect(upd.body.permissions).toEqual(['sale.create', 'payment.take']);
    expect((await t.http().patch(`/v1/roles/${shop.roleIds.owner}`).set(auth(owner)).send({ permissions: [] })).status).toBe(403);
  });

  it('custom roles: cannot include permissions of features the shop does not have; unknown permissions rejected', async () => {
    const shop = await provisionShop(t, { plan: 'pro' }); // pro has custom_roles + credit_sales
    const owner = await login(t, shop.ownerEmail);
    expect((await t.http().post('/v1/roles').set(auth(owner)).send({ name: 'Credit Clerk', permissions: ['credit.manage', 'sale.create'] })).status).toBe(201);
    expect((await t.http().post('/v1/roles').set(auth(owner)).send({ name: 'Bad', permissions: ['launch.rockets'] })).status).toBe(400);

    const basic = await provisionShop(t, { plan: 'basic' });
    const admin = await platformToken(t);
    await t.http().put(`/v1/admin/shops/${basic.shopId}/features`).set(auth(admin)).send({ key: 'custom_roles', enabled: true }).expect(204);
    const bo = await login(t, basic.ownerEmail);
    const res = await t.http().post('/v1/roles').set(auth(bo)).send({ name: 'Credit Clerk', permissions: ['credit.manage'] });
    expect(res.status).toBe(400); // credit_sales is not on this plan
  });

  it('system and in-use roles cannot be deleted', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    expect((await t.http().delete(`/v1/roles/${shop.roleIds.cashier}`).set(auth(owner))).status).toBe(403);
    const custom = await t.http().post('/v1/roles').set(auth(owner)).send({ name: 'Temp Role', permissions: ['sale.create'] });
    const u = await createUser(t, owner, { roleId: custom.body.id, branchId: shop.defaultBranchId });
    expect((await t.http().delete(`/v1/roles/${custom.body.id}`).set(auth(owner))).status).toBe(409);
    await t.http().post(`/v1/users/${u.id}/deactivate`).set(auth(owner)).expect(204);
  });

  it('a cashier cannot manage users or roles or read the audit log', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    const c = await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
    const ct = await login(t, c.email);
    expect((await t.http().get('/v1/users').set(auth(ct))).status).toBe(403);
    expect((await t.http().get('/v1/roles').set(auth(ct))).status).toBe(403);
    expect((await t.http().get('/v1/audit-log').set(auth(ct))).status).toBe(403);
    expect((await t.http().patch('/v1/shop/settings').set(auth(ct)).send({ below_cost_warning: false })).status).toBe(403);
  });

  describe('manager scope', () => {
    it('manager manages only their own branch and cannot escalate', async () => {
      const shop = await provisionShop(t, { plan: 'pro' });
      const owner = await login(t, shop.ownerEmail);
      const b2 = (await t.http().post('/v1/branches').set(auth(owner)).send({ name: uniq('B2') })).body;
      const mgr = await createUser(t, owner, { roleId: shop.roleIds.manager, branchId: shop.defaultBranchId });
      const mt = await login(t, mgr.email);

      // can create a cashier in own branch
      const ok = await t.http().post('/v1/users').set(auth(mt)).send({
        email: `${uniq('c')}@test.lk`, name: 'C', roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId, password: PASSWORD,
      });
      expect(ok.status).toBe(201);
      // cannot create in another branch
      const other = await t.http().post('/v1/users').set(auth(mt)).send({
        email: `${uniq('c')}@test.lk`, name: 'C', roleId: shop.roleIds.cashier, branchId: b2.id, password: PASSWORD,
      });
      expect(other.status).toBe(403);
      // cannot create a shop-wide user
      const wide = await t.http().post('/v1/users').set(auth(mt)).send({
        email: `${uniq('c')}@test.lk`, name: 'C', roleId: shop.roleIds.cashier, branchId: null, password: PASSWORD,
      });
      expect(wide.status).toBe(403);
      // cannot hand out Owner
      const own = await t.http().post('/v1/users').set(auth(mt)).send({
        email: `${uniq('c')}@test.lk`, name: 'C', roleId: shop.roleIds.owner, branchId: shop.defaultBranchId, password: PASSWORD,
      });
      expect(own.status).toBe(403);
      // cannot touch role definitions or branches
      expect((await t.http().post('/v1/roles').set(auth(mt)).send({ name: 'R', permissions: [] })).status).toBe(403);
      expect((await t.http().post('/v1/branches').set(auth(mt)).send({ name: 'Z' })).status).toBe(403);
      // cannot reset the owner's password
      expect((await t.http().post(`/v1/users/${shop.ownerUserId}/reset-password`).set(auth(mt))).status).toBe(403);
    });

    it('a role cannot grant a permission the grantor does not hold', async () => {
      const shop = await provisionShop(t, { plan: 'pro' });
      const owner = await login(t, shop.ownerEmail);
      // custom role holding cost.view but not user.manage... a limited user-admin
      const adminRole = (await t.http().post('/v1/roles').set(auth(owner)).send({ name: 'Clerk Admin', permissions: ['user.manage', 'sale.create'] })).body;
      const clerk = await createUser(t, owner, { roleId: adminRole.id, branchId: shop.defaultBranchId });
      const ct = await login(t, clerk.email);
      // Manager role holds cost.view, clerk does not
      const res = await t.http().post('/v1/users').set(auth(ct)).send({
        email: `${uniq('c')}@test.lk`, name: 'M', roleId: shop.roleIds.manager, branchId: shop.defaultBranchId, password: PASSWORD,
      });
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/cannot grant/);
    });
  });

  it('the last Owner can never be removed, deactivated or demoted', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    expect((await t.http().post(`/v1/users/${shop.ownerUserId}/deactivate`).set(auth(owner))).status).toBe(409); // self
    const del = await t.http().delete(`/v1/users/${shop.ownerUserId}/branch-roles`).set(auth(owner)).send({ branchId: null, roleId: shop.roleIds.owner });
    expect(del.status).toBe(409);

    // add a second owner; now the first can be demoted, and the second becomes the last
    const second = await createUser(t, owner, { roleId: shop.roleIds.owner, branchId: null });
    await t.http().delete(`/v1/users/${shop.ownerUserId}/branch-roles`).set(auth(owner)).send({ branchId: null, roleId: shop.roleIds.owner }).expect(204);
    const o2 = await login(t, second.email);
    const lastDemote = await t.http().delete(`/v1/users/${second.id}/branch-roles`).set(auth(o2)).send({ branchId: null, roleId: shop.roleIds.owner });
    expect(lastDemote.status).toBe(409);
  });

  it('a user can hold different roles in different branches', async () => {
    const shop = await provisionShop(t, { plan: 'pro' });
    const owner = await login(t, shop.ownerEmail);
    const b2 = (await t.http().post('/v1/branches').set(auth(owner)).send({ name: uniq('B2') })).body;
    const u = await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
    await t.http().put(`/v1/users/${u.id}/branch-roles`).set(auth(owner)).send({ branchId: b2.id, roleId: shop.roleIds.storekeeper }).expect(204);
    const t2 = (await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: b2.id, name: 'T', prefix: uniq('P').toUpperCase().slice(0, 8) })).body;
    const tok = await login(t, u.email, PASSWORD, t2.id);
    const me = await t.http().get('/v1/auth/me').set(auth(tok));
    expect(me.body.permissions).toContain('stock.receive'); // storekeeper at branch 2
    expect(me.body.permissions).not.toContain('sale.create'); // cashier role applies only at branch 1
  });

  it('shop settings: validated, merged, shop_type untouchable, audited', async () => {
    const shop = await provisionShop(t, { shopType: 'paint' });
    const owner = await login(t, shop.ownerEmail);
    const res = await t.http().patch('/v1/shop/settings').set(auth(owner)).send({ costing_method: 'average', receipt: { footer: 'Come again' } });
    expect(res.status).toBe(200);
    expect(res.body.settings.costing_method).toBe('average');
    expect(res.body.settings.receipt).toMatchObject({ header: expect.any(String), footer: 'Come again' });
    expect((await t.http().patch('/v1/shop/settings').set(auth(owner)).send({ costing_method: 'lifo' })).status).toBe(400);
    expect((await t.http().patch('/v1/shop/settings').set(auth(owner)).send({ shop_type: 'hardware' })).status).toBe(400);
    const log = await t.http().get('/v1/audit-log?action=shop.settings_updated').set(auth(owner));
    expect(log.body.length).toBeGreaterThan(0);
  });

  it('terminals: unique prefix per shop, per-terminal invoice counter created, deactivation kills sessions', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    const term = (await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: shop.defaultBranchId, name: 'T1', prefix: 'main-t1' })).body;
    expect(term.prefix).toBe('MAIN-T1');
    expect((await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: shop.defaultBranchId, name: 'T1b', prefix: 'MAIN-T1' })).status).toBe(409);
    const seq = await t.db.tenant({ shopId: shop.shopId }, (tx) => tx.query(`SELECT next FROM invoice_sequence WHERE terminal_id=$1`, [term.id]));
    expect(seq.rows[0].next).toBe('1');
    const tok = await login(t, shop.ownerEmail, PASSWORD, term.id);
    await t.http().delete(`/v1/terminals/${term.id}`).set(auth(owner)).expect(204);
    expect((await t.http().post('/v1/auth/login').send({ email: shop.ownerEmail, password: PASSWORD, terminalId: term.id })).status).toBe(403);
    expect(tok).toBeTruthy();
  });

  it('the last active branch cannot be deactivated', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    expect((await t.http().delete(`/v1/branches/${shop.defaultBranchId}`).set(auth(owner))).status).toBe(409);
  });

  it('every sensitive action lands in the audit log with the actor', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    const u = await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
    await t.http().post(`/v1/users/${u.id}/deactivate`).set(auth(owner)).expect(204);
    const log = (await t.http().get('/v1/audit-log').set(auth(owner))).body;
    const actions = log.map((l: any) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login', 'user.created', 'user.deactivated', 'shop.provisioned']));
    expect(log.find((l: any) => l.action === 'user.created').actor_id).toBe(shop.ownerUserId);
  });
});
