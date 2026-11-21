import { IdempotencyService } from '../src/common/idempotency.service';
import { JobQueue } from '../src/jobs/job-queue';
import { OutboxService } from '../src/jobs/outbox.service';
import { ApprovalService } from '../src/identity/approval.service';
import { auth, createApp, createUser, login, provisionShop, TestCtx } from './helpers';

describe('idempotency', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await createApp();
  });
  afterAll(() => t.close());

  it('returns the stored response for a repeated key and rejects a different body', async () => {
    const shop = await provisionShop(t);
    const idem = t.app.get(IdempotencyService);
    const hash = IdempotencyService.hashRequest({ a: 1 });
    await t.db.tenant({ shopId: shop.shopId }, async (tx) => {
      expect(await idem.claim(tx, shop.shopId, 'k1', hash)).toBeNull();
      await idem.complete(tx, shop.shopId, 'k1', 201, { invoice: 'MAIN-T1-000001' });
    });
    await t.db.tenant({ shopId: shop.shopId }, async (tx) => {
      expect(await idem.claim(tx, shop.shopId, 'k1', hash)).toEqual({ statusCode: 201, body: { invoice: 'MAIN-T1-000001' } });
    });
    await expect(
      t.db.tenant({ shopId: shop.shopId }, (tx) => idem.claim(tx, shop.shopId, 'k1', IdempotencyService.hashRequest({ a: 2 }))),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('two concurrent requests with one key: the second waits and sees the first result (one winner)', async () => {
    const shop = await provisionShop(t);
    const idem = t.app.get(IdempotencyService);
    const hash = IdempotencyService.hashRequest({ cart: 'x' });
    const work = async () =>
      t.db.tenant({ shopId: shop.shopId }, async (tx) => {
        const existing = await idem.claim(tx, shop.shopId, 'same-key', hash);
        if (existing) return { replay: true, body: existing.body };
        await new Promise((r) => setTimeout(r, 150)); // business work
        await idem.complete(tx, shop.shopId, 'same-key', 200, { sale: 1 });
        return { replay: false, body: { sale: 1 } };
      });
    const results = await Promise.all([work(), work(), work()]);
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(results.filter((r) => r.replay)).toHaveLength(2);
    expect(results.every((r) => (r.body as any).sale === 1)).toBe(true);
  });

  it('keys are scoped per shop', async () => {
    const a = await provisionShop(t);
    const b = await provisionShop(t);
    const idem = t.app.get(IdempotencyService);
    const h = IdempotencyService.hashRequest({});
    await t.db.tenant({ shopId: a.shopId }, (tx) => idem.claim(tx, a.shopId, 'shared', h));
    expect(await t.db.tenant({ shopId: b.shopId }, (tx) => idem.claim(tx, b.shopId, 'shared', h))).toBeNull();
  });
});

describe('job queue and outbox', () => {
  let t: TestCtx;
  let jobs: JobQueue;
  beforeAll(async () => {
    t = await createApp();
    jobs = t.app.get(JobQueue);
    await t.db.admin((tx) => tx.query(`DELETE FROM job`));
  });
  afterAll(() => t.close());

  it('runs a queued job once and marks it done', async () => {
    const seen: any[] = [];
    jobs.register('test.ok', async (j) => void seen.push(j.payload));
    await t.db.platform((tx) => jobs.enqueue(tx, 'test.ok', { n: 1 }));
    expect(await jobs.drain()).toBe(1);
    expect(seen).toEqual([{ n: 1 }]);
    expect(await jobs.runOnce()).toBe(false);
  });

  it('retries with backoff and goes dead after max attempts', async () => {
    let calls = 0;
    jobs.register('test.fail', async () => {
      calls++;
      throw new Error('boom');
    });
    await t.db.platform((tx) => jobs.enqueue(tx, 'test.fail', {}, { maxAttempts: 2 }));
    await jobs.runOnce();
    let row = (await t.db.admin((tx) => tx.query(`SELECT status, attempts, last_error, run_at > now() AS later FROM job WHERE type='test.fail'`))).rows[0];
    expect(row).toMatchObject({ status: 'queued', attempts: 1, last_error: 'boom', later: true });
    await t.db.admin((tx) => tx.query(`UPDATE job SET run_at = now() WHERE type='test.fail'`));
    await jobs.runOnce();
    row = (await t.db.admin((tx) => tx.query(`SELECT status, attempts FROM job WHERE type='test.fail'`))).rows[0];
    expect(row).toMatchObject({ status: 'dead', attempts: 2 });
    expect(calls).toBe(2);
  });

  it('dedupe key prevents duplicate queued jobs', async () => {
    await t.db.platform(async (tx) => {
      await jobs.enqueue(tx, 'test.dedupe', {}, { dedupeKey: 'only-one' });
      await jobs.enqueue(tx, 'test.dedupe', {}, { dedupeKey: 'only-one' });
    });
    const n = (await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM job WHERE dedupe_key='only-one'`))).rows[0].c;
    expect(n).toBe(1);
  });

  it('parallel workers never run the same job twice (SKIP LOCKED)', async () => {
    let runs = 0;
    jobs.register('test.once', async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 100));
    });
    await t.db.platform(async (tx) => {
      for (let i = 0; i < 5; i++) await jobs.enqueue(tx, 'test.once', { i });
    });
    await Promise.all([jobs.drain(), jobs.drain(), jobs.drain()]);
    expect(runs).toBe(5);
  });

  it('outbox events dispatch after commit and not at all when the transaction rolls back', async () => {
    const shop = await provisionShop(t);
    const outbox = t.app.get(OutboxService);
    const got: string[] = [];
    outbox.on('test.event', async (e) => void got.push(e.payload.id));
    await t.db.tenant({ shopId: shop.shopId }, (tx) => outbox.publish(tx, shop.shopId, 'test.event', { id: 'committed' }));
    await expect(
      t.db.tenant({ shopId: shop.shopId }, async (tx) => {
        await outbox.publish(tx, shop.shopId, 'test.event', { id: 'rolled-back' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await outbox.dispatch();
    expect(got).toEqual(['committed']);
  });
});

describe('supervisor override', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await createApp();
  });
  afterAll(() => t.close());

  it('a manager PIN lets a cashier complete one restricted action; both are audited; token is bound', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    const term = (await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: shop.defaultBranchId, name: 'T1', prefix: 'AP-T1' })).body;
    const mgr = await createUser(t, owner, { roleId: shop.roleIds.manager, branchId: shop.defaultBranchId });
    const cashier = await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
    await t.http().put(`/v1/users/${mgr.id}/pin`).set(auth(owner)).send({ pin: '4321' }).expect(204);
    await t.http().put(`/v1/users/${cashier.id}/pin`).set(auth(owner)).send({ pin: '1111' }).expect(204);
    const cashierTok = await login(t, cashier.email, undefined, term.id);

    const bad = await t.http().post('/v1/approvals').set(auth(cashierTok)).send({ action: 'sale.void', entityId: 'S1', approverUserId: mgr.id, pin: '0000' });
    expect(bad.status).toBe(403);
    // a cashier cannot approve for another cashier
    const selfish = await t.http().post('/v1/approvals').set(auth(cashierTok)).send({ action: 'sale.void', approverUserId: cashier.id, pin: '1111' });
    expect(selfish.status).toBe(403);

    const ok = await t.http().post('/v1/approvals').set(auth(cashierTok)).send({ action: 'sale.void', entityId: 'S1', approverUserId: mgr.id, pin: '4321' });
    expect(ok.status).toBe(200);

    const svc = t.app.get(ApprovalService);
    const session = { kind: 'tenant' as const, userId: cashier.id, shopId: shop.shopId, branchId: shop.defaultBranchId, terminalId: term.id };
    expect(svc.verify(ok.body.token, session, { action: 'sale.void', entityId: 'S1' })).toBe(mgr.id);
    expect(() => svc.verify(ok.body.token, session, { action: 'sale.void', entityId: 'S2' })).toThrow(); // different sale
    expect(() => svc.verify(ok.body.token, session, { action: 'sale.refund', entityId: 'S1' })).toThrow(); // different action
    expect(() => svc.verify(ok.body.token, { ...session, userId: mgr.id }, { action: 'sale.void', entityId: 'S1' })).toThrow(); // other user
    expect(() => svc.verify(undefined, session, { action: 'sale.void' })).toThrow();

    const log = (await t.http().get('/v1/audit-log?action=approval.granted').set(auth(owner))).body;
    expect(log[0]).toMatchObject({ actor_id: cashier.id, approver_id: mgr.id, terminal_id: term.id });
  });

  it('the supervisor can be identified by email at the till', async () => {
    const shop = await provisionShop(t);
    const owner = await login(t, shop.ownerEmail);
    const term = (await t.http().post('/v1/terminals').set(auth(owner)).send({ branchId: shop.defaultBranchId, name: 'T', prefix: 'EM-T1' })).body;
    const mgr = await createUser(t, owner, { roleId: shop.roleIds.manager, branchId: shop.defaultBranchId });
    const cashier = await createUser(t, owner, { roleId: shop.roleIds.cashier, branchId: shop.defaultBranchId });
    await t.http().put(`/v1/users/${mgr.id}/pin`).set(auth(owner)).send({ pin: '5555' }).expect(204);
    const tok = await login(t, cashier.email, undefined, term.id);
    const ok = await t.http().post('/v1/approvals').set(auth(tok)).send({ action: 'discount.large', approverEmail: mgr.email.toUpperCase(), pin: '5555' });
    expect(ok.status).toBe(200);
    expect(ok.body.approverId).toBe(mgr.id);
    expect((await t.http().post('/v1/approvals').set(auth(tok)).send({ action: 'x', approverEmail: mgr.email, pin: '0000' })).status).toBe(403);
    expect((await t.http().post('/v1/approvals').set(auth(tok)).send({ action: 'x', pin: '5555' })).status).toBe(400);
  });
});
