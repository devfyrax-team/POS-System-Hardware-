import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../../api';
import { money, qtyText } from '../../money';
import { useCan, useHas } from '../../session';
import { toast } from '../../store';
import { Badge, Empty, Field, fail, Loading, Modal, PageHeader, Table } from '../../ui';
import { dateTimeText, pickNum, Product, ProductPicker, Tabs } from './shared';

export function Purchasing() {
  const canManage = useCan('purchase.manage');
  const [tab, setTab] = useState('receive');
  return (
    <>
      <PageHeader title="Purchasing" sub="Receive goods, track what you owe suppliers" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'receive', label: 'Receive goods' }, { key: 'history', label: 'Receipts' }, ...(canManage ? [{ key: 'suppliers', label: 'Suppliers' }] : [])]} />
      {tab === 'receive' && <Receive />}
      {tab === 'history' && <History />}
      {tab === 'suppliers' && <Suppliers />}
    </>
  );
}

interface Row { p: Product; qty: string; cost: string; batchNo: string; expiry: string; mfg: string }

function Receive() {
  const qc = useQueryClient();
  const hasBatches = useHas('batch_expiry');
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => get<any[]>('/suppliers') });
  const [supplierId, setSupplier] = useState('');
  const [invoice, setInvoice] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [landed, setLanded] = useState('');
  const [result, setResult] = useState<any>(null);
  const m = useMutation({
    mutationFn: () => post('/purchases', {
      supplierId, supplierInvoiceNo: invoice || undefined,
      landedCosts: landed ? [{ label: 'transport', amount: landed }] : undefined,
      lines: rows.map((r) => ({ productId: r.p.id, qty: r.qty, unitCost: r.cost, batchNo: r.batchNo || undefined, expiryDate: r.expiry || undefined, mfgDate: r.mfg || undefined })),
    }),
    onSuccess: (r) => { setResult(r); setRows([]); setLanded(''); setInvoice(''); qc.invalidateQueries(); toast.ok(`Goods received: ${r.number}`); },
    onError: fail,
  });
  const upd = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      <div className="card p-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Supplier"><select className="input" value={supplierId} onChange={(e) => setSupplier(e.target.value)}><option value="">Choose…</option>{suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Supplier invoice no."><input className="input" value={invoice} onChange={(e) => setInvoice(e.target.value)} /></Field>
        </div>
        <ProductPicker onPick={(p) => setRows((r) => [...r, { p, qty: '', cost: '', batchNo: '', expiry: '', mfg: '' }])} placeholder="Add an item you received" />
        <div className="mt-3">
          {rows.map((r, i) => (
            <div key={i} className="mb-2 rounded-md border border-slate-200 p-2">
              <div className="grid grid-cols-[1fr_6rem_7rem_2rem] items-center gap-2 text-sm">
                <span className="font-medium">{r.p.name}<span className="ml-2 text-xs text-slate-400">last cost per {r.p.base_unit}</span></span>
                <input className="input text-right" placeholder="qty" inputMode="decimal" value={r.qty} onChange={(e) => upd(i, { qty: pickNum(e.target.value) })} />
                <input className="input text-right" placeholder="unit cost" inputMode="decimal" value={r.cost} onChange={(e) => upd(i, { cost: pickNum(e.target.value) })} />
                <button className="btn btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
              </div>
              {hasBatches && r.p.track_batches && (
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  <input className="input" placeholder="Batch no." value={r.batchNo} onChange={(e) => upd(i, { batchNo: e.target.value })} />
                  <label className="text-xs text-slate-500">Mfg date<input type="date" className="input" value={r.mfg} onChange={(e) => upd(i, { mfg: e.target.value })} /></label>
                  <label className="text-xs text-slate-500">Expiry date<input type="date" className="input" value={r.expiry} onChange={(e) => upd(i, { expiry: e.target.value })} /></label>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-end justify-between">
          <Field label="Transport / landed cost (spread over the items)"><input className="input !w-40" inputMode="decimal" value={landed} onChange={(e) => setLanded(pickNum(e.target.value))} /></Field>
          <button className="btn btn-primary mb-3" disabled={!supplierId || !rows.length || rows.some((r) => !r.qty || !r.cost) || m.isPending} onClick={() => m.mutate()}>Receive goods</button>
        </div>
      </div>
      {result && (
        <div className="card mt-4 p-4">
          <h3 className="mb-2 font-semibold">Received {result.number} · total {money(result.total)}</h3>
          {result.costChangeNotices.length > 0 ? (
            <>
              <p className="mb-2 text-sm text-slate-500">Cost changed on these items. Your selling price was <b>not</b> changed; reprice in Products if you wish.</p>
              <Table head={['Item', 'Was', 'Now', 'Change']}>
                {result.costChangeNotices.map((n: any) => <tr key={n.productId}><td className="td">{n.name}</td><td className="td">{n.previousCost ? money(n.previousCost) : '—'}</td><td className="td">{money(n.newCost)}</td><td className="td">{n.changePct ? <Badge tone={Number(n.changePct) > 0 ? 'red' : 'green'}>{n.changePct}%</Badge> : 'new'}</td></tr>)}
              </Table>
            </>
          ) : <p className="text-sm text-slate-500">No cost changes.</p>}
        </div>
      )}
    </>
  );
}

function History() {
  const q = useQuery({ queryKey: ['purchases'], queryFn: () => get<any[]>('/purchases') });
  const [open, setOpen] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  if (q.isLoading) return <Loading />;
  return (
    <>
      <Table head={['Receipt', 'Supplier invoice', 'Total', 'Date']} empty={q.data?.length === 0 && <Empty>Nothing received yet.</Empty>}>
        {q.data?.map((p) => (
          <tr key={p.id} className="cursor-pointer hover:bg-slate-50" onClick={async () => { setOpen(p); setDetail(await get(`/purchases/${p.id}`)); }}>
            <td className="td font-medium">{p.number}</td><td className="td">{p.supplier_invoice_no}</td><td className="td">{money(p.total)}</td><td className="td">{dateTimeText(p.created_at)}</td>
          </tr>
        ))}
      </Table>
      {open && (
        <Modal title={open.number} onClose={() => { setOpen(null); setDetail(null); }} wide>
          {!detail ? <Loading /> : (
            <Table head={['Item', 'Qty', 'Unit cost', 'Line cost', 'Landed', 'Cost / base unit']}>
              {detail.lines.map((l: any) => <tr key={l.id}><td className="td">{l.name}</td><td className="td">{qtyText(l.qty_unit)} {l.unit}</td><td className="td">{money(l.unit_cost)}</td><td className="td">{money(l.line_cost)}</td><td className="td">{money(l.landed_alloc)}</td><td className="td">{money(l.unit_cost_base)}</td></tr>)}
            </Table>
          )}
        </Modal>
      )}
    </>
  );
}

function Suppliers() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['suppliers'], queryFn: () => get<any[]>('/suppliers') });
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<any>(null);
  const [name, setName] = useState('');
  const [terms, setTerms] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const add = useMutation({ mutationFn: () => post('/suppliers', { name, returnTerms: terms || undefined }), onSuccess: () => { toast.ok('Supplier added'); setAdding(false); setName(''); setTerms(''); qc.invalidateQueries({ queryKey: ['suppliers'] }); }, onError: fail });
  const pay = useMutation({ mutationFn: () => post(`/suppliers/${paying.id}/payments`, { amount, method, cheque: method === 'cheque' ? { chequeNo: 'CHQ', chequeDate: new Date().toISOString().slice(0, 10) } : undefined }), onSuccess: () => { toast.ok('Payment recorded'); setPaying(null); setAmount(''); qc.invalidateQueries({ queryKey: ['suppliers'] }); }, onError: fail });
  return (
    <>
      <div className="mb-3 flex justify-end"><button className="btn btn-primary" onClick={() => setAdding(true)}>+ New supplier</button></div>
      <Table head={['Supplier', 'Terms', 'We owe', '']} empty={q.data?.length === 0 && <Empty>No suppliers yet.</Empty>}>
        {q.data?.map((s) => (
          <tr key={s.id}><td className="td font-medium">{s.name}{s.return_terms && <div className="text-xs font-normal text-slate-400">Returns: {s.return_terms}</div>}</td><td className="td">{s.payment_terms_days} days</td>
            <td className={`td font-medium ${Number(s.balance) > 0 ? 'text-red-600' : ''}`}>{money(s.balance)}</td>
            <td className="td text-right">{Number(s.balance) > 0 && <button className="btn btn-secondary" onClick={() => setPaying(s)}>Pay</button>}</td></tr>
        ))}
      </Table>
      {adding && <Modal title="New supplier" onClose={() => setAdding(false)}><Field label="Name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Return terms" hint="Important for stock that is near expiry"><input className="input" value={terms} onChange={(e) => setTerms(e.target.value)} /></Field><button className="btn btn-primary" disabled={!name} onClick={() => add.mutate()}>Save</button></Modal>}
      {paying && <Modal title={`Pay ${paying.name}`} onClose={() => setPaying(null)}><p className="mb-3 text-sm">We owe <b>{money(paying.balance)}</b>. Partial payments are fine.</p><Field label="Amount"><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(pickNum(e.target.value))} /></Field><Field label="Method"><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option><option value="cheque">Cheque</option></select></Field><button className="btn btn-primary" disabled={!amount || pay.isPending} onClick={() => pay.mutate()}>Record payment</button></Modal>}
    </>
  );
}
