import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../../api';
import { money, qtyText } from '../../money';
import { useCan, useMe } from '../../session';
import { toast } from '../../store';
import { Badge, Empty, Field, fail, Loading, Modal, PageHeader, Stat, Table } from '../../ui';
import { dateTimeText, pickNum, Tabs } from './shared';

export function SalesPage() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['sales', q], queryFn: () => get<any[]>(`/sales${qs({ invoiceNo: q || undefined, limit: 100 })}`) });
  const sum = useQuery({ queryKey: ['sales-summary'], queryFn: () => get<any>(`/sales/summary${qs({ from: new Date(new Date().toDateString()).toISOString() })}`) });
  return (
    <>
      <PageHeader title="Sales" sub="Bills, voids and returns" />
      {sum.data && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Bills today" value={sum.data.sales.bills} /><Stat label="Sales today" value={money(sum.data.sales.total)} />
          <Stat label="Returns today" value={money(sum.data.returns.total)} /><Stat label="Voided today" value={sum.data.voided.bills} />
        </div>
      )}
      <input className="input mb-3 max-w-xs" placeholder="Find invoice number" value={q} onChange={(e) => setQ(e.target.value)} />
      {list.isLoading ? <Loading /> : (
        <Table head={['Invoice', 'Time', 'Total', '']} empty={list.data?.length === 0 && <Empty>No sales found.</Empty>}>
          {list.data?.map((s) => (
            <tr key={s.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(s.id)}>
              <td className="td font-medium">{s.invoice_no}</td><td className="td">{dateTimeText(s.created_at)}</td><td className="td">{money(s.total)}</td><td className="td">{s.voided && <Badge tone="red">voided</Badge>}</td>
            </tr>
          ))}
        </Table>
      )}
      {open && <SaleDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function SaleDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const canVoid = useCan('sale.void');
  const canRefund = useCan('sale.refund');
  const s = useQuery({ queryKey: ['sale', id], queryFn: () => get<any>(`/sales/${id}`) });
  const r = useQuery({ queryKey: ['receipt-text', id], queryFn: () => get<any>(`/sales/${id}/receipt`) });
  const [mode, setMode] = useState<'view' | 'void' | 'return'>('view');
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [method, setMethod] = useState('cash');
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  const reload = () => { qc.invalidateQueries({ queryKey: ['sale', id] }); qc.invalidateQueries({ queryKey: ['sales'] }); qc.invalidateQueries({ queryKey: ['sales-summary'] }); };
  const voidM = useMutation({ mutationFn: () => post(`/sales/${id}/void`, { reason }), onSuccess: () => { toast.ok('Sale voided and stock restored'); setMode('view'); reload(); }, onError: fail });
  const retM = useMutation({
    mutationFn: () => post('/returns', { saleId: id, reason, refundMethod: method, lines: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([saleLineId, v]) => ({ saleLineId, qty: v, disposition: damaged[saleLineId] ? 'damaged' : 'sellable' })) }),
    onSuccess: (x: any) => { toast.ok(`Return ${x.number}: refund ${money(x.total)}`); setMode('view'); setQty({}); reload(); }, onError: fail,
  });
  if (!s.data) return <Modal title="Sale" onClose={onClose}><Loading /></Modal>;
  const d = s.data;
  void me;
  return (
    <Modal title={`${d.invoice_no}${d.voided ? ' · VOIDED' : ''}`} onClose={onClose} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Table head={['Item', 'Qty', 'Price', 'Total', mode === 'return' ? 'Return' : '']}>
            {d.lines.map((l: any) => (
              <tr key={l.id}><td className="td">{l.name}</td><td className="td">{qtyText(l.qty_unit)} {l.unit}{Number(l.returned_qty) > 0 && <div className="text-xs text-amber-600">{qtyText(l.returned_qty)} returned</div>}</td><td className="td">{money(l.price_charged)}</td><td className="td">{money(l.line_total)}</td>
                <td className="td">{mode === 'return' && <><input className="input !w-16 text-right" placeholder="0" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: pickNum(e.target.value) })} /><label className="block text-xs"><input type="checkbox" checked={!!damaged[l.id]} onChange={(e) => setDamaged({ ...damaged, [l.id]: e.target.checked })} /> damaged</label></>}</td></tr>
            ))}
          </Table>
          <div className="mt-2 text-right text-lg font-semibold">Total {money(d.total)}</div>
          <div className="mt-1 text-xs text-slate-400">{d.payments.map((p: any) => `${p.kind !== 'sale' ? p.kind + ' ' : ''}${p.method} ${money(p.amount)}`).join(' · ')}</div>
        </div>
        <pre className="max-h-80 overflow-auto rounded-md border border-dashed border-slate-300 bg-white p-2 text-[11px] leading-4" style={{ fontFamily: "'Courier New', monospace" }}>{r.data?.text}</pre>
      </div>
      {mode !== 'view' && (
        <div className="mt-4 rounded-md bg-slate-50 p-3">
          <Field label="Reason (required)"><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {mode === 'return' && <Field label="Refund by"><select className="input max-w-xs" value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option>{d.customer_id && <option value="account_credit">Customer account</option>}</select></Field>}
          <div className="flex gap-2"><button className="btn btn-secondary" onClick={() => setMode('view')}>Cancel</button>
            {mode === 'void' ? <button className="btn btn-danger" disabled={!reason || voidM.isPending} onClick={() => voidM.mutate()}>Void this sale</button> : <button className="btn btn-primary" disabled={!reason || !Object.values(qty).some((v) => Number(v) > 0) || retM.isPending} onClick={() => retM.mutate()}>Refund</button>}</div>
        </div>
      )}
      {mode === 'view' && !d.voided && (
        <div className="mt-4 flex gap-2">
          <button className="btn btn-secondary" onClick={() => window.print()}>Print</button>
          {canRefund && <button className="btn btn-secondary" onClick={() => setMode('return')}>Return items</button>}
          {canVoid && <button className="btn btn-danger" onClick={() => setMode('void')}>Void</button>}
          {!canVoid && !canRefund && <span className="self-center text-xs text-slate-400">Voids and refunds need a manager.</span>}
        </div>
      )}
    </Modal>
  );
}

// ---------------- profit (owner / manager) ----------------
function range(kind: string) {
  const now = new Date();
  const start = new Date(now.toDateString());
  if (kind === '7') start.setDate(start.getDate() - 6);
  if (kind === '30') start.setDate(start.getDate() - 29);
  if (kind === 'month') start.setDate(1);
  return { from: start.toISOString() };
}

export function ReportsPage() {
  const canCost = useCan('cost.view');
  const [kind, setKind] = useState('0');
  const [by, setBy] = useState('item');
  const p = range(kind);
  const profit = useQuery({ queryKey: ['profit', kind], queryFn: () => get<any>(`/reports/profit${qs(p)}`) });
  const rows = useQuery({ queryKey: ['profit-by', by, kind], queryFn: () => get<any[]>(`/reports/profit/by/${by}${qs(p)}`) });
  const flags = useQuery({ queryKey: ['flags', kind], queryFn: () => get<any>(`/reports/cost-flags${qs(p)}`), enabled: canCost });
  const d = profit.data;
  return (
    <>
      <PageHeader title="Profit" sub="Estimated gross profit = sales − returns − cost of the goods sold. Cost was stored on each sale when it happened.">
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="0">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="month">This month</option></select>
      </PageHeader>
      {d && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Sales" value={money(d.sales)} /><Stat label="Returns" value={money(d.returns)} /><Stat label="Cost of goods" value={money(d.cogs)} /><Stat label="Gross profit" value={money(d.estimatedGrossProfit)} /><Stat label="Margin" value={d.marginPct ? `${d.marginPct}%` : '—'} />
        </div>
      )}
      <Tabs value={by} onChange={setBy} tabs={[{ key: 'item', label: 'By item' }, { key: 'category', label: 'By category' }, { key: 'cashier', label: 'By cashier' }, { key: 'branch', label: 'By branch' }]} />
      <Table head={['', 'Qty', 'Revenue', 'Cost', 'Profit']} empty={rows.data?.length === 0 && <Empty>No sales in this period.</Empty>}>
        {rows.data?.map((r) => <tr key={r.key}><td className="td font-medium">{r.label}</td><td className="td">{qtyText(r.qty)}</td><td className="td">{money(r.revenue)}</td><td className="td">{money(r.cogs)}</td><td className={`td font-medium ${Number(r.profit) < 0 ? 'text-red-600' : ''}`}>{money(r.profit)}</td></tr>)}
      </Table>
      {flags.data && (
        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          <div><h3 className="mb-2 font-semibold">Sold below cost</h3><div className="card divide-y divide-slate-100 text-sm">{flags.data.soldBelowCost.length === 0 ? <Empty>None</Empty> : flags.data.soldBelowCost.map((x: any) => <div key={x.id} className="flex justify-between p-2"><span>{x.name}</span><Badge tone="red">{x.lines}×</Badge></div>)}</div></div>
          <div><h3 className="mb-2 font-semibold">No purchase cost known</h3><div className="card divide-y divide-slate-100 text-sm">{flags.data.missingCost.length === 0 ? <Empty>None</Empty> : flags.data.missingCost.slice(0, 12).map((x: any) => <div key={x.id} className="p-2">{x.name}</div>)}</div><p className="mt-1 text-xs text-slate-400">Profit on these items is unreliable.</p></div>
          <div><h3 className="mb-2 font-semibold">Thinnest margins (latest cost)</h3><div className="card divide-y divide-slate-100 text-sm">{flags.data.replacementMargin.slice(0, 10).map((x: any) => <div key={x.id} className="flex justify-between p-2"><span>{x.name}</span><Badge tone={Number(x.marginPct) < 5 ? 'red' : 'slate'}>{x.marginPct}%</Badge></div>)}</div></div>
        </div>
      )}
    </>
  );
}
