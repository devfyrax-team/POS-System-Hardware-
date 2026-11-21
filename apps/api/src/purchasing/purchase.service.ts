import { Injectable } from '@nestjs/common';
import { D, Decimal, convertQty, roundCost, roundMoney, sum } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { nextCounter } from '../common/counter';
import { TenantSession } from '../common/session';
import { AuditService } from '../audit/audit.service';
import { UnitService } from '../catalog/unit.service';
import { StockService } from '../inventory/stock.service';

export interface ReceiveLine {
  productId: string;
  unitId?: string;
  unit?: string;
  qty: string;
  unitCost: string; // per selling unit, as invoiced
  poLineId?: string;
  batchNo?: string;
  mfgDate?: string;
  expiryDate?: string;
}

export interface ReceiveInput {
  supplierId: string;
  poId?: string;
  supplierInvoiceNo?: string;
  lines: ReceiveLine[];
  landedCosts?: { label: string; amount: string }[]; // transport etc., spread across the lines by value
  note?: string;
}

/**
 * Buying creates stock, cost layers and supplier payables in one transaction. Partial receipts are allowed.
 * A cost change against the last receipt produces a NOTICE (the owner may reprice); it never blocks the receipt.
 */
@Injectable()
export class PurchaseService {
  constructor(private readonly stock: StockService, private readonly units: UnitService, private readonly audit: AuditService) {}

  // ----- purchase orders -----
  async createOrder(tx: Tx, s: TenantSession, i: { supplierId: string; expectedDate?: string; note?: string; lines: { productId: string; unitId?: string; unit?: string; qty: string; unitCost: string }[] }) {
    if (!s.branchId) throw E.validation('Choose a branch first');
    if (!i.lines.length) throw E.validation('Add at least one line');
    await this.assertSupplier(tx, s.shopId, i.supplierId);
    const number = `PO-${String(await nextCounter(tx, s.shopId, 'po')).padStart(6, '0')}`;
    const po = (
      await tx.query(
        `INSERT INTO purchase_order(shop_id, branch_id, supplier_id, number, expected_date, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, number, status`,
        [s.shopId, s.branchId, i.supplierId, number, i.expectedDate ?? null, i.note ?? null, s.userId],
      )
    ).rows[0];
    for (const l of i.lines) {
      const u = await this.units.toBase(tx, s.shopId, l.productId, { unitId: l.unitId, unit: l.unit }, l.qty);
      await tx.query(`INSERT INTO purchase_order_line(shop_id, po_id, product_id, unit_id, qty_unit, qty_base, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [s.shopId, po.id, l.productId, u.unitId, u.qtyUnit, u.qtyBase, l.unitCost]);
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'po.created', entity: 'purchase_order', entityId: po.id, new: { number } });
    return po;
  }

  async approveOrder(tx: Tx, s: TenantSession, id: string) {
    const r = await tx.query(`UPDATE purchase_order SET status='approved', approved_by=$3 WHERE shop_id=$1 AND id=$2 AND status='draft' RETURNING id, status`, [s.shopId, id, s.userId]);
    if (!r.rowCount) throw E.conflict('Only a draft order can be approved');
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'po.approved', entity: 'purchase_order', entityId: id });
    return r.rows[0];
  }

  async cancelOrder(tx: Tx, s: TenantSession, id: string) {
    const r = await tx.query(`UPDATE purchase_order SET status='cancelled' WHERE shop_id=$1 AND id=$2 AND status IN ('draft','approved') RETURNING id`, [s.shopId, id]);
    if (!r.rowCount) throw E.conflict('This order cannot be cancelled');
  }

  async getOrder(tx: Tx, shopId: string, id: string) {
    const po = (await tx.query(`SELECT id, number, supplier_id, status, expected_date, note, created_at FROM purchase_order WHERE shop_id=$1 AND id=$2`, [shopId, id])).rows[0];
    if (!po) throw E.notFound('Purchase order');
    const lines = (await tx.query(`SELECT l.id, l.product_id, p.name, l.qty_unit, l.qty_base, l.unit_cost, l.received_base FROM purchase_order_line l JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id WHERE l.shop_id=$1 AND l.po_id=$2`, [shopId, id])).rows;
    return { ...po, lines };
  }

  async listOrders(tx: Tx, shopId: string, status?: string) {
    return (await tx.query(`SELECT id, number, supplier_id, status, expected_date, created_at FROM purchase_order WHERE shop_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT 100`, [shopId, status ?? null])).rows;
  }

  private async assertSupplier(tx: Tx, shopId: string, id: string) {
    const r = (await tx.query(`SELECT status, payment_terms_days FROM supplier WHERE shop_id=$1 AND id=$2`, [shopId, id])).rows[0];
    if (!r) throw E.notFound('Supplier');
    if (r.status !== 'active') throw E.validation('Supplier is inactive');
    return r;
  }

  // ----- receiving goods -----
  async receive(tx: Tx, s: TenantSession, i: ReceiveInput) {
    if (!s.branchId) throw E.validation('Goods are received into a branch: choose one first');
    const branchId = s.branchId;
    if (!i.lines.length) throw E.validation('Add at least one line');
    const supplier = await this.assertSupplier(tx, s.shopId, i.supplierId);
    let po: any = null;
    if (i.poId) {
      po = (await tx.query(`SELECT id, status, supplier_id FROM purchase_order WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [s.shopId, i.poId])).rows[0];
      if (!po || po.supplier_id !== i.supplierId) throw E.notFound('Purchase order');
      if (!['approved', 'partial'].includes(po.status)) throw E.conflict(`Purchase order is ${po.status}`);
    }

    // price and convert every line first (no writes yet)
    const prepared: any[] = [];
    for (const l of i.lines) {
      const prod = (await tx.query(`SELECT id, name, track_batches, shelf_life_days, last_cost FROM product WHERE shop_id=$1 AND id=$2 AND status='active'`, [s.shopId, l.productId])).rows[0];
      if (!prod) throw E.notFound('Product');
      const u = await this.units.toBase(tx, s.shopId, l.productId, { unitId: l.unitId, unit: l.unit }, l.qty);
      if (!D(l.unitCost).gte(0)) throw E.validation('Unit cost cannot be negative');
      if (prod.track_batches && !l.batchNo && !l.expiryDate && !l.mfgDate) throw E.validation(`"${prod.name}" is batch-tracked: enter a batch number or dates`);
      prepared.push({ ...l, prod, u, lineCost: roundMoney(D(l.unitCost).times(u.qtyUnit)) });
    }
    const subtotal = sum(prepared.map((p) => p.lineCost));
    const landedTotal = sum((i.landedCosts ?? []).map((c) => roundMoney(c.amount)));
    for (const c of i.landedCosts ?? []) if (!D(c.amount).gte(0)) throw E.validation('Landed cost cannot be negative');

    // spread landed cost across lines by value (the last line takes the rounding remainder)
    let allocated = D(0);
    prepared.forEach((p, idx) => {
      const share = idx === prepared.length - 1 ? landedTotal.minus(allocated) : subtotal.isZero() ? landedTotal.div(prepared.length) : landedTotal.times(p.lineCost).div(subtotal);
      p.landed = share.toDecimalPlaces(4);
      allocated = allocated.plus(p.landed);
      p.unitCostBase = roundCost(p.lineCost.plus(p.landed).div(p.u.qtyBase));
    });

    const total = subtotal.plus(landedTotal);
    const number = `GRN-${String(await nextCounter(tx, s.shopId, 'grn')).padStart(6, '0')}`;
    const purchase = (
      await tx.query(
        `INSERT INTO purchase(shop_id, branch_id, supplier_id, po_id, number, supplier_invoice_no, subtotal, landed_cost, total, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [s.shopId, branchId, i.supplierId, i.poId ?? null, number, i.supplierInvoiceNo ?? null, subtotal.toString(), landedTotal.toString(), total.toString(), i.note ?? null, s.userId],
      )
    ).rows[0];

    const notices: { productId: string; name: string; previousCost: string | null; newCost: string; changePct: string | null }[] = [];
    const sorted = [...prepared].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
    for (const p of sorted) {
      let batchId: string | null = null;
      if (p.prod.track_batches) {
        const expiry = p.expiryDate ?? (p.mfgDate && p.prod.shelf_life_days ? new Date(new Date(p.mfgDate).getTime() + p.prod.shelf_life_days * 86400000).toISOString().slice(0, 10) : null);
        batchId = (
          await tx.query(
            `INSERT INTO stock_batch(shop_id, branch_id, product_id, batch_no, mfg_date, expiry_date, qty_received, qty_remaining, unit_cost, supplier_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9) RETURNING id`,
            [s.shopId, branchId, p.productId, p.batchNo ?? null, p.mfgDate ?? null, expiry, p.u.qtyBase, p.unitCostBase.toString(), i.supplierId],
          )
        ).rows[0].id;
      }
      const mv = await this.stock.apply(tx, {
        shopId: s.shopId, branchId, productId: p.productId, type: 'purchase', qtyBase: p.u.qtyBase, unitCost: p.unitCostBase.toString(), batchId, supplierId: i.supplierId,
        unit: p.u.unit, qtyUnit: p.u.qtyUnit, factor: p.u.factor, refType: 'purchase', refId: purchase.id, userId: s.userId,
      });
      await tx.query(
        `INSERT INTO purchase_line(shop_id, purchase_id, po_line_id, product_id, unit, qty_unit, qty_base, factor, unit_cost, line_cost, landed_alloc, unit_cost_base, batch_id, movement_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [s.shopId, purchase.id, p.poLineId ?? null, p.productId, p.u.unit, p.u.qtyUnit, p.u.qtyBase, p.u.factor, p.unitCost, p.lineCost.toString(), p.landed.toString(), p.unitCostBase.toString(), batchId, mv.movementId],
      );
      if (p.poLineId) await tx.query(`UPDATE purchase_order_line SET received_base = received_base + $3 WHERE shop_id=$1 AND id=$2`, [s.shopId, p.poLineId, p.u.qtyBase]);

      // cost-change notice (never blocks)
      const prev = p.prod.last_cost as string | null;
      const changed = prev === null || !D(prev).equals(p.unitCostBase);
      if (changed) {
        notices.push({
          productId: p.productId, name: p.prod.name, previousCost: prev === null ? null : D(prev).toString(), newCost: p.unitCostBase.toString(),
          changePct: prev === null || D(prev).isZero() ? null : p.unitCostBase.minus(prev).div(prev).times(100).toDecimalPlaces(1).toString(),
        });
      }
      await tx.query(`UPDATE product SET last_cost=$3 WHERE shop_id=$1 AND id=$2`, [s.shopId, p.productId, p.unitCostBase.toString()]);
      await tx.query(`INSERT INTO purchase_price_history(shop_id, product_id, supplier_id, purchase_id, unit_cost_base, qty_base) VALUES ($1,$2,$3,$4,$5,$6)`, [s.shopId, p.productId, i.supplierId, purchase.id, p.unitCostBase.toString(), p.u.qtyBase]);
    }

    // supplier payable
    await tx.query(
      `INSERT INTO supplier_ledger(shop_id, supplier_id, entry_type, amount, ref_type, ref_id, due_date, note, created_by)
       VALUES ($1,$2,'purchase',$3,'purchase',$4, current_date + $5::int, $6, $7)`,
      [s.shopId, i.supplierId, total.toString(), purchase.id, supplier.payment_terms_days, i.supplierInvoiceNo ?? number, s.userId],
    );

    if (po) {
      const open = (await tx.query(`SELECT count(*)::int c FROM purchase_order_line WHERE shop_id=$1 AND po_id=$2 AND received_base < qty_base`, [s.shopId, i.poId])).rows[0].c;
      await tx.query(`UPDATE purchase_order SET status=$3 WHERE shop_id=$1 AND id=$2`, [s.shopId, i.poId, open ? 'partial' : 'received']);
    }
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'purchase.received', entity: 'purchase', entityId: purchase.id, new: { number, total: total.toString(), lines: prepared.length } });
    return { purchaseId: purchase.id as string, number, subtotal: subtotal.toString(), landedCost: landedTotal.toString(), total: total.toString(), costChangeNotices: notices };
  }

  async getPurchase(tx: Tx, shopId: string, id: string) {
    const p = (await tx.query(`SELECT id, number, supplier_id, po_id, supplier_invoice_no, subtotal, landed_cost, total, created_at FROM purchase WHERE shop_id=$1 AND id=$2`, [shopId, id])).rows[0];
    if (!p) throw E.notFound('Purchase');
    const lines = (
      await tx.query(
        `SELECT l.id, l.product_id, pr.name, l.unit, l.qty_unit, l.unit_cost, l.line_cost, l.landed_alloc, l.unit_cost_base, l.batch_id,
                coalesce((SELECT sum(r.qty_unit) FROM purchase_return_line r WHERE r.purchase_line_id = l.id),0) AS returned_qty
         FROM purchase_line l JOIN product pr ON pr.shop_id=l.shop_id AND pr.id=l.product_id WHERE l.shop_id=$1 AND l.purchase_id=$2`,
        [shopId, id],
      )
    ).rows;
    return { ...p, lines };
  }

  async listPurchases(tx: Tx, shopId: string, supplierId?: string) {
    return (
      await tx.query(`SELECT id, number, supplier_id, supplier_invoice_no, total, created_at FROM purchase WHERE shop_id=$1 AND ($2::uuid IS NULL OR supplier_id=$2) ORDER BY created_at DESC LIMIT 100`, [shopId, supplierId ?? null])
    ).rows;
  }

  /** Purchase returns reduce stock and the supplier balance (at the cost they were bought for). */
  async returnToSupplier(tx: Tx, s: TenantSession, i: { purchaseId: string; lines: { purchaseLineId: string; qty: string }[]; reason: string }) {
    if (!i.reason.trim()) throw E.validation('A reason is required');
    const pur = (await tx.query(`SELECT id, branch_id, supplier_id FROM purchase WHERE shop_id=$1 AND id=$2`, [s.shopId, i.purchaseId])).rows[0];
    if (!pur) throw E.notFound('Purchase');
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [i.purchaseId]);
    const plan: { l: any; qty: Decimal; qtyBase: Decimal; amount: Decimal }[] = [];
    for (const w of i.lines) {
      const l = (await tx.query(`SELECT * FROM purchase_line WHERE shop_id=$1 AND id=$2 AND purchase_id=$3`, [s.shopId, w.purchaseLineId, i.purchaseId])).rows[0];
      if (!l) throw E.notFound('Purchase line');
      const qty = D(w.qty);
      if (!qty.gt(0)) throw E.validation('Quantity must be positive');
      const prior = (await tx.query(`SELECT coalesce(sum(qty_unit),0) q, coalesce(sum(qty_base),0) qb, coalesce(sum(amount),0) a FROM purchase_return_line WHERE shop_id=$1 AND purchase_line_id=$2`, [s.shopId, l.id])).rows[0];
      const remaining = D(l.qty_unit).minus(prior.q);
      if (qty.gt(remaining)) throw E.validation(`Only ${remaining.toString()} ${l.unit} can still be returned`, { remaining: remaining.toString() });
      const isLast = qty.equals(remaining);
      const totalCost = D(l.line_cost).plus(l.landed_alloc);
      plan.push({
        l, qty,
        qtyBase: isLast ? D(l.qty_base).minus(prior.qb) : convertQty(qty, l.factor),
        amount: isLast ? roundMoney(totalCost).minus(prior.a) : roundMoney(totalCost.times(qty).div(l.qty_unit)),
      });
    }
    const total = sum(plan.map((p) => p.amount));
    const number = `PRT-${String(await nextCounter(tx, s.shopId, 'purchase_return')).padStart(6, '0')}`;
    const ret = (
      await tx.query(`INSERT INTO purchase_return(shop_id, branch_id, supplier_id, purchase_id, number, reason, total, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [
        s.shopId, pur.branch_id, pur.supplier_id, i.purchaseId, number, i.reason, total.toString(), s.userId,
      ])
    ).rows[0];
    for (const p of plan) {
      await this.stock.apply(tx, {
        shopId: s.shopId, branchId: pur.branch_id, productId: p.l.product_id, type: 'purchase_return', qtyBase: p.qtyBase.neg().toString(), batchId: p.l.batch_id,
        unit: p.l.unit, qtyUnit: p.qty.toString(), factor: p.l.factor, refType: 'purchase_return', refId: ret.id, reason: i.reason, userId: s.userId,
      });
      await tx.query(`INSERT INTO purchase_return_line(shop_id, return_id, purchase_line_id, qty_unit, qty_base, amount) VALUES ($1,$2,$3,$4,$5,$6)`, [s.shopId, ret.id, p.l.id, p.qty.toString(), p.qtyBase.toString(), p.amount.toString()]);
    }
    await tx.query(
      `INSERT INTO supplier_ledger(shop_id, supplier_id, entry_type, amount, ref_type, ref_id, note, created_by) VALUES ($1,$2,'return',$3,'purchase_return',$4,$5,$6)`,
      [s.shopId, pur.supplier_id, total.neg().toString(), ret.id, i.reason, s.userId],
    );
    await this.audit.record(tx, { shopId: s.shopId, actorId: s.userId, action: 'purchase.returned', entity: 'purchase_return', entityId: ret.id, new: { number, total: total.toString() } });
    return { returnId: ret.id as string, number, total: total.toString() };
  }

  async priceHistory(tx: Tx, shopId: string, productId: string, limit = 50) {
    return (await tx.query(`SELECT id, supplier_id, purchase_id, unit_cost_base, qty_base, created_at FROM purchase_price_history WHERE shop_id=$1 AND product_id=$2 ORDER BY id DESC LIMIT $3`, [shopId, productId, limit])).rows;
  }
}
