import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Tx } from '../db/db';
import { E } from './errors';

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

/**
 * Money/stock POSTs carry an Idempotency-Key. The claim happens INSIDE the business transaction:
 * a concurrent request with the same key blocks on the unique index until the first commits,
 * then sees the stored response, so a retry can never create a duplicate sale.
 */
@Injectable()
export class IdempotencyService {
  static hashRequest(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }

  /** Returns the stored response if this key was already completed, otherwise null (caller proceeds). */
  async claim(tx: Tx, shopId: string, key: string, requestHash: string): Promise<StoredResponse | null> {
    const ins = await tx.query(
      `INSERT INTO idempotency_key(shop_id, key, request_hash) VALUES ($1,$2,$3)
       ON CONFLICT (shop_id, key) DO NOTHING RETURNING key`,
      [shopId, key, requestHash],
    );
    if (ins.rowCount === 1) return null;
    const r = await tx.query(
      `SELECT request_hash, status_code, response FROM idempotency_key WHERE shop_id=$1 AND key=$2`,
      [shopId, key],
    );
    const row = r.rows[0];
    if (row.request_hash !== requestHash) throw E.idempotencyMismatch();
    if (row.status_code == null) throw E.conflict('A request with this idempotency key is still in progress');
    return { statusCode: row.status_code, body: row.response };
  }

  async complete(tx: Tx, shopId: string, key: string, statusCode: number, body: unknown): Promise<void> {
    await tx.query(
      `UPDATE idempotency_key SET status_code=$3, response=$4 WHERE shop_id=$1 AND key=$2`,
      [shopId, key, statusCode, JSON.stringify(body)],
    );
  }
}
