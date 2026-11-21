import { Pool } from 'pg';
import { migrate } from '../src/db/migrate';
import { seedPlatformData } from '../src/db/seed';

const BASE = process.env.TEST_PG_BASE ?? 'postgres://postgres:postgres@localhost:5433';
const DB = 'pos_test';

/** Fresh database per test run: create, migrate, seed. */
export default async function globalSetup() {
  const root = new Pool({ connectionString: `${BASE}/postgres`, max: 1 });
  await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${DB}`);
  await root.end();

  const adminUrl = `${BASE}/${DB}`;
  await migrate(adminUrl);
  const p = new Pool({ connectionString: adminUrl, max: 1 });
  await seedPlatformData(p);
  await p.end();

  process.env.ADMIN_DATABASE_URL = adminUrl;
  process.env.DATABASE_URL = `postgres://pos_app:pos_app@${BASE.replace(/^postgres:\/\/[^@]+@/, '')}/${DB}`;
  process.env.JWT_SECRET = 'test-secret';
}
