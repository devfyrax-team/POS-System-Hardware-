import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../api';
import { useCan, useMe } from '../session';
import { Badge, Field, fail, Loading } from '../ui';
import { toast } from '../store';

function Frame({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-900 to-brand-600 p-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-700 text-xl font-bold text-white">POS</div>
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm text-slate-500">{sub}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Login() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () => post('/auth/login', { email, password }, { noRefresh: true }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav('/', { replace: true });
    },
    onError: fail,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Frame title="Sign in" sub="Hardware & Paint POS">
      <form onSubmit={submit}>
        <Field label="Email"><input className="input" type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="btn btn-primary w-full" disabled={m.isPending}>{m.isPending ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="mt-4 text-center text-xs text-slate-400"><Link to="/admin/login" className="hover:underline">Platform admin</Link></p>
    </Frame>
  );
}

export function AdminLogin() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () => post('/admin/auth/login', { email, password }, { noRefresh: true }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin-probe'] });
      nav('/admin/shops', { replace: true });
    },
    onError: fail,
  });
  return (
    <Frame title="Platform admin" sub="Manage shops, plans and features">
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Email"><input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="btn btn-primary w-full" disabled={m.isPending}>Sign in</button>
      </form>
      <p className="mt-4 text-center text-xs text-slate-400"><Link to="/login" className="hover:underline">Shop sign in</Link></p>
    </Frame>
  );
}

/** After signing in: start selling, or open the back office. */
export function Home() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const canSell = useCan('sale.create');
  const office = useCan('report.view', 'profit.view', 'catalog.manage', 'stock.receive', 'stock.count', 'purchase.manage', 'user.manage', 'shop.settings', 'customer.manage');
  const [oldPw, setOld] = useState('');
  const [newPw, setNew] = useState('');
  const change = useMutation({
    mutationFn: () => post('/auth/change-password', { oldPassword: oldPw, newPassword: newPw }),
    onSuccess: async () => {
      toast.ok('Password changed. Please sign in again.');
      await post('/auth/logout').catch(() => undefined);
      qc.clear();
      nav('/login');
    },
    onError: fail,
  });
  const logout = async () => {
    await post('/auth/logout').catch(() => undefined);
    qc.clear();
    nav('/login');
  };

  if (me.user.must_change_password) {
    return (
      <Frame title="Set a new password" sub="You signed in with a temporary password">
        <form onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
          <Field label="Temporary password"><input className="input" type="password" value={oldPw} onChange={(e) => setOld(e.target.value)} required /></Field>
          <Field label="New password" hint="At least 8 characters"><input className="input" type="password" minLength={8} value={newPw} onChange={(e) => setNew(e.target.value)} required /></Field>
          <button className="btn btn-primary w-full" disabled={change.isPending}>Change password</button>
        </form>
      </Frame>
    );
  }

  return (
    <Frame title={`Hello, ${me.user.name}`} sub={me.shop.name}>
      {me.subscription.status !== 'active' && me.subscription.status !== 'trial' && (
        <div className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
          Subscription: <b>{me.subscription.status.replace('_', ' ')}</b>
          {['restricted', 'cancelled'].includes(me.subscription.status) ? '. The shop is read-only until the payment is made.' : '. Please pay to avoid read-only mode.'}
        </div>
      )}
      <div className="flex flex-col gap-3">
        {canSell && <button className="btn btn-primary py-4 text-base" onClick={() => nav(me.session.terminalId ? '/pos' : '/till')}>Start selling</button>}
        {office && <button className="btn btn-secondary py-3" onClick={() => nav('/app')}>Back office</button>}
        <button className="btn btn-ghost" onClick={logout}>Sign out</button>
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-1">
        <Badge tone="blue">{me.shop.shop_type}</Badge>
        <Badge>{me.subscription.plan}</Badge>
        {me.session.terminalId && <Badge tone="green">till ready</Badge>}
      </div>
    </Frame>
  );
}

/** Choose which registered till this device is, then sell. */
export function TillPicker() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['terminals'], queryFn: () => get<{ id: string; name: string; prefix: string; status: string; branch_id: string }[]>('/terminals') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get<{ id: string; name: string }[]>('/branches') });
  const pick = useMutation({
    mutationFn: (terminalId: string) => post('/auth/select-terminal', { terminalId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav('/pos', { replace: true });
    },
    onError: fail,
  });
  if (q.isLoading) return <Loading />;
  const list = (q.data ?? []).filter((t) => t.status === 'active');
  return (
    <Frame title="Which till is this?" sub={me.shop.name}>
      {list.length === 0 && <p className="text-sm text-slate-500">No tills are registered yet. Ask the owner to add one in Back office → Settings.</p>}
      <div className="flex flex-col gap-2">
        {list.map((t) => (
          <button key={t.id} className="btn btn-secondary justify-between py-3" disabled={pick.isPending} onClick={() => pick.mutate(t.id)}>
            <span className="font-medium">{t.name}</span>
            <span className="text-xs text-slate-400">{t.prefix}{me.branchMode.mode === 'multi' ? ` · ${branches.data?.find((b) => b.id === t.branch_id)?.name ?? ''}` : ''}</span>
          </button>
        ))}
      </div>
      <button className="btn btn-ghost mt-3 w-full" onClick={() => nav('/')}>Back</button>
    </Frame>
  );
}
