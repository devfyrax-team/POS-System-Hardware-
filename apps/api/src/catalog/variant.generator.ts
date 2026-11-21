import { Injectable } from '@nestjs/common';
import { Tx } from '../db/db';
import { E } from '../common/errors';
import { TenantSession } from '../common/session';
import { ProductService } from './product.service';

export interface VariantTemplate {
  baseName: string;
  baseUnit: string;
  category?: string;
  brand?: string;
  decimalQty?: boolean;
  trackBatches?: boolean;
  shelfLifeDays?: number;
  /** Ordered axes, e.g. { range: [...], sheen: [...], colour: [...], pack: ['1 L','4 L','10 L','20 L'] } */
  axes: Record<string, string[]>;
}

export const MAX_VARIANTS = 500;

/** Pure: all combinations of the axes. */
export function combinations(axes: Record<string, string[]>): Record<string, string>[] {
  let out: Record<string, string>[] = [{}];
  for (const [k, vals] of Object.entries(axes)) {
    const clean = [...new Set(vals.map((v) => v.trim()).filter(Boolean))];
    if (!clean.length) continue;
    out = out.flatMap((o) => clean.map((v) => ({ ...o, [k]: v })));
  }
  return out;
}

@Injectable()
export class VariantGenerator {
  constructor(private readonly products: ProductService) {}

  preview(t: VariantTemplate) {
    const combos = combinations(t.axes);
    if (combos.length > MAX_VARIANTS) throw E.validation(`Too many variants (${combos.length}); the limit is ${MAX_VARIANTS}`);
    return combos.map((attrs) => ({ attrs, name: `${t.baseName} ${Object.values(attrs).join(' ')}`.trim() }));
  }

  /** Quickly creates every combination as its own product (paint: brand, range, sheen, colour, pack size). */
  async generate(tx: Tx, s: TenantSession, t: VariantTemplate) {
    const items = this.preview(t);
    const existing = new Set((await tx.query(`SELECT lower(name) n FROM product WHERE shop_id=$1`, [s.shopId])).rows.map((r) => r.n));
    let created = 0;
    let skipped = 0;
    for (const it of items) {
      if (existing.has(it.name.toLowerCase())) {
        skipped++;
        continue;
      }
      await this.products.create(tx, s, {
        name: it.name, baseUnit: t.baseUnit, category: t.category, brand: t.brand ?? it.attrs.brand, size: it.attrs.pack ?? it.attrs.size,
        decimalQty: t.decimalQty, trackBatches: t.trackBatches, shelfLifeDays: t.shelfLifeDays,
      });
      created++;
    }
    return { created, skipped, total: items.length };
  }
}
