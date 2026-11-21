import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, put, qs } from '../../api';
import { money, qtyText } from '../../money';
import { useCan, useHas, useMe } from '../../session';
import { toast } from '../../store';
import { Badge, Empty, Field, fail, Loading, Modal, PageHeader, Table } from '../../ui';
import { pickNum, Tabs } from './shared';

export function Products() {
  const qc = useQueryClient();
  const canPrice = useCan('price.change');
  const hasBatches = useHas('batch_expiry');
  const me = useMe();
  const [q, setQ] = useState('');
  const [review, setReview] = useState(false);
  const [adding, setAdding] = useState(false);
  const [master, setMaster] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const list = useQuery({
    queryKey: ['products', q, review],
    queryFn: () => (q.trim() ? get<any[]>(`/products/search${qs({ q, limit: 50 })}`) : get<any[]>(`/products${qs({ needsReview: review ? 'true' : undefined, limit: 200 })}`)),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['products'] });
  return (
    <>
      <PageHeader title="Products" sub="Your items, units, prices and barcodes">
        <button className="btn btn-secondary" onClick={() => setMaster(true)}>Add from catalog</button>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ New product</button>
      </PageHeader>
      <div className="mb-3 flex gap-2">
        <input className="input max-w-md" placeholder="Search name, SKU, short code or barcode" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> Needs review</label>
      </div>
      {list.isLoading ? <Loading /> : (
        <Table head={['Item', 'SKU / code', 'Unit', 'Price', 'Stock', '']} empty={list.data?.length === 0 && <Empty>No products found.</Empty>}>
          {list.data?.map((p) => (
            <tr key={p.id} className="hover:bg-slate-50">
              <td className="td"><div className="font-medium">{p.name}{p.favourite && ' ★'}</div>{p.needs_review && <Badge tone="amber">needs review</Badge>}{p.track_batches && <Badge tone="blue">batches</Badge>}</td>
              <td className="td text-xs text-slate-500">{p.sku}<br />{p.short_code}</td>
              <td className="td">{p.base_unit}</td>
              <td className="td">{p.price ? money(p.price) : <Badge tone="amber">no price</Badge>}</td>
              <td className="td">{p.stock !== undefined ? qtyText(p.stock) : ''}</td>
              <td className="td text-right"><button className="btn btn-secondary" onClick={() => setEdit(p)}>Open</button></td>
            </tr>
          ))}
        </Table>
      )}
      {adding && <NewProduct onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} hasBatches={hasBatches} />}
      {master && <MasterPicker onClose={() => setMaster(false)} onSaved={refresh} />}
      {edit && <ProductDetail id={edit.id} canPrice={canPrice} onClose={() => { setEdit(null); refresh(); }} branchId={me.session.branchId} />}
    </>
  );
}

function NewProduct({ onClose, onSaved, hasBatches }: { onClose: () => void; onSaved: () => void; hasBatches: boolean }) {
  const [f, setF] = useState({ name: '', nameSi: '', baseUnit: 'pcs', decimalQty: false, price: '', minLevel: '', barcode: '', category: '', trackBatches: false, shelfLifeDays: '', convUnit: '', convFactor: '' });
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const m = useMutation({
    mutationFn: () =>
      post('/products', {
        name: f.name, nameSi: f.nameSi || undefined, baseUnit: f.baseUnit, decimalQty: f.decimalQty, price: f.price || undefined, minLevel: f.minLevel || undefined,
        barcode: f.barcode || undefined, category: f.category || undefined, trackBatches: f.trackBatches || undefined, shelfLifeDays: f.shelfLifeDays ? Number(f.shelfLifeDays) : undefined,
        units: f.convUnit && f.convFactor ? [{ unit: f.convUnit, factor: f.convFactor }] : undefined,
      }),
    onSuccess: () => { toast.ok('Product created'); onSaved(); },
    onError: fail,
  });
  return (
    <Modal title="New product" onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Name"><input className="input" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Sinhala name (optional)"><input className="input" value={f.nameSi} onChange={(e) => set('nameSi', e.target.value)} /></Field>
        <Field label="Base unit" hint="Stock is counted in this unit (pcs, kg, m, L, ml)"><input className="input" value={f.baseUnit} onChange={(e) => set('baseUnit', e.target.value)} /></Field>
        <Field label="Category"><input className="input" value={f.category} onChange={(e) => set('category', e.target.value)} /></Field>
        <Field label="Selling price per base unit"><input className="input" inputMode="decimal" value={f.price} onChange={(e) => set('price', pickNum(e.target.value))} /></Field>
        <Field label="Minimum stock level" hint="You are alerted at or below this"><input className="input" inputMode="decimal" value={f.minLevel} onChange={(e) => set('minLevel', pickNum(e.target.value))} /></Field>
        <Field label="Barcode (optional)"><input className="input" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} /></Field>
        <div className="mb-3 flex items-end gap-2">
          <Field label="Other unit"><input className="input" placeholder="box" value={f.convUnit} onChange={(e) => set('convUnit', e.target.value)} /></Field>
          <Field label="= how many base"><input className="input" placeholder="12" inputMode="decimal" value={f.convFactor} onChange={(e) => set('convFactor', pickNum(e.target.value))} /></Field>
        </div>
      </div>
      <label className="mr-6 text-sm"><input type="checkbox" checked={f.decimalQty} onChange={(e) => set('decimalQty', e.target.checked)} /> Sold in fractions (metres, kg, litres)</label>
      {hasBatches && <label className="text-sm"><input type="checkbox" checked={f.trackBatches} onChange={(e) => set('trackBatches', e.target.checked)} /> Track batches and expiry</label>}
      {f.trackBatches && <Field label="Shelf life (days)" hint="Used to work out expiry when only a manufacture date is entered"><input className="input max-w-40" inputMode="numeric" value={f.shelfLifeDays} onChange={(e) => set('shelfLifeDays', pickNum(e.target.value))} /></Field>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!f.name || m.isPending} onClick={() => m.mutate()}>Create</button>
      </div>
    </Modal>
  );
}

function MasterPicker({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState('');
  const [price, setPrice] = useState<Record<string, string>>({});
  const cats = useQuery({ queryKey: ['master-cats'], queryFn: () => get<any[]>('/master/categories') });
  const r = useQuery({ queryKey: ['master', q], queryFn: () => get<any[]>(`/master/products${qs({ q })}`) });
  const add = useMutation({
    mutationFn: (p: any) => post('/products/from-master', { masterProductId: p.id, price: price[p.id] || undefined }),
    onSuccess: () => { toast.ok('Added to your shop'); onSaved(); },
    onError: fail,
  });
  const bulk = useMutation({
    mutationFn: (id: string) => post<{ created: number }>('/products/bulk-from-master', { categoryIds: [id] }),
    onSuccess: (x) => { toast.ok(`${x.created} products added`); onSaved(); },
    onError: fail,
  });
  return (
    <Modal title="Add from the shared catalog" onClose={onClose} wide>
      <p className="mb-3 text-sm text-slate-500">Ready-made products with English and Sinhala names. You keep your own prices and stock.</p>
      <div className="mb-3 flex flex-wrap gap-2">
        {cats.data?.map((c) => <button key={c.id} className="btn btn-secondary text-xs" disabled={bulk.isPending} onClick={() => bulk.mutate(c.id)}>Add all {c.name} ({c.products})</button>)}
      </div>
      <input className="input mb-3" placeholder="Search the catalog" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-80 overflow-auto">
        {r.data?.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-2 border-b border-slate-100 py-2 text-sm">
            <div><div className="font-medium">{p.name_en}</div><div className="text-xs text-slate-400">{p.name_si} {p.category}</div></div>
            <div className="flex items-center gap-2">
              <input className="input !w-24 text-right" placeholder="price" inputMode="decimal" value={price[p.id] ?? ''} onChange={(e) => setPrice({ ...price, [p.id]: pickNum(e.target.value) })} />
              <button className="btn btn-primary" onClick={() => add.mutate(p)}>Add</button>
            </div>
          </div>
        ))}
        {r.data?.length === 0 && <Empty>No catalog items match.</Empty>}
      </div>
    </Modal>
  );
}

function ProductDetail({ id, canPrice, onClose, branchId }: { id: string; canPrice: boolean; onClose: () => void; branchId?: string }) {
  const qc = useQueryClient();
  const hasTiers = useHas('price_tiers');
  const canCost = useCan('cost.view');
  const [tab, setTab] = useState('info');
  const p = useQuery({ queryKey: ['product', id], queryFn: () => get<any>(`/products/${id}`) });
  const prices = useQuery({ queryKey: ['price-history', id], queryFn: () => get<any[]>(`/products/${id}/prices/history`), enabled: canPrice && tab === 'price' });
  const cost = useQuery({ queryKey: ['cost', id], queryFn: () => get<any>(`/products/${id}/cost`), enabled: canCost && tab === 'cost' });
  const [price, setPrice] = useState('');
  const [tier, setTier] = useState('retail');
  const [code, setCode] = useState('');
  const [minLevel, setMinLevel] = useState('');
  const reload = () => { qc.invalidateQueries({ queryKey: ['product', id] }); qc.invalidateQueries({ queryKey: ['price-history', id] }); };
  const setP = useMutation({ mutationFn: () => put(`/products/${id}/prices`, { price, tier }), onSuccess: () => { toast.ok('Price saved'); setPrice(''); reload(); }, onError: fail });
  const addCode = useMutation({ mutationFn: () => post(`/products/${id}/barcodes`, { code }), onSuccess: () => { setCode(''); reload(); toast.ok('Barcode added'); }, onError: fail });
  const upd = useMutation({
    mutationFn: (patchBody: any) => patch(`/products/${id}`, { version: p.data.version, ...patchBody }),
    onSuccess: () => { toast.ok('Saved'); reload(); },
    onError: fail,
  });
  if (!p.data) return <Modal title="Product" onClose={onClose}><Loading /></Modal>;
  const d = p.data;
  void branchId;
  return (
    <Modal title={d.name} onClose={onClose} wide>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'info', label: 'Details' }, ...(canPrice ? [{ key: 'price', label: 'Price' }] : []), ...(canCost ? [{ key: 'cost', label: 'Cost' }] : [])]} />
      {tab === 'info' && (
        <>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="label">SKU</span>{d.sku}</div>
            <div><span className="label">Short code</span>{d.short_code}</div>
            <div><span className="label">Base unit</span>{d.base_unit}</div>
            <div><span className="label">Units</span>{d.units.map((u: any) => `${u.unit}${u.is_base ? '' : ` = ${qtyText(u.factor)} ${d.base_unit}`}`).join(' · ')}</div>
          </div>
          <div className="mt-4"><span className="label">Barcodes</span>
            <div className="mb-2 flex flex-wrap gap-1">{d.barcodes.map((b: any) => <Badge key={b.id}>{b.code}</Badge>)}{d.barcodes.length === 0 && <span className="text-sm text-slate-400">none (use the printed SKU label)</span>}</div>
            <div className="flex gap-2"><input className="input max-w-xs" placeholder="Scan or type a barcode" value={code} onChange={(e) => setCode(e.target.value)} /><button className="btn btn-secondary" disabled={code.length < 3} onClick={() => addCode.mutate()}>Add</button></div>
          </div>
          <div className="mt-4 flex items-end gap-4">
            <Field label="Minimum stock level"><div className="flex gap-2"><input className="input !w-28" inputMode="decimal" placeholder={qtyText(d.min_level)} value={minLevel} onChange={(e) => setMinLevel(pickNum(e.target.value))} /><button className="btn btn-secondary" disabled={!minLevel} onClick={() => upd.mutate({ minLevel })}>Save</button></div></Field>
            <label className="mb-3 text-sm"><input type="checkbox" checked={d.favourite} onChange={(e) => upd.mutate({ favourite: e.target.checked })} /> Show on the till as a favourite ★</label>
            {d.needs_review && <button className="btn btn-secondary mb-3" onClick={() => upd.mutate({ needsReview: false })}>Mark reviewed</button>}
          </div>
        </>
      )}
      {tab === 'price' && (
        <>
          <p className="mb-3 text-sm text-slate-500">A new price applies to the next sale, whichever batch the stock came from. Nothing is blocked or needs approval.</p>
          <div className="mb-4 flex items-end gap-2">
            <Field label="New price"><input className="input !w-40" inputMode="decimal" value={price} onChange={(e) => setPrice(pickNum(e.target.value))} /></Field>
            {hasTiers && <Field label="Tier"><select className="input" value={tier} onChange={(e) => setTier(e.target.value)}><option value="retail">Retail</option><option value="wholesale">Wholesale</option><option value="contractor">Contractor</option></select></Field>}
            <button className="btn btn-primary mb-3" disabled={!price || setP.isPending} onClick={() => setP.mutate()}>Save price</button>
          </div>
          <Table head={['When', 'Tier', 'From', 'To']}>
            {prices.data?.map((h) => <tr key={h.id}><td className="td">{new Date(h.created_at).toLocaleString()}</td><td className="td">{h.tier}</td><td className="td">{h.old_price ? money(h.old_price) : '—'}</td><td className="td font-medium">{money(h.new_price)}</td></tr>)}
          </Table>
        </>
      )}
      {tab === 'cost' && cost.data && (
        <>
          <div className="mb-3 text-sm">Last known cost: <b>{cost.data.lastKnownCost ? money(cost.data.lastKnownCost) : 'unknown'}</b> {cost.data.hasEstimatedLayers && <Badge tone="amber">some cost is estimated</Badge>}</div>
          <Table head={['Received', 'Qty left', 'Unit cost', 'Source']}>
            {cost.data.layers.map((l: any) => <tr key={l.id}><td className="td">{new Date(l.received_at).toLocaleDateString()}</td><td className="td">{qtyText(l.qty_remaining)}</td><td className="td">{money(l.unit_cost)}{l.estimated && ' (est.)'}</td><td className="td">{l.source_type}</td></tr>)}
          </Table>
        </>
      )}
    </Modal>
  );
}
