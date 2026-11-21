import { Pool } from 'pg';
import { config } from '../common/config';
import { checkIntegrity } from './integrity';

/** `npm run integrity -w apps/api` — exits non-zero if any invariant is broken (use after every restore). */
(async () => {
  const pool = new Pool({ connectionString: process.env.INTEGRITY_DATABASE_URL ?? config().adminDatabaseUrl });
  const v = await checkIntegrity(pool);
  await pool.end();
  if (!v.length) {
    console.log('Integrity OK: all invariants hold.');
    return;
  }
  for (const x of v) console.error(`FAILED: ${x.check} (${x.count} rows)\n  e.g. ${JSON.stringify(x.sample[0])}`);
  process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
