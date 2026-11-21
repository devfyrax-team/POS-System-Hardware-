import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { del, get, patch, post, put } from '../api';
import { money } from '../money';
import { toast } from '../store';
import { Badge, Empty, Field, fail, Loading, Modal, PageHeader, Stat, Table } from '../ui';
import { pickNum, Tabs } from './bo/shared';

export function AdminShell() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const links = [['/admin/shops', 'Shops'], ['/admin/plans', 'Plans'], ['/admin/billing', 'Billing'], ['/admin/analytics', 'Analytics'], ['/admin/health', 'System health']];
  return (
    <div className="flex h-full">
      <aside className="flex w-48 shrink-0 flex-col bg-slate-900 text-slate-200">
        <div className="p-4 text-lg font-semibold text-white">Platform admin</div>
        <nav className="flex-1 px-2">{links.map(([to, l]) => <NavLink key={to} to={to} className={({ isActive }) => `mb-1 block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-brand-700 text-white' : 'hover:bg-slate-700'}`}>{l}</NavLink>)}</nav>
        <button className="m-3 btn btn-ghost justify-start text-slate-300 hover:bg-slate-700" onClick={async () => { await post('/auth/logout').catch(() => undefined); qc.clear(); nav('/admin/login'); }}>Sign out</button>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-6">
        <Routes>
          <Route path="shops" element={<Shops />} />
          <Route path="plans" element={<Plans />} />
          <Route path="billing" element={<Billing />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="health" element={<Health />} />
          <Route path="*" element={<Navigate to="/admin/shops" replace />} />
        </Routes>
      </main>
    </div>
  );
}

const subTone = (s: string) => (s === 'active' ? 'green' : s === 'trial' ? 'blue' : s === 'past_due' ? 'amber' : 'red');

function Shops() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-shops'], queryFn: () => get<any[]>('/admin/shops') });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [created, setCreated] = useState<any>(null);
  return (
    <>
      <PageHeader title="Shops" sub="Every shop on the platform, and what each one is allowed to use"><button className="btn btn-primary" onClick={() => setAdding(true)}>+ New shop</button></PageHeader>
      {q.isLoading ? <Loading /> : (
        <Table head={['Shop', 'Type', 'Plan', 'Subscription', 'Status', 'Created']} empty={q.data?.length === 0 && <Empty>No shops yet.</Empty>}>
          {q.data?.map((s) => (
            <tr key={s.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(s.id)}>
              <td className="td font-medium">{s.name}</td><td className="td capitalize">{s.shop_type}</td><td className="td">{s.plan}</td>
              <td className="td"><Badge tone={subTone(s.subscription_status) as any}>{String(s.subscription_status).replace('_', ' ')}</Badge></td>
              <td className="td"><Badge tone={s.status === 'active' ? 'green' : 'red'}>{s.status}</Badge></td><td className="td">{new Date(s.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </Table>
      )}
      {adding && <NewShop onClose={() => setAdding(false)} onDone={(r) => { setAdding(false); setCreated(r); qc.invalidateQueries({ queryKey: ['admin-shops'] }); }} />}
      {created && <Modal title="Shop created" onClose={() => setCreated(null)}><p className="mb-2 text-sm">The owner signs in with the email below. This temporary password is shown only once.</p><div className="rounded-md bg-slate-100 p-3 text-center font-mono text-lg">{created.tempPassword ?? '(password set)'}</div></Modal>}
      {open && <ShopDetail id={open} onClose={() => { setOpen(null); qc.invalidateQueries({ queryKey: ['admin-shops'] }); }} />}
    </>
  );
}

function NewShop({ onClose, onDone }: { onClose: () => void; onDone: (r: any) => void }) {
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => get<any[]>('/admin/plans') });
  const [f, setF] = useState({ name: '', shopType: 'hardware', planCode: 'basic', ownerName: '', ownerEmail: '', trial: true });
  const m = useMutation({ mutationFn: () => post('/admin/shops', f), onSuccess: onDone, onError: fail });
  return (
    <Modal title="New shop" onClose={onClose}>
      <Field label="Shop name"><input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Type" hint="Decides the default features (e.g. tinting for paint)"><select className="input" value={f.shopType} onChange={(e) => setF({ ...f, shopType: e.target.value })}><option value="hardware">Hardware</option><option value="paint">Paint</option><option value="both">Both</option></select></Field>
        <Field label="Plan"><select className="input" value={f.planCode} onChange={(e) => setF({ ...f, planCode: e.target.value })}>{plans.data?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></Field>
      </div>
      <Field label="Owner name"><input className="input" value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></Field>
      <Field label="Owner email"><input className="input" type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
      <label className="mb-3 block text-sm"><input type="checkbox" checked={f.trial} onChange={(e) => setF({ ...f, trial: e.target.checked })} /> Start with a free trial</label>
      <button className="btn btn-primary" disabled={!f.name || !f.ownerName || !f.ownerEmail || m.isPending} onClick={() => m.mutate()}>Create shop</button>
    </Modal>
  );
}

function ShopDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState('features');
  const q = useQuery({ queryKey: ['admin-shop', id], queryFn: () => get<any>(`/admin/shops/${id}`) });
  const cat = useQuery({ queryKey: ['admin-catalog'], queryFn: () => get<any>('/admin/catalog') });
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => get<any[]>('/admin/plans') });
  const reload = () => { qc.invalidateQueries({ queryKey: ['admin-shop', id] }); qc.invalidateQueries({ queryKey: ['admin-shops'] }); };
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [limitVal, setLimitVal] = useState<Record<string, string>>({});
  const setFeature = useMutation({ mutationFn: (v: { key: string; enabled: boolean }) => put(`/admin/shops/${id}/features`, { key: v.key, enabled: v.enabled, expiresAt: expiry[v.key] ? new Date(expiry[v.key]).toISOString() : null }), onSuccess: () => { toast.ok('Saved'); reload(); }, onError: fail });
  const clearFeature = useMutation({ mutationFn: (key: string) => del(`/admin/shops/${id}/features/${key}`), onSuccess: () => { toast.ok('Back to the plan default'); reload(); }, onError: fail });
  const setLimit = useMutation({ mutationFn: (key: string) => put(`/admin/shops/${id}/limits`, { key, value: Number(limitVal[key]) }), onSuccess: () => { toast.ok('Limit saved'); reload(); }, onError: fail });
  const changePlan = useMutation({ mutationFn: (planCode: string) => put(`/admin/shops/${id}/plan`, { planCode }), onSuccess: () => { toast.ok('Plan changed'); reload(); }, onError: fail });
  const status = useMutation({ mutationFn: (s: string) => patch(`/admin/shops/${id}/status`, { status: s }), onSuccess: () => { toast.ok('Updated'); reload(); }, onError: fail });
  const subStatus = useMutation({ mutationFn: (s: string) => put(`/admin/shops/${id}/subscription-status`, { status: s }), onSuccess: () => { toast.ok('Updated'); reload(); }, onError: fail });
  const invoice = useMutation({ mutationFn: () => post(`/admin/shops/${id}/invoices`, {}), onSuccess: () => { toast.ok('Invoice created'); qc.invalidateQueries({ queryKey: ['admin-invoices'] }); }, onError: fail });
  if (!q.data || !cat.data) return <Modal title="Shop" onClose={onClose}><Loading /></Modal>;
  const d = q.data;
  const planFeatures: string[] = plans.data?.find((p) => p.code === d.plan)?.features ?? [];
  const overrides: Record<string, any> = Object.fromEntries(d.overrides.map((o: any) => [o.feature_key, o]));
  const limitOv: Record<string, any> = Object.fromEntries(d.limitOverrides.map((o: any) => [o.limit_key, o]));
  return (
    <Modal title={d.shop.name} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="blue">{d.shop.shop_type}</Badge>
        <select className="input !w-auto" value={d.plan} onChange={(e) => changePlan.mutate(e.target.value)}>{plans.data?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
        <select className="input !w-auto" value={d.subscription} onChange={(e) => subStatus.mutate(e.target.value)}>{['trial', 'active', 'past_due', 'restricted', 'cancelled'].map((s) => <option key={s}>{s}</option>)}</select>
        <Badge tone={d.shop.status === 'active' ? 'green' : 'red'}>{d.shop.status}</Badge>
        <button className="btn btn-secondary" onClick={() => status.mutate(d.shop.status === 'active' ? 'suspended' : 'active')}>{d.shop.status === 'active' ? 'Suspend' : 'Reactivate'}</button>
        <button className="btn btn-secondary" onClick={() => invoice.mutate()}>Create invoice</button>
        <span className="ml-auto text-xs text-slate-400">{d.usage.users} users · {d.usage.branches} branches · {d.usage.terminals} tills</span>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'features', label: 'Features' }, { key: 'limits', label: 'Limits' }]} />
      {tab === 'features' && (
        <Table head={['Feature', 'From plan', 'Override', 'Effective', '']}>
          {cat.data.features.map((f: string) => {
            const ov = overrides[f];
            const eff = d.features.includes(f);
            return (
              <tr key={f}>
                <td className="td font-medium">{f.replace(/_/g, ' ')}</td>
                <td className="td">{planFeatures.includes(f) ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}</td>
                <td className="td text-xs">{ov ? <>{ov.enabled ? <Badge tone="green">forced on</Badge> : <Badge tone="red">forced off</Badge>}{ov.expires_at && <span className="ml-1 text-slate-400">until {new Date(ov.expires_at).toLocaleDateString()}</span>}</> : '—'}</td>
                <td className="td">{eff ? <Badge tone="green">enabled</Badge> : <Badge tone="red">disabled</Badge>}</td>
                <td className="td whitespace-nowrap text-right">
                  <input type="date" className="input !w-36 !py-1 text-xs" title="Optional expiry" value={expiry[f] ?? ''} onChange={(e) => setExpiry({ ...expiry, [f]: e.target.value })} />
                  <button className="btn btn-secondary ml-1 !px-2 text-xs" onClick={() => setFeature.mutate({ key: f, enabled: true })}>Grant</button>
                  <button className="btn btn-secondary ml-1 !px-2 text-xs" onClick={() => setFeature.mutate({ key: f, enabled: false })}>Block</button>
                  {ov && <button className="btn btn-ghost ml-1 !px-2 text-xs" onClick={() => clearFeature.mutate(f)}>Reset</button>}
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      {tab === 'limits' && (
        <Table head={['Limit', 'Effective', 'Override', '']}>
          {cat.data.limits.map((l: string) => (
            <tr key={l}><td className="td font-medium">{l.replace(/_/g, ' ')}</td><td className="td">{d.limits[l] ?? 'unlimited'}</td><td className="td text-xs">{limitOv[l] ? `${limitOv[l].value}${limitOv[l].expires_at ? ` until ${new Date(limitOv[l].expires_at).toLocaleDateString()}` : ''}` : '—'}</td>
              <td className="td text-right"><input className="input !w-24 !py-1 text-right" placeholder="new" inputMode="numeric" value={limitVal[l] ?? ''} onChange={(e) => setLimitVal({ ...limitVal, [l]: pickNum(e.target.value) })} /><button className="btn btn-secondary ml-1 !px-2 text-xs" disabled={!limitVal[l]} onClick={() => setLimit.mutate(l)}>Set</button></td></tr>
          ))}
        </Table>
      )}
      <p className="mt-3 text-xs text-slate-400">Only you can change what a shop may use. Features a shop type does not allow (for example tinting for hardware-only shops) stay off even when granted.</p>
    </Modal>
  );
}

function Plans() {
  const q = useQuery({ queryKey: ['admin-plans'], queryFn: () => get<any[]>('/admin/plans') });
  return (
    <>
      <PageHeader title="Plans" sub="The default package each shop starts from" />
      <div className="grid gap-4 lg:grid-cols-3">
        {q.data?.map((p) => (
          <div key={p.id} className="card p-4">
            <div className="flex items-baseline justify-between"><h3 className="text-lg font-semibold">{p.name}</h3><span className="text-sm text-slate-500">{money(p.price_monthly)} / month</span></div>
            <div className="my-3 flex flex-wrap gap-1">{p.features.length ? p.features.map((f: string) => <Badge key={f} tone="blue">{f.replace(/_/g, ' ')}</Badge>) : <span className="text-sm text-slate-400">basic features only</span>}</div>
            <div className="text-xs text-slate-500">{Object.keys(p.limits).length ? Object.entries(p.limits).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') : 'No limits'}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function Billing() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-invoices'], queryFn: () => get<any[]>('/admin/invoices') });
  const [pay, setPay] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const m = useMutation({ mutationFn: () => post(`/admin/invoices/${pay.id}/payments`, { amount, method }), onSuccess: () => { toast.ok('Payment recorded'); setPay(null); qc.invalidateQueries(); }, onError: fail });
  const run = useMutation({ mutationFn: () => post<any>('/admin/subscriptions/run-lifecycle'), onSuccess: (r) => toast.ok(`Past due: ${r.toPastDue}, restricted: ${r.toRestricted}, cancelled: ${r.toCancelled}`), onError: fail });
  return (
    <>
      <PageHeader title="Billing" sub="Platform invoices, kept completely separate from each shop's own sales"><button className="btn btn-secondary" onClick={() => run.mutate()}>Run subscription check now</button></PageHeader>
      <Table head={['Invoice', 'Shop', 'Amount', 'Paid', 'Status', '']} empty={q.data?.length === 0 && <Empty>No invoices. Create one from a shop.</Empty>}>
        {q.data?.map((i) => <tr key={i.id}><td className="td font-medium">{i.number}</td><td className="td">{i.shop}</td><td className="td">{money(i.amount)}</td><td className="td">{money(i.paid)}</td><td className="td"><Badge tone={i.status === 'paid' ? 'green' : 'amber'}>{i.status}</Badge></td><td className="td text-right">{i.status === 'open' && <button className="btn btn-primary" onClick={() => { setPay(i); setAmount(String(Number(i.amount) - Number(i.paid))); }}>Record payment</button>}</td></tr>)}
      </Table>
      {pay && <Modal title={`Payment for ${pay.number}`} onClose={() => setPay(null)}><Field label="Amount"><input className="input" value={amount} onChange={(e) => setAmount(pickNum(e.target.value))} /></Field><Field label="Method"><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="card">Card</option></select></Field><button className="btn btn-primary" disabled={!amount || m.isPending} onClick={() => m.mutate()}>Record</button></Modal>}
    </>
  );
}

function Analytics() {
  const q = useQuery({ queryKey: ['admin-analytics'], queryFn: () => get<any>('/admin/analytics') });
  if (!q.data) return <Loading />;
  const a = q.data;
  return (
    <>
      <PageHeader title="Analytics" sub="Counts only: shop sales details are never shown here" />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Shops" value={a.shops_total} /><Stat label="Active users" value={a.active_users} /><Stat label="Branches" value={a.branches} /><Stat label="Active tills" value={a.active_terminals} /></div>
      <div className="grid gap-6 lg:grid-cols-3">
        {[['Plan mix', a.plan_mix], ['Subscriptions', a.subscriptions_by_status], ['Sign-ups by month', a.signups_by_month]].map(([t, o]: any) => (
          <div key={t}><h3 className="mb-2 font-semibold">{t}</h3><Table head={['', 'Shops']}>{Object.entries(o).map(([k, v]: any) => <tr key={k}><td className="td">{k.replace('_', ' ')}</td><td className="td font-medium">{v}</td></tr>)}</Table></div>
        ))}
      </div>
    </>
  );
}

function Health() {
  const q = useQuery({ queryKey: ['admin-health'], queryFn: () => get<any>('/admin/system-health'), refetchInterval: 15000 });
  if (!q.data) return <Loading />;
  const h = q.data;
  return (
    <>
      <PageHeader title="System health" />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Queued jobs" value={h.jobs.queued ?? 0} /><Stat label="Dead jobs" value={h.jobs.dead ?? 0} tone={h.jobs.dead ? 'red' : undefined} />
        <Stat label="Oldest waiting (s)" value={h.oldestQueuedSeconds} tone={h.oldestQueuedSeconds > 300 ? 'amber' : undefined} /><Stat label="Event backlog" value={h.outboxBacklog} tone={h.outboxBacklog > 100 ? 'amber' : undefined} />
      </div>
      <h3 className="mb-2 font-semibold">Failed jobs</h3>
      <Table head={['Job', 'Error', 'When']} empty={h.deadJobs.length === 0 && <Empty>No failed jobs.</Empty>}>
        {h.deadJobs.map((j: any) => <tr key={j.id}><td className="td font-medium">{j.type}</td><td className="td text-xs text-red-600">{j.last_error}</td><td className="td">{new Date(j.created_at).toLocaleString()}</td></tr>)}
      </Table>
    </>
  );
}
