import { Pool } from 'pg';

interface Seed {
  cat: string;
  en: string;
  si?: string;
  alt?: string[];
  brand?: string;
  size?: string;
  unit: string;
  decimal?: boolean;
  barcode?: string;
  variants?: string[];
}

const CATEGORIES: [string, string, 'hardware' | 'paint' | 'both'][] = [
  ['Fasteners', 'ෆාස්ටනර්', 'hardware'],
  ['Plumbing', 'ජලනළ', 'hardware'],
  ['Electrical', 'විදුලි', 'hardware'],
  ['Cement & Building', 'සිමෙන්ති සහ ඉදිකිරීම්', 'hardware'],
  ['Tools', 'මෙවලම්', 'hardware'],
  ['Paint', 'තීන්ත', 'paint'],
  ['Paint Accessories', 'තීන්ත උපාංග', 'paint'],
  ['Adhesives & Sealants', 'ඇලවුම්', 'both'],
];

const ITEMS: Seed[] = [
  { cat: 'Fasteners', en: 'Wire Nail 2 inch', si: 'කම්බි ඇණ 2"', alt: ['nail', 'ඇණ'], unit: 'kg', decimal: true },
  { cat: 'Fasteners', en: 'Wire Nail 3 inch', si: 'කම්බි ඇණ 3"', alt: ['nail', 'ඇණ'], unit: 'kg', decimal: true },
  { cat: 'Fasteners', en: 'Hex Bolt M8 x 50', si: 'බෝල්ට් M8', alt: ['bolt'], size: 'M8x50', unit: 'pcs' },
  { cat: 'Fasteners', en: 'Hex Nut M8', si: 'නට් M8', alt: ['nut'], size: 'M8', unit: 'pcs' },
  { cat: 'Fasteners', en: 'Self Tapping Screw 1 inch', alt: ['screw'], unit: 'pcs' },
  { cat: 'Fasteners', en: 'Washer M8', alt: ['washer'], unit: 'pcs' },
  { cat: 'Plumbing', en: 'PVC Pipe 1/2 inch', si: 'PVC නළය 1/2"', alt: ['pipe'], size: '1/2"', unit: 'm', decimal: true },
  { cat: 'Plumbing', en: 'PVC Pipe 3/4 inch', si: 'PVC නළය 3/4"', alt: ['pipe'], size: '3/4"', unit: 'm', decimal: true },
  { cat: 'Plumbing', en: 'PVC Elbow 1/2 inch', alt: ['elbow'], unit: 'pcs' },
  { cat: 'Plumbing', en: 'Gate Valve 1/2 inch', alt: ['valve'], unit: 'pcs' },
  { cat: 'Plumbing', en: 'Teflon Tape', si: 'ටෙෆ්ලොන් ටේප්', alt: ['ptfe'], unit: 'roll' },
  { cat: 'Electrical', en: 'Copper Wire 1.5mm', si: 'තඹ වයර් 1.5mm', alt: ['wire', 'cable'], size: '1.5mm', unit: 'm', decimal: true },
  { cat: 'Electrical', en: 'Copper Wire 2.5mm', si: 'තඹ වයර් 2.5mm', alt: ['wire', 'cable'], size: '2.5mm', unit: 'm', decimal: true },
  { cat: 'Electrical', en: 'Switch 1 Gang', alt: ['switch'], unit: 'pcs' },
  { cat: 'Electrical', en: 'LED Bulb 9W', si: 'LED බල්බ් 9W', alt: ['bulb', 'light'], size: '9W', unit: 'pcs' },
  { cat: 'Electrical', en: 'Insulation Tape', alt: ['tape'], unit: 'roll' },
  { cat: 'Cement & Building', en: 'Cement 50kg Bag', si: 'සිමෙන්ති 50kg', alt: ['cement', 'සිමෙන්ති'], size: '50kg', unit: 'bag' },
  { cat: 'Cement & Building', en: 'River Sand', si: 'වැලි', alt: ['sand'], unit: 'cube', decimal: true },
  { cat: 'Cement & Building', en: 'Tile Adhesive 20kg', alt: ['adhesive'], size: '20kg', unit: 'bag' },
  { cat: 'Cement & Building', en: 'Binding Wire', alt: ['wire'], unit: 'kg', decimal: true },
  { cat: 'Tools', en: 'Claw Hammer', si: 'මිටිය', alt: ['hammer'], unit: 'pcs' },
  { cat: 'Tools', en: 'Measuring Tape 5m', si: 'මිනුම් පටිය', alt: ['tape measure'], size: '5m', unit: 'pcs' },
  { cat: 'Tools', en: 'Hacksaw Blade', alt: ['saw'], unit: 'pcs' },
  { cat: 'Paint', en: 'Emulsion Paint', si: 'එමල්ෂන් තීන්ත', alt: ['paint', 'තීන්ත'], unit: 'L', decimal: true, variants: ['Brilliant White 1L', 'Brilliant White 4L', 'Brilliant White 10L', 'Magnolia 4L'] },
  { cat: 'Paint', en: 'Enamel Paint Gloss', si: 'එනැමල් තීන්ත', alt: ['paint'], unit: 'L', decimal: true, variants: ['Black 1L', 'White 1L', 'Red 1L'] },
  { cat: 'Paint', en: 'Wood Primer', alt: ['primer'], unit: 'L', decimal: true },
  { cat: 'Paint', en: 'Weather Shield Exterior', alt: ['paint'], unit: 'L', decimal: true },
  { cat: 'Paint Accessories', en: 'Paint Brush 2 inch', si: 'තීන්ත බුරුසුව', alt: ['brush'], size: '2"', unit: 'pcs' },
  { cat: 'Paint Accessories', en: 'Paint Roller 9 inch', alt: ['roller'], size: '9"', unit: 'pcs' },
  { cat: 'Paint Accessories', en: 'Sand Paper 120 grit', alt: ['sandpaper'], unit: 'sheet' },
  { cat: 'Paint Accessories', en: 'Masking Tape 1 inch', alt: ['tape'], unit: 'roll' },
  { cat: 'Adhesives & Sealants', en: 'Silicone Sealant Clear', alt: ['silicone'], unit: 'tube' },
  { cat: 'Adhesives & Sealants', en: 'PVC Solvent Cement 125ml', alt: ['glue'], size: '125ml', unit: 'tin' },
  { cat: 'Adhesives & Sealants', en: 'Wood Glue 500g', alt: ['glue'], size: '500g', unit: 'bottle' },
];

/** Idempotent loader for a starter master catalog (identity only). Run with the admin connection. */
export async function seedMasterCatalog(pool: Pool): Promise<number> {
  const catIds = new Map<string, string>();
  for (const [name, si, shopType] of CATEGORIES) {
    const r = await pool.query(
      `INSERT INTO master_category(name, name_si, shop_type) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET name_si=EXCLUDED.name_si RETURNING id`,
      [name, si, shopType],
    );
    catIds.set(name, r.rows[0].id);
  }
  let n = 0;
  for (const it of ITEMS) {
    const exists = await pool.query(`SELECT id FROM master_product WHERE lower(name_en)=lower($1)`, [it.en]);
    let id = exists.rows[0]?.id;
    if (!id) {
      id = (
        await pool.query(
          `INSERT INTO master_product(category_id, name_en, name_si, alt_names, brand, size, base_unit, decimal_qty, barcode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [catIds.get(it.cat), it.en, it.si ?? null, it.alt ?? [], it.brand ?? null, it.size ?? null, it.unit, it.decimal ?? false, it.barcode ?? null],
        )
      ).rows[0].id;
      n++;
    }
    for (const v of it.variants ?? []) {
      await pool.query(`INSERT INTO master_variant(master_product_id, label) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, v]);
    }
  }
  return n;
}
