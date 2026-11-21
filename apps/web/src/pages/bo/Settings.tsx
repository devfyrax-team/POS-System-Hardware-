import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../../api';
import { useHas, useMe } from '../../session';
import { toast } from '../../store';
import { Badge, Empty, Field, fail, Loading, PageHeader, Table } from '../../ui';
import { Tabs } from './shared';

export function SettingsPage() {
  const [tab, setTab] = useState('shop');
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'shop', label: 'Shop' }, { key: 'branches', label: 'Branches & tills' }, { key: 'audit', label: 'Activity log' }, { key: 'plan', label: 'Plan & data' }]} />
      {tab === 'shop' && <ShopSettings />}
      {tab === 'branches' && <BranchesTills />}
      {tab === 'audit' && <Audit />}
      {tab === 'plan' && <PlanData />}
    </>
  );
}

function ShopSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get<any>('/shop/settings') });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (q.data) setF({ name: q.data.name, ...q.data.settings, receipt: q.data.settings.receipt ?? {} }); }, [q.data]);
  const save = useMutation({
    mutationFn: () => patch('/shop/settings', { name: f.name, costing_method: f.costing_method, expired_stock_policy: f.expired_stock_policy, below_cost_warning: f.below_cost_warning, cashier_price_override: f.cashier_price_override, receipt: { header: f.receipt.header, footer: f.receipt.footer, language: f.receipt.language } }),
    onSuccess: () => { toast.ok('Settings saved'); qc.invalidateQueries(); }, onError: fail,
  });
  const batches = useHas('batch_expiry');
  if (!f) return <Loading />;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  return (
    <div className="card max-w-2xl p-5">
      <Field label="Shop name"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Costing method" hint="How the cost of each sale is worked out. A change applies to future sales only."><select className="input" value={f.costing_method} onChange={(e) => set('costing_method', e.target.value)}><option value="fifo">FIFO (oldest stock first)</option><option value="average">Weighted average</option></select></Field>
        {batches && <Field label="Expired stock at the till"><select className="input" value={f.expired_stock_policy} onChange={(e) => set('expired_stock_policy', e.target.value)}><option value="block">Block</option><option value="warn">Warn (sell fresh first)</option><option value="allow">Allow</option></select></Field>}
      </div>
      <label className="mb-2 block text-sm"><input type="checkbox" checked={f.below_cost_warning} onChange={(e) => set('below_cost_warning', e.target.checked)} /> Show a quiet warning when an item is sold below cost</label>
      <label className="mb-4 block text-sm"><input type="checkbox" checked={f.cashier_price_override} onChange={(e) => set('cashier_price_override', e.target.checked)} /> Cashiers may change a price on a bill without a supervisor</label>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Receipt header"><input className="input" value={f.receipt.header ?? ''} onChange={(e) => set('receipt', { ...f.receipt, header: e.target.value })} /></Field>
        <Field label="Receipt footer"><input className="input" value={f.receipt.footer ?? ''} onChange={(e) => set('receipt', { ...f.receipt, footer: e.target.value })} /></Field>
        <Field label="Receipt language"><select className="input" value={f.receipt.language ?? 'en'} onChange={(e) => set('receipt', { ...f.receipt, language: e.target.value })}><option value="en">English</option><option value="si">Sinhala</option><option value="ta">Tamil</option></select></Field>
      </div>
      <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
    </div>
  );
}

function BranchesTills() {
  const me = useMe();
  const qc = useQueryClient();
  const multi = useHas('multi_branch');
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get<any[]>('/branches') });
  const terminals = useQuery({ queryKey: ['terminals'], queryFn: () => get<any[]>('/terminals') });
  const [bname, setBname] = useState('');
  const [t, setT] = useState({ name: '', prefix: '', branchId: '' });
  const addB = useMutation({ mutationFn: () => post('/branches', { name: bname }), onSuccess: () => { toast.ok('Branch added'); setBname(''); qc.invalidateQueries(); }, onError: fail });
  const addT = useMutation({ mutationFn: () => post('/terminals', { name: t.name, prefix: t.prefix, branchId: t.branchId || branches.data?.[0]?.id }), onSuccess: () => { toast.ok('Till registered'); setT({ name: '', prefix: '', branchId: '' }); qc.invalidateQueries(); }, onError: fail });
  const offT = useMutation({ mutationFn: (id: string) => del(`/terminals/${id}`), onSuccess: () => { toast.ok('Till deactivated'); qc.invalidateQueries(); }, onError: fail });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div>
        <h3 className="mb-2 font-semibold">Branches</h3>
        <Table head={['Branch', 'Status']}>{branches.data?.map((b) => <tr key={b.id}><td className="td font-medium">{b.name}{b.is_default && <span className="ml-2 text-xs text-slate-400">main</span>}</td><td className="td"><Badge tone={b.status === 'active' ? 'green' : 'slate'}>{b.status}</Badge></td></tr>)}</Table>
        {multi ? (
          <div className="mt-3 flex gap-2"><input className="input" placeholder="New branch name" value={bname} onChange={(e) => setBname(e.target.value)} /><button className="btn btn-primary" disabled={!bname} onClick={() => addB.mutate()}>Add branch</button></div>
        ) : <p className="mt-2 text-xs text-slate-400">Your plan runs a single branch. Ask us to enable multi-branch when you grow.</p>}
        <p className="mt-1 text-xs text-slate-400">Limit: {me.limits.max_branches ?? 'unlimited'} branch(es).</p>
      </div>
      <div>
        <h3 className="mb-2 font-semibold">Tills (terminals)</h3>
        <Table head={['Till', 'Invoice prefix', '']} empty={terminals.data?.length === 0 && <Empty>No tills yet. Add one to start selling.</Empty>}>
          {terminals.data?.map((x) => <tr key={x.id}><td className="td font-medium">{x.name}{x.status !== 'active' && <Badge>off</Badge>}</td><td className="td">{x.prefix}</td><td className="td text-right">{x.status === 'active' && <button className="btn btn-ghost text-red-600" onClick={() => offT.mutate(x.id)}>Deactivate</button>}</td></tr>)}
        </Table>
        <div className="mt-3 grid grid-cols-[1fr_8rem_auto] gap-2">
          <input className="input" placeholder="Till name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
          <input className="input" placeholder="Prefix e.g. MAIN-T1" value={t.prefix} onChange={(e) => setT({ ...t, prefix: e.target.value.toUpperCase() })} />
          <button className="btn btn-primary" disabled={!t.name || !t.prefix} onClick={() => addT.mutate()}>Add</button>
          {multi && <select className="input col-span-3" value={t.branchId} onChange={(e) => setT({ ...t, branchId: e.target.value })}><option value="">Branch: first</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
        </div>
        <p className="mt-1 text-xs text-slate-400">Each till numbers its own invoices (prefix + number). Limit: {me.limits.max_terminals_per_branch ?? 'unlimited'} per branch.</p>
      </div>
    </div>
  );
}

function Audit() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => get<any[]>('/audit-log?limit=100') });
  if (q.isLoading) return <Loading />;
  return (
    <Table head={['When', 'Action', 'Detail']}>
      {q.data?.map((a) => <tr key={a.id}><td className="td whitespace-nowrap">{new Date(a.created_at).toLocaleString()}</td><td className="td font-medium">{a.action}{a.approver_id && <Badge tone="amber">approved</Badge>}</td><td className="td text-xs text-slate-500">{a.new_value ? JSON.stringify(a.new_value).slice(0, 120) : ''}</td></tr>)}
    </Table>
  );
}

function PlanData() {
  const me = useMe();
  const inv = useQuery({ queryKey: ['invoices'], queryFn: () => get<any[]>('/billing/invoices') });
  const exportData = async () => {
    const data = await get('/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `shop-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="max-w-3xl">
      <div className="card mb-4 p-4">
        <div className="mb-2 flex items-center gap-2"><span className="font-semibold">Plan: {me.subscription.plan}</span><Badge tone={me.subscription.status === 'active' ? 'green' : 'amber'}>{me.subscription.status.replace('_', ' ')}</Badge></div>
        <p className="mb-3 text-sm text-slate-500">Your plan decides which features are on. To add a feature or raise a limit, contact the platform team.</p>
        <div className="flex flex-wrap gap-1">{me.features.map((f) => <Badge key={f} tone="blue">{f.replace(/_/g, ' ')}</Badge>)}</div>
      </div>
      <div className="card mb-4 p-4"><h3 className="mb-1 font-semibold">Export your data</h3><p className="mb-3 text-sm text-slate-500">Products, sales, customers, suppliers and stock history in one file. Always available, even if the subscription lapses.</p><button className="btn btn-secondary" onClick={exportData}>Download export (JSON)</button></div>
      <h3 className="mb-2 font-semibold">Subscription invoices</h3>
      <Table head={['Invoice', 'Amount', 'Status', 'Due']} empty={inv.data?.length === 0 && <Empty>No invoices yet.</Empty>}>
        {inv.data?.map((i) => <tr key={i.id}><td className="td font-medium">{i.number}</td><td className="td">{i.amount}</td><td className="td"><Badge tone={i.status === 'paid' ? 'green' : 'amber'}>{i.status}</Badge></td><td className="td">{new Date(i.due_at).toLocaleDateString()}</td></tr>)}
      </Table>
    </div>
  );
}
