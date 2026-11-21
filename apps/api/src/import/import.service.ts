import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { D } from '@pos/money';
import { Db, Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { ProductService } from '../catalog/product.service';
import { JobQueue } from '../jobs/job-queue';
import { StockService } from '../inventory/stock.service';

export type RawRow = Record<string, string | number | null | undefined>;
const CHUNK = 500;
const MAX_ROWS = 20000;
const FUZZY = 0.6;

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Bulk import pipeline: rows load into a staging table, are validated and matched there (barcode, SKU, name,
 * fuzzy), previewed with errors, then processed in the background in chunks of 500. Every import is one batch,
 * so one undo reverses it. Opening stock posts separately from product creation.
 */
@Injectable()
export class ImportService {
  private readonly log = new Logger('Import');

  constructor(
    private readonly audit: AuditService,
    private readonly products: ProductService,
    private readonly stock: StockService,
    private readonly jobs: JobQueue,
  ) {}

  async upload(tx: Tx, sess: TenantSession, input: { branchId?: string; rows: RawRow[] }) {
    if (!input.rows.length) throw E.validation('The file has no rows');
    if (input.rows.length > MAX_ROWS) throw E.validation(`Too many rows (max ${MAX_ROWS} per import)`);
    const branchId =
      input.branchId ?? sess.branchId ?? (await tx.query(`SELECT id FROM branch WHERE shop_id=$1 AND status='active' ORDER BY is_default DESC LIMIT 1`, [sess.shopId])).rows[0]?.id;
    const b = (
      await tx.query(`INSERT INTO import_batch(shop_id, branch_id, total_rows, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [sess.shopId, branchId, input.rows.length, sess.userId])
    ).rows[0];
    for (let i = 0; i < input.rows.length; i += 500) {
      const part = input.rows.slice(i, i + 500);
      await tx.query(
        `INSERT INTO import_row(shop_id, batch_id, row_no, raw, row_hash)
         SELECT $1, $2, x.n, x.raw, x.h FROM unnest($3::int[], $4::jsonb[], $5::text[]) AS x(n, raw, h)`,
        [
          sess.shopId, b.id, part.map((_, j) => i + j + 1), part.map((r) => JSON.stringify(r)),
          part.map((r, j) => createHash('sha256').update(`${i + j + 1}:${JSON.stringify(r)}`).digest('hex')),
        ],
      );
    }
    await this.audit.record(tx, { shopId: sess.shopId, actorId: sess.userId, action: 'import.uploaded', entity: 'import_batch', entityId: b.id, new: { rows: input.rows.length } });
    return { batchId: b.id as string, rows: input.rows.length };
  }

  /** Validates and matches every row. Re-runnable. */
  async validate(tx: Tx, sess: TenantSession, batchId: string) {
    const batch = await this.getBatch(tx, sess.shopId, batchId);
    if (!['staged', 'validated'].includes(batch.status)) throw E.conflict(`Batch is ${batch.status}`);
    const rows = (await tx.query(`SELECT id, raw FROM import_row WHERE batch_id=$1 AND status IN ('pending','error','review','ok') ORDER BY row_no`, [batchId])).rows;
    for (const r of rows) {
      const errors: string[] = [];
      const raw = r.raw as RawRow;
      const name = s(raw.name);
      const price = s(raw.price);
      const cost = s(raw.cost);
      const qty = s(raw.qty);
      if (!name) errors.push('name is required');
      if (price && !/^\d+(\.\d+)?$/.test(price)) errors.push('price must be a non-negative number');
      if (cost && !/^\d+(\.\d+)?$/.test(cost)) errors.push('cost must be a non-negative number');
      if (qty && !/^\d+(\.\d+)?$/.test(qty)) errors.push('qty must be a non-negative number');
      if ((s(raw.unit) || 'pcs').length > 20) errors.push('unit is too long');

      let status = errors.length ? 'error' : 'ok';
      let match: any = null;
      if (!errors.length) {
        match = await this.findMatch(tx, sess.shopId, { name, barcode: s(raw.barcode), sku: s(raw.sku) });
        if (match) status = 'review';
      }
      await tx.query(`UPDATE import_row SET status=$2, errors=$3, match=$4 WHERE id=$1`, [r.id, status, JSON.stringify(errors), match ? JSON.stringify(match) : null]);
    }
    await tx.query(`UPDATE import_batch SET status='validated' WHERE id=$1`, [batchId]);
    return this.preview(tx, sess, batchId);
  }

  /** Barcode, then SKU, then exact name, then fuzzy name (suggestions instead of duplicates). */
  private async findMatch(tx: Tx, shopId: string, q: { name: string; barcode: string; sku: string }) {
    if (q.barcode) {
      const b = (await tx.query(`SELECT product_id FROM product_barcode WHERE shop_id=$1 AND code=$2`, [shopId, q.barcode])).rows[0];
      if (b) return { type: 'barcode', productId: b.product_id, score: 1 };
    }
    if (q.sku) {
      const p = (await tx.query(`SELECT id FROM product WHERE shop_id=$1 AND upper(sku)=upper($2)`, [shopId, q.sku])).rows[0];
      if (p) return { type: 'sku', productId: p.id, score: 1 };
    }
    const exact = (await tx.query(`SELECT id FROM product WHERE shop_id=$1 AND lower(name)=lower($2) AND status='active'`, [shopId, q.name])).rows[0];
    if (exact) return { type: 'name_exact', productId: exact.id, score: 1 };
    const fz = (
      await tx.query(
        `SELECT id, name, similarity(search_text, lower($2)) AS score FROM product WHERE shop_id=$1 AND status='active' AND search_text % lower($2)
         ORDER BY score DESC LIMIT 3`,
        [shopId, q.name],
      )
    ).rows.filter((r) => Number(r.score) >= FUZZY);
    if (fz.length) return { type: 'fuzzy', productId: fz[0].id, score: Number(fz[0].score), suggestions: fz.map((r) => ({ productId: r.id, name: r.name, score: Number(r.score) })) };
    return null;
  }

  /** Matched rows need a decision: create anyway, use the existing product, or skip. */
  async setDecision(tx: Tx, sess: TenantSession, batchId: string, input: { rowIds?: number[]; decision: 'create' | 'use_existing' | 'skip'; allReview?: boolean }) {
    const r = await tx.query(
      `UPDATE import_row SET decision=$3 WHERE batch_id=$1 AND shop_id=$2 AND status='review' AND ($4::boolean OR id = ANY($5))`,
      [batchId, sess.shopId, input.decision, input.allReview ?? false, input.rowIds ?? []],
    );
    return { updated: r.rowCount };
  }

  async preview(tx: Tx, sess: TenantSession, batchId: string) {
    const batch = await this.getBatch(tx, sess.shopId, batchId);
    const counts = (await tx.query(`SELECT status, count(*)::int c FROM import_row WHERE batch_id=$1 GROUP BY status`, [batchId])).rows;
    const undecided = (await tx.query(`SELECT count(*)::int c FROM import_row WHERE batch_id=$1 AND status='review' AND decision IS NULL`, [batchId])).rows[0].c;
    const problems = (
      await tx.query(`SELECT id, row_no, raw, status, errors, match, decision FROM import_row WHERE batch_id=$1 AND status IN ('error','review') ORDER BY row_no LIMIT 100`, [batchId])
    ).rows;
    return { batchId, status: batch.status, total: batch.total_rows, processed: batch.processed_rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.c])), undecided, problems };
  }

  /** Downloadable error file: fix only the bad rows and upload them again. */
  async errorCsv(tx: Tx, sess: TenantSession, batchId: string): Promise<string> {
    await this.getBatch(tx, sess.shopId, batchId);
    const rows = (await tx.query(`SELECT row_no, raw, errors FROM import_row WHERE batch_id=$1 AND status='error' ORDER BY row_no`, [batchId])).rows;
    const cols = ['name', 'unit', 'price', 'cost', 'qty', 'barcode', 'sku', 'category', 'brand', 'size'];
    const q = (v: unknown) => `"${s(v).replace(/"/g, '""')}"`;
    return [['row', ...cols, 'errors'].join(','), ...rows.map((r) => [r.row_no, ...cols.map((c) => q(r.raw[c])), q((r.errors as string[]).join('; '))].join(','))].join('\n');
  }

  async confirm(tx: Tx, sess: TenantSession, batchId: string) {
    const batch = await this.getBatch(tx, sess.shopId, batchId);
    if (batch.status !== 'validated') throw E.conflict('Validate the batch before confirming');
    const open = (await tx.query(`SELECT count(*)::int c FROM import_row WHERE batch_id=$1 AND status='review' AND decision IS NULL`, [batchId])).rows[0].c;
    if (open) throw E.conflict(`${open} row(s) need a decision (create, use existing, or skip)`);
    await tx.query(`UPDATE import_batch SET status='processing' WHERE id=$1`, [batchId]);
    await this.jobs.enqueue(tx, 'import.process', { batchId }, { shopId: sess.shopId, dedupeKey: `import:${batchId}` });
    await this.audit.record(tx, { shopId: sess.shopId, actorId: sess.userId, action: 'import.confirmed', entity: 'import_batch', entityId: batchId });
    return { status: 'processing' as const };
  }

  private async getBatch(tx: Tx, shopId: string, id: string) {
    const b = (await tx.query(`SELECT * FROM import_batch WHERE shop_id=$1 AND id=$2`, [shopId, id])).rows[0];
    if (!b) throw E.notFound('Import batch');
    return b;
  }

  /**
   * Background worker. Chunks of 500; each chunk is its own transaction and rows already imported are skipped,
   * so a crashed run simply resumes (idempotent). Opening stock is posted in a second pass.
   */
  async process(db: Db, shopId: string, batchId: string) {
    const batch = await db.tenant({ shopId }, (tx) => this.getBatch(tx, shopId, batchId));
    const sess: TenantSession = { kind: 'tenant', shopId, userId: batch.created_by, branchId: batch.branch_id };
    try {
      for (;;) {
        const n = await db.tenant({ shopId, userId: batch.created_by }, async (tx) => {
          const rows = (
            await tx.query(
              `SELECT id, raw, status, decision, match FROM import_row WHERE batch_id=$1 AND status IN ('ok','review') ORDER BY row_no LIMIT $2 FOR UPDATE SKIP LOCKED`,
              [batchId, CHUNK],
            )
          ).rows;
          for (const r of rows) await this.importRow(tx, sess, r);
          if (rows.length) await tx.query(`UPDATE import_batch SET processed_rows = processed_rows + $2 WHERE id=$1`, [batchId, rows.length]);
          return rows.length;
        });
        if (!n) break;
      }
      for (;;) {
        const n = await db.tenant({ shopId, userId: batch.created_by }, async (tx) => {
          const rows = (
            await tx.query(
              `SELECT id, product_id, opening_qty, raw FROM import_row
               WHERE batch_id=$1 AND status='imported' AND opening_qty > 0 AND (match->>'opened') IS NULL ORDER BY row_no LIMIT $2`,
              [batchId, CHUNK],
            )
          ).rows;
          for (const r of rows) {
            await this.stock.apply(tx, {
              shopId, branchId: batch.branch_id, productId: r.product_id, type: 'opening', qtyBase: String(r.opening_qty),
              unitCost: s((r.raw as RawRow).cost) || null, refType: 'import', refId: batchId, reason: 'import opening stock', userId: batch.created_by,
            });
            await tx.query(`UPDATE import_row SET match = coalesce(match,'{}'::jsonb) || '{"opened":true}'::jsonb WHERE id=$1`, [r.id]);
          }
          return rows.length;
        });
        if (!n) break;
      }
      await db.tenant({ shopId }, (tx) => tx.query(`UPDATE import_batch SET status='done' WHERE id=$1`, [batchId]));
    } catch (e) {
      this.log.error(`Import ${batchId} failed: ${(e as Error).message}`);
      await db.tenant({ shopId }, (tx) => tx.query(`UPDATE import_batch SET status='failed' WHERE id=$1`, [batchId]));
      throw e;
    }
  }

  private async importRow(tx: Tx, sess: TenantSession, r: any) {
    const raw = r.raw as RawRow;
    const qty = s(raw.qty);
    const opening = qty && D(qty).gt(0) ? qty : null;
    if (r.status === 'review' && r.decision !== 'create' && r.decision !== 'use_existing') {
      await tx.query(`UPDATE import_row SET status='skipped' WHERE id=$1`, [r.id]);
      return;
    }
    if (r.status === 'review' && r.decision === 'use_existing') {
      await tx.query(`UPDATE import_row SET status='imported', product_id=$2, opening_qty=$3 WHERE id=$1`, [r.id, r.match.productId, opening]);
      return;
    }
    const unit = s(raw.unit) || 'pcs';
    const p = await this.products.create(tx, sess, {
      name: s(raw.name), baseUnit: unit, category: s(raw.category) || undefined, brand: s(raw.brand) || undefined, size: s(raw.size) || undefined,
      price: s(raw.price) || undefined, lastCost: s(raw.cost) || undefined, barcode: s(raw.barcode) || undefined,
      decimalQty: /^(kg|g|m|l|ml|cube|ft)$/i.test(unit),
    });
    await tx.query(
      `UPDATE import_row SET status='imported', product_id=$2, opening_qty=$3, match = coalesce(match,'{}'::jsonb) || '{"created":true}'::jsonb WHERE id=$1`,
      [r.id, p.id, opening],
    );
  }

  /** One undo reverses the whole batch: products it created are deactivated and their opening stock reversed. */
  async undo(tx: Tx, sess: TenantSession, batchId: string) {
    const batch = await this.getBatch(tx, sess.shopId, batchId);
    if (batch.status !== 'done') throw E.conflict(`Only a finished batch can be undone (status: ${batch.status})`);
    const rows = (await tx.query(`SELECT product_id, opening_qty FROM import_row WHERE batch_id=$1 AND status='imported' AND match->>'created' = 'true'`, [batchId])).rows;
    const blocked: string[] = [];
    for (const r of rows) {
      const other = (
        await tx.query(`SELECT 1 FROM stock_movement WHERE product_id=$1 AND branch_id=$2 AND NOT (coalesce(ref_type,'') = 'import' AND coalesce(ref_id,'') = $3) LIMIT 1`, [r.product_id, batch.branch_id, batchId])
      ).rowCount;
      if (other) blocked.push(r.product_id);
    }
    if (blocked.length) throw E.conflict('Some imported items already have stock activity and cannot be undone', { productIds: blocked });
    for (const r of rows) {
      if (r.opening_qty && D(r.opening_qty).gt(0)) {
        await this.stock.apply(tx, {
          shopId: sess.shopId, branchId: batch.branch_id, productId: r.product_id, type: 'adjustment', qtyBase: D(r.opening_qty).neg().toString(),
          refType: 'import', refId: batchId, reason: 'import undo', userId: sess.userId,
        });
      }
      await tx.query(`UPDATE product SET status='inactive', version=version+1 WHERE shop_id=$1 AND id=$2`, [sess.shopId, r.product_id]);
    }
    await tx.query(`UPDATE import_batch SET status='undone' WHERE id=$1`, [batchId]);
    await this.audit.record(tx, { shopId: sess.shopId, actorId: sess.userId, action: 'import.undone', entity: 'import_batch', entityId: batchId, new: { products: rows.length } });
    return { reversed: rows.length };
  }
}
