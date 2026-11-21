import { Injectable } from '@nestjs/common';
import { D, toDb } from '@pos/money';
import { Tx } from '../db/db';
import { E } from '../common/errors';

const NON_LATIN = /[^\u0000-ÿ]/;

/**
 * 80 mm thermal receipt (42 columns). Prices only: no cost or profit is ever included.
 * Sinhala/Tamil text is flagged `needsRaster` so the till renders those lines as an image, because
 * most thermal printers have no Unicode fonts.
 */
@Injectable()
export class ReceiptService {
  async render(tx: Tx, shopId: string, saleId: string, opts: { width?: number; lang?: 'en' | 'si' | 'ta' } = {}) {
    const width = opts.width ?? 42;
    const sale = (
      await tx.query(
        `SELECT s.*, t.prefix, b.name AS branch_name, u.name AS cashier_name, sh.name AS shop_name, sh.settings, (v.sale_id IS NOT NULL) AS voided
         FROM sale s JOIN terminal t ON t.shop_id=s.shop_id AND t.id=s.terminal_id JOIN branch b ON b.shop_id=s.shop_id AND b.id=s.branch_id
         JOIN users u ON u.shop_id=s.shop_id AND u.id=s.cashier_id JOIN shop sh ON sh.id=s.shop_id LEFT JOIN sale_void v ON v.sale_id=s.id
         WHERE s.shop_id=$1 AND s.id=$2`,
        [shopId, saleId],
      )
    ).rows[0];
    if (!sale) throw E.notFound('Sale');
    const lines = (
      await tx.query(
        `SELECT l.line_no, p.name, p.name_si, l.unit, l.qty_unit, l.price_charged, l.discount, l.line_total
         FROM sale_line l JOIN product p ON p.shop_id=l.shop_id AND p.id=l.product_id WHERE l.shop_id=$1 AND l.sale_id=$2 ORDER BY l.line_no`,
        [shopId, saleId],
      )
    ).rows;
    const pays = (await tx.query(`SELECT method, amount FROM payment WHERE shop_id=$1 AND sale_id=$2 AND kind='sale' ORDER BY created_at, id`, [shopId, saleId])).rows;

    const lang = opts.lang ?? sale.settings?.receipt?.language ?? 'en';
    const header = sale.settings?.receipt?.header ?? sale.shop_name;
    const footer = sale.settings?.receipt?.footer ?? '';
    const money = (v: unknown) => toDb(v as string);
    const row = (l: string, r: string) => (l.length + r.length >= width ? l.slice(0, Math.max(0, width - r.length - 1)) + ' ' + r : l + ' '.repeat(width - l.length - r.length) + r);
    const center = (t: string) => ' '.repeat(Math.max(0, Math.floor((width - t.length) / 2))) + t;
    const rule = '-'.repeat(width);

    const out: string[] = [center(header), center(sale.branch_name), rule, row('Invoice', sale.invoice_no), row('Date', new Date(sale.created_at).toISOString().replace('T', ' ').slice(0, 16)), row('Cashier', sale.cashier_name), rule];
    if (sale.voided) out.splice(1, 0, center('*** VOIDED ***'));
    for (const l of lines) {
      const name = lang === 'si' && l.name_si ? l.name_si : l.name;
      out.push(name.slice(0, width));
      out.push(row(`  ${D(l.qty_unit).toString()} ${l.unit} x ${money(l.price_charged)}`, money(l.line_total)));
      if (D(l.discount).gt(0)) out.push(row('  discount', `-${money(l.discount)}`));
    }
    out.push(rule);
    if (D(sale.bill_discount).gt(0)) out.push(row('Bill discount', `-${money(sale.bill_discount)}`));
    out.push(row('TOTAL', money(sale.total)));
    for (const p of pays) out.push(row(p.method.replace('_', ' '), money(p.amount)));
    if (D(sale.change_due).gt(0)) out.push(row('Change', money(sale.change_due)));
    if (footer) out.push(rule, center(footer));
    const text = out.join('\n');

    const ascii = text.replace(/[^\x20-\x7e\n]/g, '?');
    const escpos = Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.from(ascii + '\n\n\n', 'latin1'), Buffer.from([0x1d, 0x56, 0x42, 0x00])]);
    return {
      saleId, invoiceNo: sale.invoice_no, width, voided: sale.voided, text, needsRaster: NON_LATIN.test(text), escposBase64: escpos.toString('base64'),
      data: {
        header, branch: sale.branch_name, cashier: sale.cashier_name, createdAt: sale.created_at, total: sale.total, change: sale.change_due,
        lines: lines.map((l) => ({ name: l.name, nameSi: l.name_si, qty: l.qty_unit, unit: l.unit, price: l.price_charged, discount: l.discount, total: l.line_total })),
        payments: pays,
      },
    };
  }
}
