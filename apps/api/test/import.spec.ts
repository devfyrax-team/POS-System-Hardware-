import { JobQueue } from '../src/jobs/job-queue';
import { auth, createApp, TestCtx } from './helpers';
import { addProduct, balance, Ctx, ledgerDiffs, setupShop } from './inv-helpers';

describe('bulk import', () => {
  let t: TestCtx;
  let c: Ctx;
  beforeAll(async () => {
    t = await createApp();
    c = await setupShop(t);
  });
  afterAll(() => t.close());

  const upload = async (rows: any[], token = c.owner) => (await t.http().post('/v1/imports').set(auth(token)).send({ rows })).body.batchId as string;
  const run = async (id: string) => {
    await t.http().post(`/v1/imports/${id}/validate`).set(auth(c.owner)).expect(200);
    await t.http().post(`/v1/imports/${id}/confirm`).set(auth(c.owner)).expect(200);
    await t.app.get(JobQueue).drain();
  };

  it('is feature gated and permission gated', async () => {
    const basic = await setupShop(t, { plan: 'basic' });
    expect((await t.http().post('/v1/imports').set(auth(basic.owner)).send({ rows: [{ name: 'x' }] })).body.code).toBe('FEATURE_NOT_ENABLED');
    expect((await t.http().post('/v1/imports').set(auth(c.cashier)).send({ rows: [{ name: 'x' }] })).status).toBe(403);
  });

  it('validates rows, reports errors with a downloadable error file, and only good rows import', async () => {
    const id = await upload([
      { name: 'Import Good 1', unit: 'pcs', price: '100', cost: '60', qty: '10' },
      { name: '', unit: 'pcs', price: '5' },
      { name: 'Import Bad Price', price: 'abc', qty: '-2' },
      { name: 'Import Good 2', unit: 'kg', price: '250.50', qty: '2.5' },
    ]);
    const prev = (await t.http().post(`/v1/imports/${id}/validate`).set(auth(c.owner))).body;
    expect(prev.counts).toEqual({ ok: 2, error: 2 });
    expect(prev.problems.map((p: any) => p.row_no)).toEqual([2, 3]);
    const csv = (await t.http().get(`/v1/imports/${id}/errors.csv`).set(auth(c.owner))).text;
    expect(csv.split('\n')).toHaveLength(3);
    expect(csv).toContain('name is required');
    expect(csv).toContain('price must be a non-negative number');

    await t.http().post(`/v1/imports/${id}/confirm`).set(auth(c.owner)).expect(200);
    await t.app.get(JobQueue).drain();
    const done = (await t.http().get(`/v1/imports/${id}`).set(auth(c.owner))).body;
    expect(done.status).toBe('done');
    expect(done.counts).toEqual({ imported: 2, error: 2 });
    const p = (await t.http().get('/v1/products/search').query({ q: 'import good 1' }).set(auth(c.owner))).body[0];
    expect(p).toMatchObject({ price: '100.0000', stock: '10.0000' });
    const g2 = (await t.http().get('/v1/products/search').query({ q: 'import good 2' }).set(auth(c.owner))).body[0];
    expect(g2).toMatchObject({ stock: '2.5000', decimal_qty: true });
    expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    // opening stock posted with its cost as a separate ledger entry
    const mv = (await t.db.admin((tx) => tx.query(`SELECT type, unit_cost FROM stock_movement WHERE product_id=$1`, [p.id]))).rows;
    expect(mv).toEqual([{ type: 'opening', unit_cost: '60.0000' }]);
  });

  it('matches existing items (barcode, SKU, exact and fuzzy name) and asks for a decision instead of duplicating', async () => {
    const ex = await addProduct(t, c.owner, { name: 'Wire Nail 2 inch', barcode: '4791110002223', price: '300' });
    const id = await upload([
      { name: 'Anything', barcode: '4791110002223', qty: '5' }, // barcode match
      { name: 'Whatever', sku: ex.sku }, // SKU match
      { name: 'wire nail 2 inch' }, // exact name
      { name: 'Wire Nail 2 inch.' }, // fuzzy
      { name: 'Totally New Thing' },
    ]);
    const prev = (await t.http().post(`/v1/imports/${id}/validate`).set(auth(c.owner))).body;
    expect(prev.counts).toEqual({ review: 4, ok: 1 });
    expect(prev.undecided).toBe(4);
    expect(prev.problems.map((p: any) => p.match.type)).toEqual(['barcode', 'sku', 'name_exact', 'fuzzy']);
    // cannot confirm while undecided
    expect((await t.http().post(`/v1/imports/${id}/confirm`).set(auth(c.owner))).status).toBe(409);

    const rowIds = prev.problems.map((p: any) => p.id);
    await t.http().put(`/v1/imports/${id}/decisions`).set(auth(c.owner)).send({ rowIds: [rowIds[0]], decision: 'use_existing' }).expect(200);
    await t.http().put(`/v1/imports/${id}/decisions`).set(auth(c.owner)).send({ rowIds: [rowIds[1], rowIds[2]], decision: 'skip' }).expect(200);
    await t.http().put(`/v1/imports/${id}/decisions`).set(auth(c.owner)).send({ rowIds: [rowIds[3]], decision: 'create' }).expect(200);
    await t.http().post(`/v1/imports/${id}/confirm`).set(auth(c.owner)).expect(200);
    await t.app.get(JobQueue).drain();

    const done = (await t.http().get(`/v1/imports/${id}`).set(auth(c.owner))).body;
    expect(done.counts).toEqual({ imported: 3, skipped: 2 });
    expect(await balance(t, c.shop.defaultBranchId, ex.id)).toBe('5'); // use_existing + qty posted as opening stock to the existing item
    const dupes = (await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM product WHERE shop_id=$1 AND lower(name) = 'wire nail 2 inch'`, [c.shop.shopId]))).rows[0].c;
    expect(dupes).toBe(1);
  });

  it('one undo reverses the whole batch (products deactivated, opening stock reversed); blocked if sold', async () => {
    const id = await upload([
      { name: 'Undo Item 1', price: '10', qty: '5', cost: '4' },
      { name: 'Undo Item 2', price: '20', qty: '7', cost: '8' },
    ]);
    await run(id);
    const p1 = (await t.http().get('/v1/products/search').query({ q: 'undo item 1' }).set(auth(c.owner))).body[0];
    const p2 = (await t.http().get('/v1/products/search').query({ q: 'undo item 2' }).set(auth(c.owner))).body[0];
    // sell one unit of item 1 -> undo must be refused
    await t.db.tenant({ shopId: c.shop.shopId }, async (tx) => {
      const { StockService } = await import('../src/inventory/stock.service');
      await t.app.get(StockService).apply(tx, { shopId: c.shop.shopId, branchId: c.shop.defaultBranchId, productId: p1.id, type: 'sale', qtyBase: '-1' });
    });
    const blocked = await t.http().post(`/v1/imports/${id}/undo`).set(auth(c.owner));
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.productIds).toEqual([p1.id]);

    const id2 = await upload([{ name: 'Undo Clean 1', price: '10', qty: '3' }, { name: 'Undo Clean 2', price: '10', qty: '4' }]);
    await run(id2);
    const undo = await t.http().post(`/v1/imports/${id2}/undo`).set(auth(c.owner));
    expect(undo.body.reversed).toBe(2);
    expect((await t.http().get('/v1/products/search').query({ q: 'undo clean' }).set(auth(c.owner))).body).toEqual([]);
    expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
    expect(p2).toBeTruthy();
  });

  it('processing is chunked, tracks progress and is resumable/idempotent', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ name: `Bulk Item ${String(i).padStart(4, '0')}`, unit: 'pcs', price: String(10 + (i % 7)), qty: '3' }));
    const id = await upload(rows);
    await run(id);
    const done = (await t.http().get(`/v1/imports/${id}`).set(auth(c.owner))).body;
    expect(done).toMatchObject({ status: 'done', total: 1200, processed: 1200, counts: { imported: 1200 } });
    const n = (await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM product WHERE shop_id=$1 AND name LIKE 'Bulk Item %'`, [c.shop.shopId]))).rows[0].c;
    expect(n).toBe(1200);
    // running the processor again does nothing new
    const { ImportService } = await import('../src/import/import.service');
    await t.app.get(ImportService).process(t.db, c.shop.shopId, id);
    expect((await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM product WHERE shop_id=$1 AND name LIKE 'Bulk Item %'`, [c.shop.shopId]))).rows[0].c).toBe(1200);
    expect((await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM stock_movement WHERE shop_id=$1 AND ref_id=$2`, [c.shop.shopId, id]))).rows[0].c).toBe(1200);
    expect(await ledgerDiffs(t, c.shop.shopId)).toEqual([]);
  });

  it('respects the max_products plan limit mid-import (batch fails, nothing partial beyond completed chunks)', async () => {
    const small = await setupShop(t, { plan: 'enterprise' });
    const { platformToken } = await import('./helpers');
    await t.http().put(`/v1/admin/shops/${small.shop.shopId}/limits`).set(auth(await platformToken(t))).send({ key: 'max_products', value: 3 }).expect(204);
    const id = (await t.http().post('/v1/imports').set(auth(small.owner)).send({ rows: [1, 2, 3, 4, 5].map((i) => ({ name: `Limit ${i}` })) })).body.batchId;
    await t.http().post(`/v1/imports/${id}/validate`).set(auth(small.owner)).expect(200);
    await t.http().post(`/v1/imports/${id}/confirm`).set(auth(small.owner)).expect(200);
    await t.app.get(JobQueue).drain();
    expect((await t.http().get(`/v1/imports/${id}`).set(auth(small.owner))).body.status).toBe('failed');
    const n = (await t.db.admin((tx) => tx.query(`SELECT count(*)::int c FROM product WHERE shop_id=$1`, [small.shop.shopId]))).rows[0].c;
    expect(n).toBe(0); // the single chunk rolled back as a unit
  });

  it('a shop cannot read another shop\'s import batch', async () => {
    const other = await setupShop(t);
    const id = await upload([{ name: 'Private Import' }]);
    expect((await t.http().get(`/v1/imports/${id}`).set(auth(other.owner))).status).toBe(404);
  });
});
