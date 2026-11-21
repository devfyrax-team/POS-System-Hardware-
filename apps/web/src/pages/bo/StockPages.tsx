import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../../api';
import { money, qtyText } from '../../money';
import { useCan, useHas, useMe } from '../../session';
import { toast } from '../../store';
import { Badge, Empty, Field, fail, Loading, Modal, PageHeader, Table } from '../../ui';
import { dateText, pickNum, Product, ProductPicker, Tabs } from './shared';

export function StockPage() {
  const me = useMe();
  const [tab, setTab] = useState('low');
  const canAdjust = useCan('stock.adjust');
  const canRequest = useCan('stock.adjust_request');
  const canOpen = useCan('stock.receive');
  const [adjust, setAdjust] = useState(false);
  const [opening, setOpening] = useState(false);
  const branchParam = me.session.branchId ?? (me.branchMode.singleBranchId ?? 'all');
  return (
    <>
      <PageHeader title="Stock" sub="Quantities by branch. Stock never goes below zero.">
        {canOpen && <button className="btn btn-secondary" onClick={() => setOpening(true)}>Opening stock</button>}
        {canRequest && <button className="btn btn-primary" onClick={() => setAdjust(true)}>{canAdjust ? 'Adjust stock' : 'Request adjustment'}</button>}
      </PageHeader>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'low', label: 'Low & out of stock' }, { key: 'all', label: 'All stock' }, { key: 'adj', label: 'Adjustments' }, { key: 'moves', label: 'Movements' }]} />
      {tab === 'low' && <LowStock branch={branchParam} />}
      {tab === 'all' && <AllStock branch={branchParam} />}
      {tab === 'adj' && <Adjustments canApprove={canAdjust} />}
      {tab === 'moves' && <Movements branch={branchParam} />}
      {adjust && <AdjustModal onClose={() => setAdjust(false)} />}
      {opening && <OpeningModal onClose={() => setOpening(false)} />}
    </>
  );
}

function LowStock({ branch }: { branch: string }) {
  const q = useQuery({ queryKey: ['low', branch], queryFn: () => get<any[]>(`/stock/low${qs({ branchId: branch })}`) });
  if (q.isLoading) return <Loading />;
  return (
    <Table head={['Item', 'Left', 'Minimum', 'Status']} empty={q.data?.length === 0 && <Empty>Everything is above its minimum level.</Empty>}>
      {q.data?.map((r) => (
        <tr key={`${r.branch_id}-${r.product_id}`}><td className="td font-medium">{r.name}<span className="ml-2 text-xs text-slate-400">{r.sku}</span></td><td className="td">{qtyText(r.quantity)} {r.base_unit}</td><td className="td">{qtyText(r.min_level)}</td>
          <td className="td">{r.state === 'out' ? <Badge tone="red">Out of stock</Badge> : <Badge tone="amber">Low</Badge>}</td></tr>
      ))}
    </Table>
  );
}

function AllStock({ branch }: { branch: string }) {
  const q = useQuery({ queryKey: ['stock', branch], queryFn: () => get<any[]>(`/stock${qs({ branchId: branch, limit: 500 })}`) });
  if (q.isLoading) return <Loading />;
  return (
    <Table head={['Item', 'SKU', 'Quantity', 'Damaged']} empty={q.data?.length === 0 && <Empty>No stock recorded yet. Post opening stock to start.</Empty>}>
      {q.data?.map((r) => <tr key={`${r.branch_id}-${r.product_id}`}><td className="td font-medium">{r.name}</td><td className="td text-xs text-slate-400">{r.sku}</td><td className="td">{qtyText(r.quantity)} {r.base_unit}</td><td className="td">{Number(r.damaged_qty) ? qtyText(r.damaged_qty) : ''}</td></tr>)}
    </Table>
  );
}

function Movements({ branch }: { branch: string }) {
  const q = useQuery({ queryKey: ['moves', branch], queryFn: () => get<any[]>(`/stock/movements${qs({ branchId: branch, limit: 100 })}`) });
  if (q.isLoading) return <Loading />;
  return (
    <Table head={['When', 'Type', 'Qty', 'Reason']} empty={q.data?.length === 0 && <Empty>No movements.</Empty>}>
      {q.data?.map((m) => <tr key={m.id}><td className="td">{new Date(m.created_at).toLocaleString()}</td><td className="td">{m.type}</td><td className={`td font-medium ${Number(m.qty_base) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{Number(m.qty_base) > 0 ? '+' : ''}{qtyText(m.qty_base)}</td><td className="td text-xs text-slate-500">{m.reason}</td></tr>)}
    </Table>
  );
}

function Adjustments({ canApprove }: { canApprove: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['adjustments'], queryFn: () => get<any[]>('/adjustments') });
  const act = useMutation({
    mutationFn: ({ id, what }: { id: string; what: 'approve' | 'reject' }) => post(`/adjustments/${id}/${what}`),
    onSuccess: () => { toast.ok('Done'); qc.invalidateQueries(); },
    onError: fail,
  });
  if (q.isLoading) return <Loading />;
  return (
    <Table head={['When', 'Reason', 'Lines', 'Status', '']} empty={q.data?.length === 0 && <Empty>No adjustments yet.</Empty>}>
      {q.data?.map((a) => (
        <tr key={a.id}>
          <td className="td">{new Date(a.created_at).toLocaleString()}</td><td className="td">{a.reason}</td>
          <td className="td text-xs">{a.lines?.map((l: any) => `${l.kind} ${qtyText(l.qtyDelta)}`).join(', ')}</td>
          <td className="td"><Badge tone={a.status === 'posted' ? 'green' : a.status === 'rejected' ? 'red' : 'amber'}>{a.status}</Badge></td>
          <td className="td text-right">{canApprove && a.status === 'requested' && (<><button className="btn btn-primary mr-1" onClick={() => act.mutate({ id: a.id, what: 'approve' })}>Approve</button><button className="btn btn-secondary" onClick={() => act.mutate({ id: a.id, what: 'reject' })}>Reject</button></>)}</td>
        </tr>
      ))}
    </Table>
  );
}

function AdjustModal({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const [item, setItem] = useState<Product | null>(null);
  const [kind, setKind] = useState('adjustment');
  const [dir, setDir] = useState<'-' | '+'>('-');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => post('/adjustments', { branchId: me.session.branchId ?? me.branchMode.singleBranchId, reason, lines: [{ productId: item!.id, kind, qtyDelta: `${kind === 'adjustment' ? dir : '-'}${qty}` }] }),
    onSuccess: (r: any) => { toast.ok(r.status === 'posted' ? 'Stock adjusted' : 'Sent for approval'); qc.invalidateQueries(); onClose(); },
    onError: fail,
  });
  return (
    <Modal title="Adjust stock" onClose={onClose}>
      {item ? <div className="mb-3 flex justify-between rounded-md bg-slate-50 p-2 text-sm"><b>{item.name}</b><span>{qtyText(item.stock)} {item.base_unit} now</span></div> : <div className="mb-3"><ProductPicker onPick={setItem} /></div>}
      <div className="grid grid-cols-3 gap-2">
        <Field label="Type"><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="adjustment">Correction</option><option value="damaged">Damaged</option><option value="expired">Expired</option></select></Field>
        {kind === 'adjustment' && <Field label="Direction"><select className="input" value={dir} onChange={(e) => setDir(e.target.value as any)}><option value="-">Remove</option><option value="+">Add</option></select></Field>}
        <Field label="Quantity"><input className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(pickNum(e.target.value))} /></Field>
      </div>
      <Field label="Reason (required)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!item || !qty || !reason || m.isPending} onClick={() => m.mutate()}>Submit</button></div>
    </Modal>
  );
}

function OpeningModal({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const [rows, setRows] = useState<{ p: Product; qty: string; cost: string }[]>([]);
  const m = useMutation({
    mutationFn: () => post('/stock/opening', { branchId: me.session.branchId ?? me.branchMode.singleBranchId, lines: rows.map((r) => ({ productId: r.p.id, qtyBase: r.qty, unitCost: r.cost || undefined })) }),
    onSuccess: () => { toast.ok('Opening stock posted'); qc.invalidateQueries(); onClose(); },
    onError: fail,
  });
  return (
    <Modal title="Opening stock" onClose={onClose} wide>
      <p className="mb-3 text-sm text-slate-500">Post what you counted. Adding the cost per unit makes profit exact; without it the last known cost is used and flagged as an estimate.</p>
      <ProductPicker onPick={(p) => setRows((r) => (r.find((x) => x.p.id === p.id) ? r : [...r, { p, qty: '', cost: '' }]))} />
      <div className="mt-3">
        {rows.map((r, i) => (
          <div key={r.p.id} className="mb-2 grid grid-cols-[1fr_7rem_7rem_2rem] items-center gap-2 text-sm">
            <span>{r.p.name}</span>
            <input className="input text-right" placeholder={`qty (${r.p.base_unit})`} inputMode="decimal" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: pickNum(e.target.value) } : x)))} />
            <input className="input text-right" placeholder="cost / unit" inputMode="decimal" value={r.cost} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, cost: pickNum(e.target.value) } : x)))} />
            <button className="btn btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!rows.length || rows.some((r) => !r.qty) || m.isPending} onClick={() => m.mutate()}>Post</button></div>
    </Modal>
  );
}

// ---------------- expiry ----------------
export function ExpiryPage() {
  const qc = useQueryClient();
  const canWriteOff = useCan('stock.adjust');
  const [days, setDays] = useState('180');
  const near = useQuery({ queryKey: ['near-expiry', days], queryFn: () => get<any>(`/reports/near-expiry${qs({ withinDays: days })}`) });
  const expired = useQuery({ queryKey: ['expired'], queryFn: () => get<any>('/reports/expired') });
  const wo = useMutation({
    mutationFn: (ids: string[]) => post('/batches/write-off', { batchIds: ids }),
    onSuccess: () => { toast.ok('Expired stock written off'); qc.invalidateQueries(); },
    onError: fail,
  });
  return (
    <>
      <PageHeader title="Expiry" sub="Batches near or past their expiry date" />
      <div className="mb-3 flex items-center gap-2 text-sm">Show batches expiring within <select className="input !w-28" value={days} onChange={(e) => setDays(e.target.value)}>{['30', '90', '180', '365'].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
        {near.data && <span className="ml-auto">Value at cost: <b>{money(near.data.totalValue)}</b></span>}</div>
      <Table head={['Item', 'Batch', 'Branch', 'Expires', 'Left', 'Value', 'Next step']} empty={near.data?.items.length === 0 && <Empty>No batches inside this window.</Empty>}>
        {near.data?.items.map((i: any) => (
          <tr key={i.batchId}><td className="td font-medium">{i.name}</td><td className="td">{i.batchNo}</td><td className="td">{i.branch}</td>
            <td className="td">{dateText(i.expiryDate)} <Badge tone={i.daysLeft < 31 ? 'red' : 'amber'}>{i.daysLeft}d</Badge></td><td className="td">{qtyText(i.qty)}</td><td className="td">{money(i.value)}</td>
            <td className="td text-xs">{i.actions.map((a: string) => a.replace(/_/g, ' ')).join(' · ')}{i.supplier && i.actions.includes('return_to_supplier') ? ` (${i.supplier})` : ''}</td></tr>
        ))}
      </Table>
      <h2 className="mb-2 mt-6 font-semibold">Already expired</h2>
      <Table head={['Item', 'Batch', 'Left', 'Value', '']} empty={expired.data?.items.length === 0 && <Empty>Nothing expired on the shelf.</Empty>}>
        {expired.data?.items.map((i: any) => (
          <tr key={i.batchId}><td className="td font-medium">{i.name}</td><td className="td">{i.batchNo}</td><td className="td">{qtyText(i.qty)}</td><td className="td">{money(i.value)}</td>
            <td className="td text-right">{canWriteOff && <button className="btn btn-danger" disabled={wo.isPending} onClick={() => wo.mutate([i.batchId])}>Write off</button>}</td></tr>
        ))}
      </Table>
    </>
  );
}

// ---------------- branch transfers ----------------
export function TransfersPage() {
  const qc = useQueryClient();
  const me = useMe();
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['transfers'], queryFn: () => get<any[]>('/transfers') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get<any[]>('/branches') });
  const name = (id: string) => branches.data?.find((b) => b.id === id)?.name ?? '';
  const act = useMutation({
    mutationFn: async ({ t, what }: { t: any; what: string }) => {
      if (what === 'receive') {
        const full = await get<any>(`/transfers/${t.id}`);
        return post(`/transfers/${t.id}/receive`, { lines: full.lines.filter((l: any) => Number(l.qty_dispatched) > Number(l.qty_received)).map((l: any) => ({ lineId: l.id, qty: String(Number(l.qty_dispatched) - Number(l.qty_received)) })) });
      }
      return post(`/transfers/${t.id}/${what}`);
    },
    onSuccess: () => { toast.ok('Done'); qc.invalidateQueries({ queryKey: ['transfers'] }); },
    onError: fail,
  });
  const tone = (s: string) => (s === 'received' || s === 'closed' ? 'green' : s === 'rejected' ? 'red' : s === 'in_transit' ? 'blue' : 'amber');
  return (
    <>
      <PageHeader title="Branch transfers" sub="Move stock between branches. Cost travels with the stock."><button className="btn btn-primary" onClick={() => setAdding(true)}>+ New transfer</button></PageHeader>
      <Table head={['No.', 'From → To', 'Status', 'Created', '']} empty={q.data?.length === 0 && <Empty>No transfers yet.</Empty>}>
        {q.data?.map((t) => (
          <tr key={t.id}><td className="td font-medium">{t.number}</td><td className="td">{name(t.from_branch_id)} → {name(t.to_branch_id)}</td><td className="td"><Badge tone={tone(t.status) as any}>{t.status.replace('_', ' ')}</Badge></td><td className="td">{dateText(t.created_at)}</td>
            <td className="td text-right">
              {t.status === 'requested' && <button className="btn btn-primary" onClick={() => act.mutate({ t, what: 'approve' })}>Approve (sender)</button>}
              {t.status === 'approved' && <button className="btn btn-primary" onClick={() => act.mutate({ t, what: 'dispatch' })}>Dispatch</button>}
              {t.status === 'in_transit' && <><button className="btn btn-primary mr-1" onClick={() => act.mutate({ t, what: 'receive' })}>Receive all</button><button className="btn btn-secondary" onClick={() => act.mutate({ t, what: 'close' })}>Close with shortage</button></>}
            </td></tr>
        ))}
      </Table>
      {adding && <NewTransfer branches={branches.data ?? []} defaultTo={me.session.branchId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['transfers'] }); }} />}
    </>
  );
}

function NewTransfer({ branches, defaultTo, onClose, onSaved }: { branches: any[]; defaultTo?: string; onClose: () => void; onSaved: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(defaultTo ?? '');
  const [rows, setRows] = useState<{ p: Product; qty: string }[]>([]);
  const m = useMutation({ mutationFn: () => post('/transfers', { fromBranchId: from, toBranchId: to, lines: rows.map((r) => ({ productId: r.p.id, qty: r.qty })) }), onSuccess: () => { toast.ok('Transfer requested'); onSaved(); }, onError: fail });
  return (
    <Modal title="New transfer" onClose={onClose}>
      <div className="grid grid-cols-2 gap-2">
        <Field label="From (sends)"><select className="input" value={from} onChange={(e) => setFrom(e.target.value)}><option value="">Choose…</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="To (receives)"><select className="input" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      </div>
      <ProductPicker onPick={(p) => setRows((r) => (r.find((x) => x.p.id === p.id) ? r : [...r, { p, qty: '' }]))} />
      {rows.map((r, i) => <div key={r.p.id} className="mt-2 flex items-center gap-2 text-sm"><span className="flex-1">{r.p.name}</span><input className="input !w-24 text-right" placeholder="qty" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: pickNum(e.target.value) } : x)))} /></div>)}
      <div className="mt-4 flex justify-end gap-2"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!from || !to || from === to || !rows.length || rows.some((r) => !r.qty) || m.isPending} onClick={() => m.mutate()}>Request</button></div>
    </Modal>
  );
}

export { useHas };
