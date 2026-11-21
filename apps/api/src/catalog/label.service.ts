import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { FeatureService } from '../platform/feature.service';

export interface Label {
  productId: string;
  sku: string;
  code: string; // value encoded in the barcode: first barcode, else the SKU
  name: string;
  unit: string;
  price?: string;
}

/**
 * Shelf / bin / barcode labels. Items without barcodes (nuts, bolts, nails) get a printed label that carries
 * a scannable SKU plus readable name and unit; price is optional because owners can reprice freely.
 */
@Injectable()
export class LabelService {
  constructor(private readonly features: FeatureService) {}

  async render(tx: Tx, shopId: string, input: { productIds: string[]; template: 'shelf' | 'bin' | 'barcode'; includePrice?: boolean }) {
    await this.features.require(tx, shopId, 'label_printing');
    if (!input.productIds.length) throw E.validation('Select at least one product');
    const rows = (
      await tx.query(
        `SELECT p.id, p.sku, p.name, p.base_unit,
                (SELECT code FROM product_barcode b WHERE b.product_id = p.id ORDER BY b.type = 'internal' DESC, b.code LIMIT 1) AS barcode,
                (SELECT pp.price FROM product_price pp JOIN product_unit u ON u.id = pp.unit_id AND u.is_base WHERE pp.product_id = p.id AND pp.tier = 'retail') AS price
         FROM product p WHERE p.shop_id=$1 AND p.id = ANY($2) ORDER BY p.name`,
        [shopId, input.productIds],
      )
    ).rows;
    const labels: Label[] = rows.map((r) => ({
      productId: r.id, sku: r.sku, code: r.barcode ?? r.sku, name: r.name, unit: r.base_unit,
      price: input.includePrice && input.template === 'shelf' ? r.price ?? undefined : undefined,
    }));
    return { template: input.template, labels, zpl: labels.map((l) => this.zpl(l, input.template)).join('\n') };
  }

  private zpl(l: Label, template: string): string {
    const esc = (s: string) => s.replace(/[\^~\\]/g, ' ');
    const lines = ['^XA', `^FO30,20^A0N,30,30^FD${esc(l.name).slice(0, 32)}^FS`];
    if (template !== 'barcode') lines.push(`^FO30,60^A0N,24,24^FD${esc(l.sku)}  /${esc(l.unit)}^FS`);
    lines.push(`^FO30,90^BCN,60,Y,N,N^FD${esc(l.code)}^FS`);
    if (l.price) lines.push(`^FO260,60^A0N,36,36^FDRs ${esc(l.price)}^FS`);
    lines.push('^XZ');
    return lines.join('\n');
  }
}
