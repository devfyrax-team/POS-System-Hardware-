import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CoreModule } from './core.module';
import { JobQueue } from './jobs/job-queue';
import { Db } from './db/db';

/** Worker process: same code and image as the API, runs background jobs only. */
async function main() {
  const app = await NestFactory.createApplicationContext(CoreModule);
  const jobs = app.get(JobQueue);
  const db = app.get(Db);
  let stop = false;
  process.on('SIGTERM', () => (stop = true));
  process.on('SIGINT', () => (stop = true));

  let lastSchedule = 0;
  while (!stop) {
    // Recurring schedules (idempotent via dedupeKey).
    if (Date.now() - lastSchedule > 60_000) {
      lastSchedule = Date.now();
      await db.platform(async (tx) => {
        await jobs.enqueue(tx, 'outbox.dispatch', {}, { dedupeKey: 'outbox.dispatch' });
        await jobs.enqueue(tx, 'feature.expire_overrides', {}, { dedupeKey: 'feature.expire_overrides' });
      });
    }
    const ran = await jobs.runOnce();
    if (!ran) await new Promise((r) => setTimeout(r, 1000));
  }
  await app.close();
}
main();
