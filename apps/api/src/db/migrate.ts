import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

/** Tables the app role may only INSERT/SELECT (history is never edited). Extended by later phases. */
export const INSERT_ONLY_TABLES = [
  'audit_log',
  'stock_movement',
  'credit_entry',
  'sale',
  'sale_line',
  'payment',
  'sale_void',
  'sales_return',
  'sales_return_line',
  'purchase_price_history',
  'price_history',
];

/**
 * Applies SQL migrations with the superuser connection, then (re)applies grants
 * for the restricted application role. Idempotent.
 */
export async function migrate(adminUrl: string, appRole = 'pos_app', appPassword = 'pos_app'): Promise<string[]> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  const applied: string[] = [];
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appRole}') THEN
           CREATE ROLE ${appRole} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS;
         END IF;
       END $$;`,
    );
    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      } finally {
        c.release();
      }
    }
    await applyGrants(pool, appRole);
  } finally {
    await pool.end();
  }
  return applied;
}

export async function applyGrants(pool: Pool, appRole = 'pos_app') {
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);
  await pool.query(`REVOKE SELECT, INSERT, UPDATE, DELETE ON schema_migrations FROM ${appRole}`);
  await pool.query(`GRANT EXECUTE ON FUNCTION auth_find_user(text), auth_find_refresh(text), auth_revoke_family(uuid) TO ${appRole}`);
  const existing = (
    await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`, [INSERT_ONLY_TABLES])
  ).rows.map((r) => r.tablename);
  for (const t of existing) {
    await pool.query(`REVOKE UPDATE, DELETE ON ${t} FROM ${appRole}`);
  }
}
