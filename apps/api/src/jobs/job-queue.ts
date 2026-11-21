import { Injectable, Logger } from '@nestjs/common';
import { Db, Tx } from '../db/db';

export interface JobRow {
  id: number;
  shop_id: string | null;
  type: string;
  payload: any;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (job: JobRow, db: Db) => Promise<void>;

/** Postgres-backed queue (FOR UPDATE SKIP LOCKED). Interface is small so BullMQ can replace it later. */
@Injectable()
export class JobQueue {
  private readonly log = new Logger('Jobs');
  private handlers = new Map<string, JobHandler>();

  constructor(private readonly db: Db) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  async enqueue(tx: Tx, type: string, payload: unknown = {}, opts: { shopId?: string | null; runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
    await tx.query(
      `INSERT INTO job(shop_id, type, payload, run_at, dedupe_key, max_attempts)
       VALUES ($1,$2,$3,coalesce($4, now()),$5,$6)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running') DO NOTHING`,
      [opts.shopId ?? null, type, JSON.stringify(payload), opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? 5],
    );
  }

  private claimNext(): Promise<JobRow | null> {
    return this.db.platform(async (tx) => {
      const r = await tx.query<JobRow>(
        `UPDATE job SET status='running', locked_at=now(), attempts=attempts+1
         WHERE id = (
           SELECT id FROM job
           WHERE (status='queued' AND run_at <= now()) OR (status='running' AND locked_at < now() - interval '10 minutes')
           ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id, shop_id, type, payload, attempts, max_attempts`,
      );
      return r.rows[0] ?? null;
    });
  }

  /** Runs one due job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = await this.claimNext();
    if (!job) return false;
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job, this.db);
      await this.db.platform((tx) => tx.query(`UPDATE job SET status='done', last_error=NULL WHERE id=$1`, [job.id]));
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`Job ${job.id} ${job.type} failed: ${msg}`);
      const dead = job.attempts >= job.max_attempts;
      await this.db.platform((tx) =>
        tx.query(
          `UPDATE job SET status=$2, last_error=$3, run_at = now() + (power(2, $4) * 5 || ' seconds')::interval WHERE id=$1`,
          [job.id, dead ? 'dead' : 'queued', msg, job.attempts],
        ),
      );
    }
    return true;
  }

  async drain(max = 100): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }
}
