import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';

export interface LookupHit {
  productId: string;
  unitId: string;
  matchedBy: 'barcode' | 'sku' | 'short_code';
}

@Injectable()
export class BarcodeService {
  constructor(private readonly audit: AuditService) {}

  /** One item can have several barcodes (piece, box, supplier code), each tied to a selling unit. */
  async add(tx: Tx, s: TenantSession, input: { productId: string; unitId?: string; code: string; type?: 'manufacturer' | 'internal' | 'supplier' }) {
    const unit = (
      await tx.query(`SELECT id FROM product_unit WHERE shop_id=$1 AND product_id=$2 AND ($3::uuid IS NULL AND is_base OR id=$3)`, [s.shopId, input.productId, input.unitId ?? null])
    ).rows[0];
    if (!unit) throw E.notFound('Product unit');
    const code = input.code.trim();
    try {
      const r = (
        await tx.query(
          `INSERT INTO product_barcode(shop_id, product_id, unit_id, code, type) VALUES ($1,$2,$3,$4,$5) RETURNING id, product_id, unit_id, code, type`,
          [s.shopId, input.productId, unit.id, code, input.type ?? 'manufacturer'],
        )
      ).rows[0];
      await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'barcode.added', entity: 'product', entityId: input.productId, new: { code } });
      return r;
    } catch (e: any) {
      if (e.code === '23505') throw E.conflict(`Barcode ${code} is already used by another item`);
      throw e;
    }
  }

  async remove(tx: Tx, s: TenantSession, id: string) {
    const r = await tx.query(`DELETE FROM product_barcode WHERE shop_id=$1 AND id=$2 RETURNING code, product_id`, [s.shopId, id]);
    if (!r.rowCount) throw E.notFound('Barcode');
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'barcode.removed', entity: 'product', entityId: r.rows[0].product_id, old: { code: r.rows[0].code } });
  }

  async list(tx: Tx, shopId: string, productId: string) {
    return (await tx.query(`SELECT id, unit_id, code, type FROM product_barcode WHERE shop_id=$1 AND product_id=$2 ORDER BY code`, [shopId, productId])).rows;
  }

  /** Barcode first, then SKU (printed bin labels carry the SKU), then the short code a cashier types. */
  async lookup(tx: Tx, shopId: string, code: string): Promise<LookupHit | null> {
    const c = code.trim();
    if (!c) return null;
    const b = (
      await tx.query(
        `SELECT b.product_id, b.unit_id FROM product_barcode b JOIN product p ON p.shop_id=b.shop_id AND p.id=b.product_id
         WHERE b.shop_id=$1 AND b.code=$2 AND p.status='active'`,
        [shopId, c],
      )
    ).rows[0];
    if (b) return { productId: b.product_id, unitId: b.unit_id, matchedBy: 'barcode' };
    const p = (
      await tx.query(
        `SELECT p.id, p.sku, u.id AS unit_id FROM product p JOIN product_unit u ON u.shop_id=p.shop_id AND u.product_id=p.id AND u.is_base
         WHERE p.shop_id=$1 AND p.status='active' AND (upper(p.sku)=upper($2) OR upper(p.short_code)=upper($2))`,
        [shopId, c],
      )
    ).rows[0];
    if (!p) return null;
    return { productId: p.id, unitId: p.unit_id, matchedBy: p.sku.toUpperCase() === c.toUpperCase() ? 'sku' : 'short_code' };
  }
}
