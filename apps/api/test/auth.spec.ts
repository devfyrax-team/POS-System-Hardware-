import { auth, createApp, createUser, login, PASSWORD, platformToken, provisionShop, TestCtx, uniq } from './helpers';

describe('authentication', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await createApp();
  });
  afterAll(() => t.close());

  it('logs in, returns the session, and /me shows permissions, features and branch mode', async () => {
    const shop = await provisionShop(t, { plan: 'basic' });
    const token = await login(t, shop.ownerEmail);
    const me = await t.http().get('/v1/auth/me').set(auth(token));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(shop.ownerEmail);
    expect(me.body.permissions).toContain('role.manage');
    expect(me.body.features).toContain('quotations');
    expect(me.body.features).not.toContain('multi_branch');
    expect(me.body.branchMode.mode).toBe('single');
    expect(me.body.session.branchId).toBe(shop.defaultBranchId); // auto-bound
  });

  it('rejects wrong password and unknown user with the same message', async () => {
    const shop = await provisionShop(t);
    const a = await t.http().post('/v1/auth/login').send({ email: shop.ownerEmail, password: 'wrong-password' });
    const b = await t.http().post('/v1/auth/login').send({ email: 'nobody@test.lk', password: 'whatever1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('requires authentication on protected routes', async () => {
    expect((await t.http().get('/v1/auth/me')).status).toBe(401);
    expect((await t.http().get('/v1/users')).status).toBe(401);
    expect((await t.http().get('/v1/users').set(auth('garbage.token'))).status).toBe(401);
  });

  it('sets HTTP-only cookies and hides tokens from the body by default', async () => {
    const shop = await provisionShop(t);
    const res = await t.http().post('/v1/auth/login').send({ email: shop.ownerEmail, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeUndefined();
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookies).toMatch(/pos_at=.*HttpOnly/i);
    expect(cookies).toMatch(/pos_rt=.*HttpOnly/i);
    // the cookie alone authenticates
    const jar = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const me = await t.http().get('/v1/auth/me').set('Cookie', jar);
    expect(me.status).toBe(200);
  });

  it('rotates refresh tokens and detects reuse (whole family revoked)', async () => {
    const shop = await provisionShop(t);
    const l = await t.http().post('/v1/auth/login').set('x-token-mode', 'body').send({ email: shop.ownerEmail, password: PASSWORD });
    const r1 = l.body.refreshToken;
    const second = await t.http().post('/v1/auth/refresh').set('x-token-mode', 'body').send({ refreshToken: r1 });
    expect(second.status).toBe(200);
    const r2 = second.body.refreshToken;
    expect(r2).not.toBe(r1);
    // replaying the old token = theft signal
    const replay = await t.http().post('/v1/auth/refresh').send({ refreshToken: r1 });
    expect(replay.status).toBe(401);
    // ... and the legitimately rotated token is now dead too
    const after = await t.http().post('/v1/auth/refresh').send({ refreshToken: r2 });
    expect(after.status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const shop = await provisionShop(t);
    const l = await t.http().post('/v1/auth/login').set('x-token-mode', 'body').send({ email: shop.ownerEmail, password: PASSWORD });
    await t.http().post('/v1/auth/logout').send({ refreshToken: l.body.refreshToken }).expect(204);
    expect((await t.http().post('/v1/auth/refresh').send({ refreshToken: l.body.refreshToken })).status).toBe(401);
  });

  it('rate-limits repeated failed logins', async () => {
    const shop = await provisionShop(t);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await t.http().post('/v1/auth/login').send({ email: shop.ownerEmail, password: 'bad-password-x' })).status;
    }
    expect(last).toBe(429);
  });

  it('suspended shops cannot log in or use an existing token', async () => {
    const shop = await provisionShop(t);
    const token = await login(t, shop.ownerEmail);
    const admin = await platformToken(t);
    await t.http().patch(`/v1/admin/shops/${shop.shopId}/status`).set(auth(admin)).send({ status: 'suspended' }).expect(200);
    expect((await t.http().get('/v1/auth/me').set(auth(token))).status).toBe(402);
    expect((await t.http().post('/v1/auth/login').send({ email: shop.ownerEmail, password: PASSWORD })).status).toBe(402);
    await t.http().patch(`/v1/admin/shops/${shop.shopId}/status`).set(auth(admin)).send({ status: 'active' }).expect(200);
    expect((await t.http().get('/v1/auth/me').set(auth(token))).status).toBe(200);
  });

  it('keeps platform and shop worlds apart', async () => {
    const shop = await provisionShop(t);
    const shopToken = await login(t, shop.ownerEmail);
    const admin = await platformToken(t);
    expect((await t.http().get('/v1/admin/shops').set(auth(shopToken))).status).toBe(403); // shop user on admin route
    expect((await t.http().get('/v1/users').set(auth(admin))).status).toBe(403); // admin on shop route
    expect((await t.http().get('/v1/admin/shops').set(auth(admin))).status).toBe(200);
  });

  it('PIN switch on a registered terminal: right PIN works, wrong PIN fails and locks out', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    const term = await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: shop.defaultBranchId, name: 'T1', prefix: 'MAIN-T1' }).expect(201);
    const cashier = await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
    await t.http().put(`/v1/users/${cashier.id}/pin`).set(auth(owner)).send({ pin: '1234' }).expect(204);

    const termToken = await login(t, shop.ownerEmail, PASSWORD, term.body.id); // a till session
    const ok = await t.http().post('/v1/auth/pin-switch').set(auth(termToken)).set('x-token-mode', 'body').send({ userId: cashier.id, pin: '1234' });
    expect(ok.status).toBe(200);
    const me = await t.http().get('/v1/auth/me').set(auth(ok.body.accessToken));
    expect(me.body.user.id).toBe(cashier.id);
    expect(me.body.permissions).toContain('sale.create');
    expect(me.body.permissions).not.toContain('cost.view');
    expect(me.body.session.terminalId).toBe(term.body.id);

    let status = 0;
    for (let i = 0; i < 7; i++) status = (await t.http().post('/v1/auth/pin-switch').set(auth(termToken)).send({ userId: cashier.id, pin: '9999' })).status;
    expect(status).toBe(429);
  });

  it('PIN switch needs a terminal session', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail); // no terminal
    const res = await t.http().post('/v1/auth/pin-switch').set(auth(owner)).send({ userId: shop.ownerUserId, pin: '1234' });
    expect(res.status).toBe(403);
  });

  it('a user with a role only in branch A cannot start a session on branch B terminal', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    const b2 = await t.http().post('/v1/branches').set(auth(owner)).send({ name: uniq('Second') }).expect(201);
    const t2 = await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: b2.body.id, name: 'T', prefix: 'B2-T1' }).expect(201);
    const cashier = await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
    const res = await t.http().post('/v1/auth/login').send({ email: cashier.email, password: PASSWORD, terminalId: t2.body.id });
    expect(res.status).toBe(403);
  });

  it('change password revokes sessions', async () => {
    const shop = await provisionShop(t);
    const l = await t.http().post('/v1/auth/login').set('x-token-mode', 'body').send({ email: shop.ownerEmail, password: PASSWORD });
    await t.http().post('/v1/auth/change-password').set(auth(l.body.accessToken)).send({ oldPassword: PASSWORD, newPassword: 'NewPassw0rd!' }).expect(204);
    expect((await t.http().post('/v1/auth/refresh').send({ refreshToken: l.body.refreshToken })).status).toBe(401);
    expect((await t.http().post('/v1/auth/login').send({ email: shop.ownerEmail, password: PASSWORD })).status).toBe(401);
    expect((await t.http().post('/v1/auth/login').send({ email: shop.ownerEmail, password: 'NewPassw0rd!' })).status).toBe(200);
  });

  it('select-terminal binds a signed-in user to a till; needs a role at that branch; tokens carry the terminal', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    const term = await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: shop.defaultBranchId, name: 'T1', prefix: 'SEL-T1' }).expect(201);
    const cashier = await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
    const l = await t.http().post('/v1/auth/login').set('x-token-mode', 'body').send({ email: cashier.email, password: PASSWORD });
    expect((await t.http().get('/v1/auth/me').set(auth(l.body.accessToken))).body.session.terminalId).toBeUndefined();
    const sel = await t.http().post('/v1/auth/select-terminal').set(auth(l.body.accessToken)).set('x-token-mode', 'body').send({ terminalId: term.body.id });
    expect(sel.status).toBe(200);
    expect((await t.http().get('/v1/auth/me').set(auth(sel.body.accessToken))).body.session).toMatchObject({ terminalId: term.body.id, branchId: shop.defaultBranchId });
    // a refresh keeps the terminal
    const r = await t.http().post('/v1/auth/refresh').set('x-token-mode', 'body').send({ refreshToken: sel.body.refreshToken });
    expect(r.body.session.terminalId).toBe(term.body.id);
    // another shop's terminal is refused
    const other = await provisionShop(t);
    const ot = await t.http().post('/v1/terminals').set(auth(await login(t, other.ownerEmail))).send({ branchId: other.defaultBranchId, name: 'X', prefix: 'OTH-T1' }).expect(201);
    expect((await t.http().post('/v1/auth/select-terminal').set(auth(l.body.accessToken)).send({ terminalId: ot.body.id })).status).toBe(403);
  });
});
