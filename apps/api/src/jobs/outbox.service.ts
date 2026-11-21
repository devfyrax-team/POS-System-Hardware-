import { Injectable, Logger } from '@nestjs/common';
import { Db, Tx } from '../db/db';

export interface OutboxEvent {
  id: number;
  shop_id: string | null;
  type: string;
  payload: any;
}

export type EventHandler = (e: OutboxEvent, db: Db) => Promise<void>;

/**
 * Services publish events inside their business transaction (so they commit or roll back together);
 * the worker dispatches them afterwards. Checkout never calls an external service.
 */
@Injectable()
export class OutboxService {
  private readonly log = new Logger('Outbox');
  private handlers = new Map<string, EventHandler[]>();

  constructor(private readonly db: Db) {}

  on(type: string, h: EventHandler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
  }

  async publish(tx: Tx, shopId: string | null, type: string, payload: unknown = {}) {
    await tx.query(`INSERT INTO outbox_event(shop_id, type, payload) VALUES ($1,$2,$3)`, [shopId, type, JSON.stringify(payload)]);
  }

  /** Dispatch up to `limit` unprocessed events. Failed events retry up to 5 attempts. */
  async dispatch(limit = 100): Promise<number> {
    const events = await this.db.platform(async (tx) =>
      (await tx.query<OutboxEvent & { attempts: number }>(
        `SELECT id, shop_id, type, payload, attempts FROM outbox_event WHERE processed_at IS NULL AND attempts < 5 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      )).rows,
    );
    let n = 0;
    for (const e of events) {
      try {
        for (const h of this.handlers.get(e.type) ?? []) await h(e, this.db);
        await this.db.platform((tx) => tx.query(`UPDATE outbox_event SET processed_at=now() WHERE id=$1`, [e.id]));
        n++;
      } catch (err) {
        this.log.warn(`Outbox ${e.id} ${e.type} failed: ${(err as Error).message}`);
        await this.db.platform((tx) => tx.query(`UPDATE outbox_event SET attempts=attempts+1 WHERE id=$1`, [e.id]));
      }
    }
    return n;
  }
}
