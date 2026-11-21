import { Tx } from '../db/db';

/** Per-shop monotonically increasing counter (SKU numbers, short codes, import batches). */
export async function nextCounter(tx: Tx, shopId: string, key: string): Promise<number> {
  const r = await tx.query(
    `INSERT INTO shop_counter(shop_id, key, value) VALUES ($1,$2,1)
     ON CONFLICT (shop_id, key) DO UPDATE SET value = shop_counter.value + 1 RETURNING value`,
    [shopId, key],
  );
  return Number(r.rows[0].value);
}

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);
