import { migrate } from './migrate';
import { seedPlatformData } from './seed';
import { seedMasterCatalog } from '../catalog/master-seed';
import { config } from '../common/config';
import { Pool } from 'pg';

(async () => {
  const url = config().adminDatabaseUrl;
  const applied = await migrate(url, 'pos_app', process.env.APP_DB_PASSWORD ?? 'pos_app');
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No new migrations');
  const pool = new Pool({ connectionString: url });
  await seedPlatformData(pool);
  console.log('Platform data seeded (features, plans).');
  console.log(`Master catalog: ${await seedMasterCatalog(pool)} new products.`);
  // Optional first Super Admin: PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD
  if (process.env.PLATFORM_ADMIN_EMAIL && process.env.PLATFORM_ADMIN_PASSWORD) {
    const { hashSecret } = await import('../auth/password');
    await pool.query(
      `INSERT INTO platform_admin(email, name, password_hash) VALUES (lower($1), 'Super Admin', $2) ON CONFLICT DO NOTHING`,
      [process.env.PLATFORM_ADMIN_EMAIL, await hashSecret(process.env.PLATFORM_ADMIN_PASSWORD)],
    );
    console.log('Super Admin ensured.');
  }
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
