import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { escapeLike } from '../common/counter';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class MasterCatalogService {
  constructor(private readonly audit: AuditService) {}

  async categories(tx: Tx, shopType?: string) {
    return (
      await tx.query(
        `SELECT c.id, c.name, c.name_si, c.shop_type, (SELECT count(*)::int FROM master_product m WHERE m.category_id = c.id AND m.status='approved') AS products
         FROM master_category c WHERE ($1::text IS NULL OR $1 = 'both' OR c.shop_type IN ('both', $1)) ORDER BY c.name`,
        [shopType ?? null],
      )
    ).rows;
  }

  /** English, Sinhala and alternative names, brand and size. Identity only: never prices or stock. */
  async search(tx: Tx, q: string, opts: { categoryId?: string; limit?: number } = {}) {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const conds = words.map((_, i) => `(m.search_text LIKE $${i + 3} ESCAPE '\\' OR m.alt_names::text ILIKE $${i + 3} ESCAPE '\\')`).join(' AND ');
    return (
      await tx.query(
        `SELECT m.id, m.name_en, m.name_si, m.alt_names, m.brand, m.size, m.base_unit, m.barcode, c.name AS category,
                (SELECT count(*)::int FROM master_variant v WHERE v.master_product_id = m.id) AS variants
         FROM master_product m LEFT JOIN master_category c ON c.id = m.category_id
         WHERE m.status='approved' AND ($1::uuid IS NULL OR m.category_id=$1) ${conds ? 'AND ' + conds : ''}
         ORDER BY m.name_en LIMIT $2`,
        [opts.categoryId ?? null, Math.min(opts.limit ?? 30, 100), ...words.map((w) => `%${escapeLike(w)}%`)],
      )
    ).rows;
  }

  async variants(tx: Tx, masterProductId: string) {
    return (await tx.query(`SELECT id, label, attrs, barcode FROM master_variant WHERE master_product_id=$1 ORDER BY label`, [masterProductId])).rows;
  }

  /** Import matching: manufacturer barcode first, then the closest names. Suggestions instead of duplicates. */
  async suggestMatch(tx: Tx, input: { name?: string; barcode?: string }) {
    if (input.barcode) {
      const b = (await tx.query(`SELECT id, name_en, name_si, 1.0 AS score FROM master_product WHERE barcode=$1 AND status='approved'`, [input.barcode])).rows;
      if (b.length) return b.map((r) => ({ ...r, matchedBy: 'barcode' }));
    }
    if (!input.name?.trim()) return [];
    return (
      await tx.query(
        `SELECT id, name_en, name_si, similarity(search_text, lower($1)) AS score, 'name' AS "matchedBy"
         FROM master_product WHERE status='approved' AND search_text % lower($1) ORDER BY score DESC LIMIT 5`,
        [input.name],
      )
    ).rows;
  }

  // ----- shops submit missing products; the platform reviews -----
  async submit(tx: Tx, s: TenantSession, input: { name: string; baseUnit?: string; category?: string; brand?: string; size?: string; barcode?: string }) {
    const r = (
      await tx.query(
        `INSERT INTO master_submission(shop_id, submitted_by, name, base_unit, category, brand, size, barcode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, status`,
        [s.shopId, s.userId, input.name, input.baseUnit ?? 'pcs', input.category ?? null, input.brand ?? null, input.size ?? null, input.barcode ?? null],
      )
    ).rows[0];
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'master.submitted', entity: 'master_submission', entityId: r.id, new: input });
    return r;
  }

  // ----- platform review (Super Admin) -----
  async listSubmissions(tx: Tx, status = 'pending') {
    return (await tx.query(`SELECT id, shop_id, name, base_unit, category, brand, size, barcode, status, created_at FROM master_submission WHERE status=$1 ORDER BY created_at`, [status])).rows;
  }

  async approveSubmission(tx: Tx, adminId: string, id: string, fix: { nameEn?: string; nameSi?: string; categoryId?: string } = {}) {
    const sub = (await tx.query(`SELECT * FROM master_submission WHERE id=$1 AND status='pending'`, [id])).rows[0];
    if (!sub) throw E.notFound('Pending submission');
    const m = (
      await tx.query(
        `INSERT INTO master_product(category_id, name_en, name_si, brand, size, base_unit, barcode) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [fix.categoryId ?? null, fix.nameEn ?? sub.name, fix.nameSi ?? null, sub.brand, sub.size, sub.base_unit, sub.barcode],
      )
    ).rows[0];
    await tx.query(`UPDATE master_submission SET status='approved', master_product_id=$2 WHERE id=$1`, [id, m.id]);
    await this.audit.record(tx, { shopId: null, actorId: adminId, actorType: 'platform', action: 'master.approved', entity: 'master_submission', entityId: id });
    return { masterProductId: m.id as string };
  }

  async mergeSubmission(tx: Tx, adminId: string, id: string, intoMasterId: string) {
    const r = await tx.query(`UPDATE master_submission SET status='merged', master_product_id=$2 WHERE id=$1 AND status='pending' RETURNING id`, [id, intoMasterId]);
    if (!r.rowCount) throw E.notFound('Pending submission');
    await this.audit.record(tx, { shopId: null, actorId: adminId, actorType: 'platform', action: 'master.merged', entity: 'master_submission', entityId: id, new: { intoMasterId } });
  }

  async rejectSubmission(tx: Tx, adminId: string, id: string) {
    const r = await tx.query(`UPDATE master_submission SET status='rejected' WHERE id=$1 AND status='pending' RETURNING id`, [id]);
    if (!r.rowCount) throw E.notFound('Pending submission');
    await this.audit.record(tx, { shopId: null, actorId: adminId, actorType: 'platform', action: 'master.rejected', entity: 'master_submission', entityId: id });
  }
}
