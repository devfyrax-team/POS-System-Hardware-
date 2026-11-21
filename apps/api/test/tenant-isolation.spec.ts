import { createApp, provisionShop, TestCtx } from './helpers';

describe('tenant isolation (RLS tested directly)', () => {
  let t: TestCtx;
  let A: Awaited<ReturnType<typeof provisionShop>>;
  let B: Awaited<ReturnType<typeof provisionShop>>;

  beforeAll(async () => {
    t = await createApp();
    A = await provisionShop(t);
    B = await provisionShop(t);
  });
  afterAll(() => t.close());

  const tables = ['branch', 'role', 'users', 'user_branch_role', 'audit_log', 'subscription'];

  it.each(tables)('shop A context never sees shop B rows in %s', async (table) => {
    const rows = await t.db.tenant({ shopId: A.shopId }, async (tx) => (await tx.query(`SELECT shop_id FROM ${table}`)).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.shop_id === A.shopId)).toBe(true);
  });

  it('shop table: a tenant sees only itself', async () => {
    const rows = await t.db.tenant({ shopId: A.shopId }, async (tx) => (await tx.query(`SELECT id FROM shop`)).rows);
    expect(rows.map((r) => r.id)).toEqual([A.shopId]);
  });

  it('a wrong shop id reads nothing', async () => {
    const rows = await t.db.tenant({ shopId: '00000000-0000-0000-0000-000000000000' }, async (tx) => (await tx.query(`SELECT id FROM users`)).rows);
    expect(rows).toEqual([]);
  });

  it('cannot write a row for another shop', async () => {
    await expect(
      t.db.tenant({ shopId: A.shopId }, (tx) =>
        tx.query(`INSERT INTO branch(shop_id, name) VALUES ($1,'Sneaky')`, [B.shopId]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot update another shop\'s rows (silently matches nothing)', async () => {
    const r = await t.db.tenant({ shopId: A.shopId }, (tx) => tx.query(`UPDATE users SET name='hacked' WHERE shop_id=$1`, [B.shopId]));
    expect(r.rowCount).toBe(0);
  });

  it('composite foreign keys stop cross-shop links', async () => {
    // role of shop B referenced from a user_branch_role of shop A must be rejected by the database.
    await expect(
      t.db.tenant({ shopId: A.shopId }, (tx) =>
        tx.query(`INSERT INTO user_branch_role(shop_id, user_id, branch_id, role_id) VALUES ($1,$2,NULL,$3)`, [A.shopId, A.ownerUserId, B.roleIds.cashier]),
      ),
    ).rejects.toThrow();
  });

  it('tenant settings do not leak between transactions on pooled connections', async () => {
    await t.db.tenant({ shopId: A.shopId }, (tx) => tx.query('SELECT 1'));
    const leaked = await t.db.appPool.query(`SELECT current_setting('app.shop_id', true) AS v`);
    expect(leaked.rows[0].v ?? '').toBe('');
    const rows = await t.db.appPool.query(`SELECT id FROM users`); // no tenant context at all
    expect(rows.rowCount).toBe(0);
  });

  it('platform context can see all shops, tenant cannot be platform', async () => {
    const all = await t.db.platform(async (tx) => (await tx.query(`SELECT id FROM shop WHERE id = ANY($1)`, [[A.shopId, B.shopId]])).rows);
    expect(all).toHaveLength(2);
    await expect(
      t.db.tenant({ shopId: A.shopId }, (tx) => tx.query(`INSERT INTO shop(name, shop_type) VALUES ('x','hardware')`)),
    ).rejects.toThrow(/row-level security/i);
  });

  it('tenants cannot write platform-controlled data (feature overrides, subscription)', async () => {
    await expect(
      t.db.tenant({ shopId: A.shopId }, (tx) =>
        tx.query(`INSERT INTO shop_feature_override(shop_id, feature_key, enabled) VALUES ($1,'colour_tinting',true)`, [A.shopId]),
      ),
    ).rejects.toThrow(/row-level security/i);
    const r = await t.db.tenant({ shopId: A.shopId }, (tx) => tx.query(`UPDATE subscription SET status='active' WHERE shop_id=$1`, [A.shopId]));
    expect(r.rowCount).toBe(0);
  });

  it('audit_log is insert-only for the application role', async () => {
    await expect(t.db.tenant({ shopId: A.shopId }, (tx) => tx.query(`UPDATE audit_log SET action='x'`))).rejects.toThrow(/permission denied/i);
    await expect(t.db.tenant({ shopId: A.shopId }, (tx) => tx.query(`DELETE FROM audit_log`))).rejects.toThrow(/permission denied/i);
  });
});
