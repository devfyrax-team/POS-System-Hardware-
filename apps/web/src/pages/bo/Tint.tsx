import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../../api';
import { money, qtyText } from '../../money';
import { toast } from '../../store';
import { Badge, Empty, Field, fail, PageHeader, Table } from '../../ui';
import { pickNum, Product, ProductPicker, Tabs } from './shared';

export function TintPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('mix');
  const [base, setBase] = useState<Product | null>(null);
  const [qty, setQty] = useState('4');
  const [code, setCode] = useState('');
  const [colourName, setColourName] = useState('');
  const [rows, setRows] = useState<{ p: Product; ml: string }[]>([]);
  const [cust, setCust] = useState<any>(null);
  const [custQ, setCustQ] = useState('');
  const custs = useQuery({ queryKey: ['tint-cust', custQ], queryFn: () => get<any[]>(`/customers/search${qs({ q: custQ })}`), enabled: custQ.length > 1 });
  const jobs = useQuery({ queryKey: ['tint-jobs'], queryFn: () => get<any[]>('/tint/jobs') });
  const formulas = useQuery({ queryKey: ['formulas', cust?.id], queryFn: () => get<any[]>(`/tint/formulas/${cust.id}`), enabled: !!cust });
  const [reQty, setReQty] = useState('4');
  const mix = useMutation({
    mutationFn: () => post<any>('/tint/mix', { baseProductId: base!.id, baseQty: qty, colourCode: code, colourName: colourName || undefined, customerId: cust?.id, colorants: rows.map((r) => ({ productId: r.p.id, ml: r.ml })) }),
    onSuccess: (r) => { toast.ok(`Mixed ${qtyText(r.qty)} of ${r.name}`); setRows([]); setCode(''); setColourName(''); qc.invalidateQueries(); },
    onError: fail,
  });
  const reorder = useMutation({
    mutationFn: (colourCode: string) => post<any>('/tint/reorder', { customerId: cust.id, colourCode, baseQty: reQty }),
    onSuccess: (r) => { toast.ok(`Mixed ${qtyText(r.qty)} of ${r.name}`); qc.invalidateQueries(); },
    onError: fail,
  });
  return (
    <>
      <PageHeader title="Colour tinting" sub="Mixing uses base paint and colorant from stock and makes a tinted tin to sell. Tinted paint cannot be returned." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'mix', label: 'New mix' }, { key: 'reorder', label: 'Reorder for a customer' }, { key: 'jobs', label: 'Recent mixes' }]} />
      {tab === 'mix' && (
        <div className="card max-w-3xl p-4">
          <div className="grid grid-cols-2 gap-4">
            <div><span className="label">Base paint</span>{base ? <div className="flex items-center justify-between rounded-md bg-slate-50 p-2 text-sm"><b>{base.name}</b><button className="btn btn-ghost" onClick={() => setBase(null)}>change</button></div> : <ProductPicker onPick={setBase} placeholder="Search the base paint" />}</div>
            <Field label={`Quantity (${base?.base_unit ?? 'L'})`}><input className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(pickNum(e.target.value))} /></Field>
            <Field label="Colour code"><input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. AB-12" /></Field>
            <Field label="Colour name (optional)"><input className="input" value={colourName} onChange={(e) => setColourName(e.target.value)} /></Field>
          </div>
          <span className="label">Colorants (total ml for the whole mix)</span>
          <ProductPicker onPick={(p) => setRows((r) => (r.find((x) => x.p.id === p.id) ? r : [...r, { p, ml: '' }]))} placeholder="Add a colorant" />
          {rows.map((r, i) => <div key={r.p.id} className="mt-2 flex items-center gap-2 text-sm"><span className="flex-1">{r.p.name}</span><input className="input !w-24 text-right" placeholder="ml" value={r.ml} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, ml: pickNum(e.target.value) } : x)))} /><span>ml</span><button className="btn btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button></div>)}
          <div className="mt-4"><span className="label">Customer (to save the formula for reorders)</span>
            {cust ? <div className="flex items-center justify-between rounded-md bg-slate-50 p-2 text-sm"><b>{cust.name}</b><button className="btn btn-ghost" onClick={() => setCust(null)}>remove</button></div> : <>
              <input className="input" placeholder="Search customer by name or phone" value={custQ} onChange={(e) => setCustQ(e.target.value)} />
              {custs.data?.map((c) => <button key={c.id} className="mt-1 block w-full rounded-md border border-slate-200 p-2 text-left text-sm hover:bg-brand-50" onClick={() => { setCust(c); setCustQ(''); }}>{c.name}</button>)}</>}
          </div>
          <button className="btn btn-primary mt-4" disabled={!base || !code || !qty || !rows.length || rows.some((r) => !r.ml) || mix.isPending} onClick={() => mix.mutate()}>Mix and add to stock</button>
        </div>
      )}
      {tab === 'reorder' && (
        <div className="card max-w-3xl p-4">
          {!cust ? (
            <>
              <input className="input" placeholder="Search customer" value={custQ} onChange={(e) => setCustQ(e.target.value)} />
              {custs.data?.map((c) => <button key={c.id} className="mt-1 block w-full rounded-md border border-slate-200 p-2 text-left text-sm hover:bg-brand-50" onClick={() => { setCust(c); setCustQ(''); }}>{c.name}</button>)}
            </>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between"><b>{cust.name}</b><button className="btn btn-ghost" onClick={() => setCust(null)}>change</button></div>
              <Field label="Quantity to mix"><input className="input !w-32" value={reQty} onChange={(e) => setReQty(pickNum(e.target.value))} /></Field>
              {formulas.data?.length === 0 && <Empty>No saved formulas for this customer yet.</Empty>}
              {formulas.data?.map((f) => (
                <div key={f.id} className="mb-2 flex items-center justify-between rounded-md border border-slate-200 p-3 text-sm">
                  <div><div className="font-medium">{f.colour_code} {f.colour_name && `· ${f.colour_name}`}</div><div className="text-xs text-slate-400">{f.base_name}</div></div>
                  <button className="btn btn-primary" disabled={reorder.isPending || !reQty} onClick={() => reorder.mutate(f.colour_code)}>Mix {reQty} L</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {tab === 'jobs' && (
        <Table head={['When', 'Tinted item', 'Quantity']} empty={jobs.data?.length === 0 && <Empty>No mixes yet.</Empty>}>
          {jobs.data?.map((j) => <tr key={j.id}><td className="td">{new Date(j.created_at).toLocaleString()}</td><td className="td font-medium">{j.tinted_name} <Badge>{j.colour_code}</Badge></td><td className="td">{qtyText(j.base_qty)}</td></tr>)}
        </Table>
      )}
      <span className="hidden">{money('0')}</span>
    </>
  );
}
