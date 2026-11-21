import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { escapeLike } from '../common/counter';
import { BarcodeService } from './barcode.service';

@Injectable()
export class ProductSearchService {
  constructor(private readonly barcodes: BarcodeService) {}

  /**
   * POS search: scan or type. Exact barcode/SKU/short code wins; otherwise every word must appear in the
   * name, Sinhala name, brand, size or category, ranked by similarity. Returns retail price and branch stock.
   * Cost is never part of this result.
   */
  async search(tx: Tx, shopId: string, branchId: string | undefined, q: string, opts: { limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 20, 50);
    const term = q.trim();
    const select = `
      SELECT p.id, p.sku, p.short_code, p.name, p.name_si, p.brand, p.size, p.category, p.base_unit, p.decimal_qty, p.favourite, p.track_batches,
             coalesce(sb.quantity, 0) AS stock,
             (SELECT pp.price FROM product_price pp JOIN product_unit u ON u.id = pp.unit_id AND u.is_base
               WHERE pp.product_id = p.id AND pp.tier = 'retail') AS price`;
    const from = `FROM product p LEFT JOIN stock_balance sb ON sb.product_id = p.id AND sb.branch_id = $2`;

    if (!term) {
      return (await tx.query(`${select} ${from} WHERE p.shop_id=$1 AND p.status='active' AND p.favourite ORDER BY p.name LIMIT $3`, [shopId, branchId ?? null, limit])).rows;
    }
    const hit = await this.barcodes.lookup(tx, shopId, term);
    if (hit) {
      const r = (await tx.query(`${select}, $3::uuid AS unit_id, $4::text AS matched_by ${from} WHERE p.shop_id=$1 AND p.id=$5`, [shopId, branchId ?? null, hit.unitId, hit.matchedBy, hit.productId])).rows;
      if (r.length) return r;
    }
    const words = term.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const conds = words.map((_, i) => `(p.search_text LIKE $${i + 4} ESCAPE '\\' OR p.alt_names::text ILIKE $${i + 4} ESCAPE '\\')`).join(' AND ');
    const params: any[] = [shopId, branchId ?? null, term.toLowerCase(), ...words.map((w) => `%${escapeLike(w)}%`), limit];
    return (
      await tx.query(
        `${select}, similarity(p.search_text, $3) AS sim ${from}
         WHERE p.shop_id=$1 AND p.status='active' AND ${conds}
         ORDER BY (p.search_text LIKE $3 || '%') DESC, sim DESC, p.name LIMIT $${params.length}`,
        params,
      )
    ).rows;
  }
}
