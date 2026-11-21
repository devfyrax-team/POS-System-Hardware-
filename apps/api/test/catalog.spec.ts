import { auth, createApp, TestCtx } from './helpers';
import { addProduct, setupShop, Ctx } from './inv-helpers';

describe('catalog: products, units, prices, barcodes, search', () => {
  let t: TestCtx;
  let c: Ctx;
  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t);
  });
  afterAll(() => t.close());

  it('creates a product with auto SKU + short code, base unit, conversions, price and barcode', async () => {
    const p = await addProduct(t, c.owner, {
      name: 'Binding Wire', baseUnit: 'kg', decimalQty: true, units: [{ unit: 'roll', factor: '25' }], price: '420', barcode: '4791234567890', minLevel: '10',
    });
    expect(p.sku).toMatch(/^SKU-\d{6}$/);
    expect(p.short_code).toMatch(/^B\d+$/);
    const full = (await t.http().get(`/v1/products/${p.id}`).set(auth(c.cashier))).body;
    expect(full.units.map((u: any) => [u.unit, u.is_base])).toEqual([['kg', true], ['roll', false]]);
    expect(full.barcodes[0].code).toBe('4791234567890');
    expect(full).not.toHaveProperty('last_cost');
  });

  it('SKUs are sequential per shop and independent between shops', async () => {
    const other = await setupShop(t);
    const a = await addProduct(t, c.owner, { name: 'Seq One' });
    const b = await addProduct(t, other.owner, { name: 'Seq One' });
    expect(b.sku).toBe('SKU-000001');
    expect(Number(a.sku.slice(4))).toBeGreaterThan(1);
  });

  it('rejects duplicate barcodes and short codes inside a shop, allows them across shops', async () => {
    await addProduct(t, c.owner, { name: 'Dup A', barcode: '5000000000011', shortCode: 'DUPA' });
    const same = await t.http().post('/v1/products').set(auth(c.owner)).send({ name: 'Dup B', baseUnit: 'pcs', barcode: '5000000000011' });
    expect(same.status).toBe(409);
    const code = await t.http().post('/v1/products').set(auth(c.owner)).send({ name: 'Dup C', baseUnit: 'pcs', shortCode: 'dupa' });
    expect(code.status).toBe(409);
    const other = await setupShop(t);
    await addProduct(t, other.owner, { name: 'Dup A', barcode: '5000000000011', shortCode: 'DUPA' });
  });

  describe('units and conversion', () => {
    it('converts selling units to base with the factor snapshot; whole-number rule for non-decimal items', async () => {
      const p = await addProduct(t, c.owner, { name: 'Cable Roll Item', baseUnit: 'm', decimalQty: true, units: [{ unit: 'roll', factor: '90' }] });
      const { UnitService } = await import('../src/catalog/unit.service');
      const svc = t.app.get(UnitService);
      const r = await t.db.tenant({ shopId: c.shop.shopId }, (tx) => svc.toBase(tx, c.shop.shopId, p.id, { unit: 'roll' }, '2'));
      expect(r).toMatchObject({ qtyBase: '180', factor: '90', unit: 'roll' });
      const half = await t.db.tenant({ shopId: c.shop.shopId }, (tx) => svc.toBase(tx, c.shop.shopId, p.id, { unit: 'roll' }, '0.5'));
      expect(half.qtyBase).toBe('45');

      const nuts = await addProduct(t, c.owner, { name: 'Nut Box Item', baseUnit: 'pcs', units: [{ unit: 'box', factor: '100' }] });
      await expect(t.db.tenant({ shopId: c.shop.shopId }, (tx) => svc.toBase(tx, c.shop.shopId, nuts.id, { unit: 'pcs' }, '2.5'))).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await t.db.tenant({ shopId: c.shop.shopId }, (tx) => svc.toBase(tx, c.shop.shopId, nuts.id, { unit: 'box' }, '3'))).qtyBase).toBe('300');
    });

    it('can add a conversion later, but not redefine the base unit', async () => {
      const p = await addProduct(t, c.owner, { name: 'Late Unit', baseUnit: 'pcs' });
      await t.http().put(`/v1/products/${p.id}/units`).set(auth(c.owner)).send({ conversions: [{ unit: 'dozen', factor: '12' }] }).expect(200);
      expect((await t.http().put(`/v1/products/${p.id}/units`).set(auth(c.owner)).send({ conversions: [{ unit: 'pcs', factor: '2' }] })).status).toBe(400);
      expect((await t.http().put(`/v1/products/${p.id}/units`).set(auth(c.owner)).send({ conversions: [{ unit: 'bad', factor: '0' }] })).status).toBe(400);
    });
  });

  describe('prices', () => {
    it('owner/manager reprice any time: no block, history kept; cashier cannot', async () => {
      const p = await addProduct(t, c.owner, { name: 'Hammer Price', price: '1500' });
      expect((await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.cashier)).send({ price: '1' })).status).toBe(403);
      expect((await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.storekeeper)).send({ price: '1' })).status).toBe(403);
      const r1 = await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.manager)).send({ price: '1650' });
      expect(r1.body).toMatchObject({ changed: true, price: '1650' });
      const same = await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.manager)).send({ price: '1650.00' });
      expect(same.body.changed).toBe(false);
      await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.owner)).send({ price: '1400' }).expect(200); // price below earlier: still fine
      const hist = (await t.http().get(`/v1/products/${p.id}/prices/history`).set(auth(c.owner))).body;
      expect(hist.map((h: any) => [h.old_price, h.new_price])).toEqual([['1650.0000', '1400.0000'], ['1500.0000', '1650.0000'], [null, '1500.0000']]);
      const log = (await t.http().get('/v1/audit-log?action=price.changed').set(auth(c.owner))).body;
      expect(log.length).toBeGreaterThanOrEqual(2);
    });

    it('wholesale/contractor tiers need the price_tiers feature', async () => {
      const basic = await setupShop(t, { plan: 'basic' });
      const p = await addProduct(t, basic.owner, { name: 'Tier Item', price: '100' });
      const res = await t.http().put(`/v1/products/${p.id}/prices`).set(auth(basic.owner)).send({ price: '90', tier: 'wholesale' });
      expect(res.body.code).toBe('FEATURE_NOT_ENABLED');
      const mine = await addProduct(t, c.owner, { name: 'Tier Item Pro', price: '100' });
      await t.http().put(`/v1/products/${mine.id}/prices`).set(auth(c.owner)).send({ price: '90', tier: 'wholesale' }).expect(200);
    });

    it('resolves unit price: explicit tier, else unit retail, else base price x factor', async () => {
      const { PricingService } = await import('../src/catalog/pricing.service');
      const svc = t.app.get(PricingService);
      const p = await addProduct(t, c.owner, { name: 'Resolve Item', baseUnit: 'm', decimalQty: true, units: [{ unit: 'roll', factor: '90' }], price: '100' });
      const units = (await t.http().get(`/v1/products/${p.id}`).set(auth(c.owner))).body.units;
      const roll = units.find((u: any) => u.unit === 'roll').id;
      const base = units.find((u: any) => u.is_base).id;
      const r = (u: string, tier?: any) => t.db.tenant({ shopId: c.shop.shopId }, (tx) => svc.resolve(tx, c.shop.shopId, p.id, u, tier));
      expect(await r(base)).toEqual({ price: '100.0000', source: 'tier' });
      expect(await r(roll)).toEqual({ price: '9000', source: 'derived' });
      await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.owner)).send({ price: '8500', unitId: roll }).expect(200);
      expect(await r(roll)).toEqual({ price: '8500.0000', source: 'tier' });
      await t.http().put(`/v1/products/${p.id}/prices`).set(auth(c.owner)).send({ price: '95', tier: 'wholesale' }).expect(200);
      expect(await r(base, 'wholesale')).toEqual({ price: '95.0000', source: 'tier' });
      expect(await r(roll, 'contractor')).toEqual({ price: '8500.0000', source: 'unit' });
    });

    it('bulk price grid sets selling price and last purchase cost by SKU', async () => {
      const a = await addProduct(t, c.owner, { name: 'Grid A' });
      const b = await addProduct(t, c.owner, { name: 'Grid B' });
      const res = await t.http().post('/v1/products/prices/bulk').set(auth(c.manager)).send({ rows: [{ sku: a.sku, price: '10', cost: '6' }, { productId: b.id, price: '20' }] });
      expect(res.body.updated).toBe(3);
      expect((await t.http().post('/v1/products/prices/bulk').set(auth(c.manager)).send({ rows: [{ sku: 'NOPE', price: '1' }] })).status).toBe(404);
    });
  });

  describe('search and barcodes', () => {
    it('finds by name words, short code, SKU, barcode (incl. box barcode) and Sinhala name; favourites list on empty query', async () => {
      const p = await addProduct(t, c.owner, {
        name: 'Hex Bolt M8 x 50', nameSi: 'බෝල්ට් M8', altNames: ['bolt'], shortCode: 'B850', baseUnit: 'pcs', units: [{ unit: 'box', factor: '100' }],
        price: '12', barcode: '4790001112223', favourite: true,
      });
      const boxUnit = (await t.http().get(`/v1/products/${p.id}`).set(auth(c.owner))).body.units.find((u: any) => u.unit === 'box').id;
      await t.http().post(`/v1/products/${p.id}/barcodes`).set(auth(c.owner)).send({ code: '4790001119999', unitId: boxUnit }).expect(201);

      const s = async (q: string) => (await t.http().get('/v1/products/search').query({ q }).set(auth(c.cashier))).body;
      expect((await s('b850'))[0].id).toBe(p.id);
      expect((await s(p.sku))[0].id).toBe(p.id);
      expect((await s('hex bolt'))[0].id).toBe(p.id);
      expect((await s('bolt m8'))[0].id).toBe(p.id);
      expect((await s('බෝල්ට්'))[0].id).toBe(p.id);
      expect((await s('4790001112223'))[0]).toMatchObject({ id: p.id, matched_by: 'barcode' });
      const box = (await s('4790001119999'))[0];
      expect(box.unit_id).toBe(boxUnit); // box barcode points at the box unit
      expect((await s('')).map((x: any) => x.id)).toContain(p.id); // favourites
      expect(await s('zzzz-no-such')).toEqual([]);
      expect((await s('hex bolt'))[0]).not.toHaveProperty('last_cost');
      expect((await s('hex bolt'))[0].price).toBe('12.0000');
    });

    it('lookup by code returns the item and unit; unknown codes 404', async () => {
      const p = await addProduct(t, c.owner, { name: 'Lookup Item', barcode: '9990001112223' });
      const hit = await t.http().get('/v1/products/lookup').query({ code: '9990001112223' }).set(auth(c.cashier));
      expect(hit.body.productId).toBe(p.id);
      expect((await t.http().get('/v1/products/lookup').query({ code: 'nothing' }).set(auth(c.cashier))).status).toBe(404);
    });

    it('LIKE wildcards in the query are escaped', async () => {
      await addProduct(t, c.owner, { name: 'Percent Item 100%' });
      const all = (await t.http().get('/v1/products/search').query({ q: '%' }).set(auth(c.cashier))).body;
      expect(all.every((x: any) => x.name.includes('%'))).toBe(true);
    });
  });

  describe('product maintenance', () => {
    it('quick-add by a cashier is flagged for review; list can filter review items', async () => {
      const r = await t.http().post('/v1/products/quick-add').set(auth(c.cashier)).send({ name: 'Mystery Fitting', unit: 'pcs', price: '75' });
      expect(r.status).toBe(201);
      expect(r.body.needs_review).toBe(true);
      const review = (await t.http().get('/v1/products?needsReview=true').set(auth(c.manager))).body;
      expect(review.map((x: any) => x.name)).toContain('Mystery Fitting');
      // storekeeper has neither sale.create nor catalog.manage? (catalog.manage yes) -> ok; a custom role without both is refused
    });

    it('stale edits are rejected with VERSION_CONFLICT; fresh ones succeed', async () => {
      const p = await addProduct(t, c.owner, { name: 'Versioned' });
      const first = await t.http().patch(`/v1/products/${p.id}`).set(auth(c.manager)).send({ version: p.version, name: 'Versioned 2' });
      expect(first.status).toBe(200);
      expect(first.body.version).toBe(p.version + 1);
      const stale = await t.http().patch(`/v1/products/${p.id}`).set(auth(c.owner)).send({ version: p.version, name: 'Versioned 3' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
    });

    it('only roles with catalog.manage can create products; cashiers cannot', async () => {
      expect((await t.http().post('/v1/products').set(auth(c.cashier)).send({ name: 'Nope', baseUnit: 'pcs' })).status).toBe(403);
    });

    it('batch tracking needs the batch_expiry feature', async () => {
      const basic = await setupShop(t, { plan: 'basic' });
      const res = await t.http().post('/v1/products').set(auth(basic.owner)).send({ name: 'Paint Tin', baseUnit: 'L', trackBatches: true });
      expect(res.body.code).toBe('FEATURE_NOT_ENABLED');
    });

    it('max_products plan limit is enforced', async () => {
      const shop = await setupShop(t, { plan: 'basic' });
      const admin = (await import('./helpers')).platformToken;
      const token = await admin(t);
      await t.http().put(`/v1/admin/shops/${shop.shop.shopId}/limits`).set(auth(token)).send({ key: 'max_products', value: 2 }).expect(204);
      await addProduct(t, shop.owner, { name: 'P1' });
      await addProduct(t, shop.owner, { name: 'P2' });
      const third = await t.http().post('/v1/products').set(auth(shop.owner)).send({ name: 'P3', baseUnit: 'pcs' });
      expect(third.body.code).toBe('PLAN_LIMIT');
    });

    it('variant generator previews and creates the combinations, skipping existing', async () => {
      const tpl = { baseName: 'Weather Coat', baseUnit: 'L', decimalQty: true, axes: { sheen: ['Matt', 'Silk'], colour: ['White', 'Ivory'], pack: ['1 L', '4 L'] } };
      const prev = await t.http().post('/v1/products/variants/preview').set(auth(c.owner)).send(tpl);
      expect(prev.body).toHaveLength(8);
      const gen = await t.http().post('/v1/products/variants/generate').set(auth(c.owner)).send(tpl);
      expect(gen.body).toEqual({ created: 8, skipped: 0, total: 8 });
      expect((await t.http().post('/v1/products/variants/generate').set(auth(c.owner)).send(tpl)).body).toEqual({ created: 0, skipped: 8, total: 8 });
      const big = { ...tpl, axes: { a: Array.from({ length: 10 }, (_, i) => `a${i}`), b: Array.from({ length: 10 }, (_, i) => `b${i}`), c: Array.from({ length: 10 }, (_, i) => `c${i}`) } };
      expect((await t.http().post('/v1/products/variants/preview').set(auth(c.owner)).send(big)).status).toBe(400);
    });

    it('labels: feature gated; carry a scannable code (barcode, else SKU), name, unit; price optional', async () => {
      const basic = await setupShop(t, { plan: 'basic' });
      const bp = await addProduct(t, basic.owner, { name: 'Label Nail', baseUnit: 'kg' });
      expect((await t.http().post('/v1/products/labels/render').set(auth(basic.owner)).send({ productIds: [bp.id], template: 'bin' })).body.code).toBe('FEATURE_NOT_ENABLED');

      const withBarcode = await addProduct(t, c.owner, { name: 'Label A', price: '55', barcode: '4795550001112' });
      const noBarcode = await addProduct(t, c.owner, { name: 'Label Nut', baseUnit: 'kg', price: '300' });
      const res = (await t.http().post('/v1/products/labels/render').set(auth(c.owner)).send({ productIds: [withBarcode.id, noBarcode.id], template: 'shelf', includePrice: true })).body;
      const byName = Object.fromEntries(res.labels.map((l: any) => [l.name, l]));
      expect(byName['Label A']).toMatchObject({ code: '4795550001112', price: '55.0000' });
      expect(byName['Label Nut']).toMatchObject({ code: noBarcode.sku, unit: 'kg' });
      expect(res.zpl).toContain('^BCN');
      const bin = (await t.http().post('/v1/products/labels/render').set(auth(c.owner)).send({ productIds: [noBarcode.id], template: 'bin' })).body;
      expect(bin.labels[0].price).toBeUndefined();
    });
  });
});

describe('master catalog', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await createApp();
  });
  afterAll(() => t.close());

  it('searches English, Sinhala and alternative names; never returns prices or stock', async () => {
    const c = await setupShop(t);
    const r = async (q: string) => (await t.http().get('/v1/master/products').query({ q }).set(auth(c.owner))).body;
    expect((await r('cement')).map((x: any) => x.name_en)).toContain('Cement 50kg Bag');
    expect((await r('සිමෙන්ති')).length).toBeGreaterThan(0);
    expect((await r('nail 2')).map((x: any) => x.name_en)).toContain('Wire Nail 2 inch');
    for (const row of await r('paint')) expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['price', 'stock']));
  });

  it('adds a catalog item to the shop once; variants become separate shop products', async () => {
    const c = await setupShop(t);
    const m = (await t.http().get('/v1/master/products').query({ q: 'emulsion' }).set(auth(c.owner))).body[0];
    const variants = (await t.http().get(`/v1/master/products/${m.id}/variants`).set(auth(c.owner))).body;
    expect(variants.length).toBeGreaterThan(1);
    const a = await t.http().post('/v1/products/from-master').set(auth(c.owner)).send({ masterProductId: m.id, variantId: variants[0].id, price: '4200' });
    expect(a.status).toBe(201);
    expect(a.body.name).toContain(variants[0].label);
    expect((await t.http().post('/v1/products/from-master').set(auth(c.owner)).send({ masterProductId: m.id, variantId: variants[0].id })).status).toBe(409);
    expect((await t.http().post('/v1/products/from-master').set(auth(c.owner)).send({ masterProductId: m.id, variantId: variants[1].id })).status).toBe(201);
  });

  it('bulk selection by category skips what the shop already has and respects shop type', async () => {
    const hw = await setupShop(t, { shopType: 'hardware' });
    const cats = (await t.http().get('/v1/master/categories').set(auth(hw.owner))).body;
    expect(cats.map((x: any) => x.name)).not.toContain('Paint'); // paint is not offered to hardware-only shops
    const fasteners = cats.find((x: any) => x.name === 'Fasteners');
    const first = await t.http().post('/v1/products/bulk-from-master').set(auth(hw.owner)).send({ categoryIds: [fasteners.id] });
    expect(first.body.created).toBe(fasteners.products);
    expect((await t.http().post('/v1/products/bulk-from-master').set(auth(hw.owner)).send({ categoryIds: [fasteners.id] })).body.created).toBe(0);

    const paint = await setupShop(t, { shopType: 'paint' });
    expect((await t.http().get('/v1/master/categories').set(auth(paint.owner))).body.map((x: any) => x.name)).toContain('Paint');
  });

  it('shops submit missing products; Super Admin approves; the item then appears in the catalog', async () => {
    const c = await setupShop(t);
    const sub = await t.http().post('/v1/master/submissions').set(auth(c.owner)).send({ name: 'Zinc Roofing Sheet 8ft', baseUnit: 'pcs' });
    expect(sub.status).toBe(201);
    expect((await t.http().get('/v1/master/products').query({ q: 'zinc roofing' }).set(auth(c.owner))).body).toHaveLength(0);
    const { AuthService } = await import('../src/auth/auth.service');
    const { MasterCatalogService } = await import('../src/catalog/master.service');
    const svc = t.app.get(MasterCatalogService);
    const adminId = await t.app.get(AuthService).createPlatformAdmin(`a${Date.now()}@p.lk`, 'A', 'x');
    await t.db.platform((tx) => svc.approveSubmission(tx, adminId, sub.body.id));
    expect((await t.http().get('/v1/master/products').query({ q: 'zinc roofing' }).set(auth(c.owner))).body).toHaveLength(1);
  });

  it('suggestMatch finds by barcode then by similar name', async () => {
    const c = await setupShop(t);
    const r = await t.http().post('/v1/master/suggest').set(auth(c.owner)).send({ name: 'Wire Nail 2 in' });
    expect(r.body[0].name_en).toBe('Wire Nail 2 inch');
  });
});
