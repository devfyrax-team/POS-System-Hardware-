import { Injectable } from '@nestjs/common';
import { convertQty, D, roundQty } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';

export interface UnitRow {
  id: string;
  unit: string;
  factor: string;
  is_base: boolean;
}

@Injectable()
export class UnitService {
  constructor(private readonly audit: AuditService) {}

  async list(tx: Tx, shopId: string, productId: string): Promise<UnitRow[]> {
    return (await tx.query(`SELECT id, unit, factor, is_base FROM product_unit WHERE shop_id=$1 AND product_id=$2 ORDER BY is_base DESC, factor`, [shopId, productId])).rows;
  }

  /** Add or change conversions (roll -> metres, box -> pieces). Past transactions keep the factor they used. */
  async defineUnits(tx: Tx, s: TenantSession, productId: string, conversions: { unit: string; factor: string }[]) {
    const p = (await tx.query(`SELECT base_unit FROM product WHERE shop_id=$1 AND id=$2`, [s.shopId, productId])).rows[0];
    if (!p) throw E.notFound('Product');
    for (const c of conversions) {
      if (c.unit.trim().toLowerCase() === p.base_unit.toLowerCase()) throw E.validation('The base unit cannot be redefined');
      if (!(D(c.factor).gt(0))) throw E.validation(`Factor for ${c.unit} must be positive`);
      await tx.query(
        `INSERT INTO product_unit(shop_id, product_id, unit, factor) VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_id, unit) DO UPDATE SET factor = EXCLUDED.factor WHERE product_unit.is_base = false`,
        [s.shopId, productId, c.unit.trim(), c.factor],
      );
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'product.units_defined', entity: 'product', entityId: productId, new: conversions });
    return this.list(tx, s.shopId, productId);
  }

  async removeUnit(tx: Tx, s: TenantSession, productId: string, unitId: string) {
    const u = (await tx.query(`SELECT is_base FROM product_unit WHERE shop_id=$1 AND product_id=$2 AND id=$3`, [s.shopId, productId, unitId])).rows[0];
    if (!u) throw E.notFound('Unit');
    if (u.is_base) throw E.conflict('The base unit cannot be removed');
    const used =
      (await tx.query(`SELECT 1 FROM product_barcode WHERE shop_id=$1 AND unit_id=$2 UNION ALL SELECT 1 FROM product_price WHERE shop_id=$1 AND unit_id=$2 LIMIT 1`, [s.shopId, unitId])).rowCount > 0;
    if (used) throw E.conflict('Unit still has barcodes or prices');
    await tx.query(`DELETE FROM product_unit WHERE shop_id=$1 AND id=$2`, [s.shopId, unitId]);
  }

  /**
   * Convert a quantity in a selling unit into base units, snapshotting the factor used.
   * Non-decimal items must be sold in whole selling units.
   */
  async toBase(tx: Tx, shopId: string, productId: string, ref: { unitId?: string; unit?: string }, qty: string | number) {
    const r = (
      await tx.query(
        `SELECT u.id, u.unit, u.factor, p.decimal_qty FROM product_unit u JOIN product p ON p.shop_id=u.shop_id AND p.id=u.product_id
         WHERE u.shop_id=$1 AND u.product_id=$2 AND (($3::uuid IS NOT NULL AND u.id=$3) OR ($3::uuid IS NULL AND ($4::text IS NULL AND u.is_base OR lower(u.unit)=lower($4))))`,
        [shopId, productId, ref.unitId ?? null, ref.unit ?? null],
      )
    ).rows[0];
    if (!r) throw E.notFound('Unit');
    const q = D(qty);
    if (!q.gt(0)) throw E.validation('Quantity must be greater than zero');
    if (!r.decimal_qty && !q.isInteger()) throw E.validation(`"${r.unit}" must be sold in whole numbers for this item`);
    return { unitId: r.id as string, unit: r.unit as string, factor: D(r.factor).toString(), qtyUnit: roundQty(q).toString(), qtyBase: convertQty(q, r.factor).toString() };
  }
}
