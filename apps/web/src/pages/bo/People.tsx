import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put } from '../../api';
import { money } from '../../money';
import { useCan, useHas, useMe } from '../../session';
import { toast } from '../../store';
import { Badge, Empty, Field, fail, Loading, Modal, PageHeader, Table } from '../../ui';
import { dateText, pickNum, Tabs } from './shared';

// ---------------- customers ----------------
export function Customers() {
  const qc = useQueryClient();
  const hasCredit = useHas('credit_sales');
  const hasCheques = useHas('cheques');
  const canCredit = useCan('credit.manage');
  const [tab, setTab] = useState('list');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<any>(null);
  const list = useQuery({ queryKey: ['customers', tab], queryFn: () => get<any[]>(`/customers${tab === 'owing' ? '?withBalance=true' : ''}`) });
  const filtered = (list.data ?? []).filter((c) => !q || `${c.name} ${c.phone ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader title="Customers" sub="Contacts, price types and credit"><button className="btn btn-primary" onClick={() => setAdding(true)}>+ New customer</button></PageHeader>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'list', label: 'All' }, ...(hasCredit ? [{ key: 'owing', label: 'Owing money' }, { key: 'ageing', label: 'Ageing' }] : []), ...(hasCheques ? [{ key: 'cheques', label: 'Cheques' }] : [])]} />
      {tab === 'ageing' ? <Ageing /> : tab === 'cheques' ? <Cheques /> : (
        <>
          <input className="input mb-3 max-w-sm" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          {list.isLoading ? <Loading /> : (
            <Table head={['Customer', 'Type', 'Credit limit', 'Owes', '']} empty={filtered.length === 0 && <Empty>No customers.</Empty>}>
              {filtered.map((c) => (
                <tr key={c.id}><td className="td font-medium">{c.name}<div className="text-xs font-normal text-slate-400">{c.phone}</div></td><td className="td capitalize">{c.type}</td><td className="td">{hasCredit ? money(c.credit_limit) : '—'}</td>
                  <td className={`td font-medium ${Number(c.balance) > 0 ? 'text-red-600' : ''}`}>{money(c.balance)}</td><td className="td text-right"><button className="btn btn-secondary" onClick={() => setOpen(c)}>Open</button></td></tr>
              ))}
            </Table>
          )}
        </>
      )}
      {adding && <NewCustomer canCredit={canCredit && hasCredit} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['customers'] }); }} />}
      {open && <CustomerDetail id={open.id} hasCredit={hasCredit} canCredit={canCredit} hasCheques={hasCheques} onClose={() => { setOpen(null); qc.invalidateQueries({ queryKey: ['customers'] }); }} />}
    </>
  );
}

function NewCustomer({ canCredit, onClose, onSaved }: { canCredit: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', phone: '', type: 'retail', creditLimit: '', dueDays: '30' });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const m = useMutation({ mutationFn: () => post('/customers', { name: f.name, phone: f.phone || undefined, type: f.type, creditLimit: canCredit && f.creditLimit ? f.creditLimit : undefined, dueDays: canCredit ? Number(f.dueDays) : undefined }), onSuccess: () => { toast.ok('Customer added'); onSaved(); }, onError: fail });
  return (
    <Modal title="New customer" onClose={onClose}>
      <Field label="Name"><input className="input" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
      <Field label="Price type" hint="Contractors and wholesale customers get their own prices automatically"><select className="input" value={f.type} onChange={(e) => set('type', e.target.value)}><option value="retail">Retail</option><option value="contractor">Contractor</option><option value="wholesale">Wholesale</option></select></Field>
      {canCredit && <div className="grid grid-cols-2 gap-2"><Field label="Credit limit"><input className="input" inputMode="decimal" value={f.creditLimit} onChange={(e) => set('creditLimit', pickNum(e.target.value))} /></Field><Field label="Due after (days)"><input className="input" inputMode="numeric" value={f.dueDays} onChange={(e) => set('dueDays', pickNum(e.target.value))} /></Field></div>}
      <div className="flex justify-end gap-2"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!f.name || m.isPending} onClick={() => m.mutate()}>Save</button></div>
    </Modal>
  );
}

function CustomerDetail({ id, hasCredit, canCredit, hasCheques, onClose }: { id: string; hasCredit: boolean; canCredit: boolean; hasCheques: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const c = useQuery({ queryKey: ['customer', id], queryFn: () => get<any>(`/customers/${id}`) });
  const st = useQuery({ queryKey: ['statement', id], queryFn: () => get<any>(`/customers/${id}/statement`) });
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [chequeNo, setChequeNo] = useState('');
  const [limit, setLimit] = useState('');
  const reload = () => { qc.invalidateQueries({ queryKey: ['customer', id] }); qc.invalidateQueries({ queryKey: ['statement', id] }); };
  const pay = useMutation({
    mutationFn: () => post(`/customers/${id}/payments`, { amount, method, cheque: method === 'cheque' ? { chequeNo, chequeDate: new Date().toISOString().slice(0, 10) } : undefined }),
    onSuccess: () => { toast.ok('Payment recorded'); setAmount(''); reload(); }, onError: fail,
  });
  const setLim = useMutation({ mutationFn: () => patch(`/customers/${id}`, { version: c.data.version, creditLimit: limit }), onSuccess: () => { toast.ok('Credit limit saved'); setLimit(''); reload(); }, onError: fail });
  if (!c.data) return <Modal title="Customer" onClose={onClose}><Loading /></Modal>;
  return (
    <Modal title={c.data.name} onClose={onClose} wide>
      <div className="mb-4 grid grid-cols-3 gap-3 text-sm">
        <div><span className="label">Owes</span><span className="text-xl font-semibold">{money(c.data.balance)}</span></div>
        {hasCredit && <div><span className="label">Credit limit</span>{money(c.data.credit_limit)}</div>}
        <div><span className="label">Type</span><span className="capitalize">{c.data.type}</span></div>
      </div>
      {hasCredit && Number(c.data.balance) > 0 && (
        <div className="mb-4 flex items-end gap-2 rounded-md bg-slate-50 p-3">
          <Field label="Payment received"><input className="input !w-32" inputMode="decimal" value={amount} onChange={(e) => setAmount(pickNum(e.target.value))} /></Field>
          <Field label="Method"><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option>{hasCheques && <option value="cheque">Cheque</option>}</select></Field>
          {method === 'cheque' && <Field label="Cheque no."><input className="input !w-32" value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} /></Field>}
          <button className="btn btn-primary mb-3" disabled={!amount || pay.isPending} onClick={() => pay.mutate()}>Record</button>
        </div>
      )}
      {canCredit && hasCredit && <div className="mb-4 flex items-end gap-2"><Field label="Change credit limit"><input className="input !w-40" inputMode="decimal" value={limit} onChange={(e) => setLimit(pickNum(e.target.value))} /></Field><button className="btn btn-secondary mb-3" disabled={!limit} onClick={() => setLim.mutate()}>Save</button></div>}
      <h3 className="mb-2 font-semibold">Statement</h3>
      <div className="max-h-64 overflow-auto">
        <Table head={['Date', 'Entry', 'Amount', 'Balance']} empty={st.data?.entries.length === 0 && <Empty>No entries.</Empty>}>
          {st.data?.entries.map((e: any) => <tr key={e.id}><td className="td">{dateText(e.created_at)}</td><td className="td">{e.entry_type.replace('_', ' ')}{e.invoice_no ? ` · ${e.invoice_no}` : ''}</td><td className={`td ${Number(e.amount) < 0 ? 'text-emerald-700' : ''}`}>{money(e.amount)}</td><td className="td font-medium">{money(e.balance)}</td></tr>)}
        </Table>
      </div>
    </Modal>
  );
}

function Ageing() {
  const q = useQuery({ queryKey: ['ageing'], queryFn: () => get<any[]>('/customers/ageing') });
  if (q.isLoading) return <Loading />;
  return (
    <Table head={['Customer', 'Current', '1–30', '31–60', '61–90', '90+', 'Total']} empty={q.data?.length === 0 && <Empty>Nobody owes anything.</Empty>}>
      {q.data?.map((r) => <tr key={r.customerId}><td className="td font-medium">{r.name}</td><td className="td">{money(r.current)}</td><td className="td">{money(r.d1_30)}</td><td className="td">{money(r.d31_60)}</td><td className="td">{money(r.d61_90)}</td><td className={`td ${Number(r.d90_plus) > 0 ? 'font-semibold text-red-600' : ''}`}>{money(r.d90_plus)}</td><td className="td font-semibold">{money(r.total)}</td></tr>)}
    </Table>
  );
}

function Cheques() {
  const qc = useQueryClient();
  const canAct = useCan('credit.manage', 'purchase.manage');
  const q = useQuery({ queryKey: ['cheques'], queryFn: () => get<any[]>('/cheques') });
  const act = useMutation({ mutationFn: ({ id, what, fee }: { id: string; what: string; fee?: string }) => post(`/cheques/${id}/${what}`, fee ? { fee } : {}), onSuccess: () => { toast.ok('Updated'); qc.invalidateQueries(); }, onError: fail });
  if (q.isLoading) return <Loading />;
  const tone = (s: string) => (s === 'cleared' ? 'green' : s === 'bounced' ? 'red' : s === 'deposited' ? 'blue' : 'amber');
  return (
    <Table head={['Cheque', 'Party', 'Date', 'Amount', 'Status', '']} empty={q.data?.length === 0 && <Empty>No cheques.</Empty>}>
      {q.data?.map((c) => (
        <tr key={c.id}><td className="td font-medium">{c.cheque_no}<div className="text-xs font-normal text-slate-400">{c.bank} · {c.direction}</div></td><td className="td">{c.customer ?? c.supplier ?? '—'}</td><td className="td">{dateText(c.cheque_date)}</td><td className="td">{money(c.amount)}</td><td className="td"><Badge tone={tone(c.status) as any}>{c.status}</Badge></td>
          <td className="td text-right">{canAct && c.status === 'pending' && <button className="btn btn-secondary mr-1" onClick={() => act.mutate({ id: c.id, what: 'deposit' })}>Deposited</button>}
            {canAct && c.status === 'deposited' && <button className="btn btn-primary mr-1" onClick={() => act.mutate({ id: c.id, what: 'clear' })}>Cleared</button>}
            {canAct && ['pending', 'deposited'].includes(c.status) && <button className="btn btn-danger" onClick={() => { const fee = window.prompt('Bank fee to charge (leave empty for none)') ?? undefined; act.mutate({ id: c.id, what: 'bounce', fee: fee || undefined }); }}>Bounced</button>}</td></tr>
      ))}
    </Table>
  );
}

// ---------------- team: users and roles (shop admin) ----------------
export function Team() {
  const [tab, setTab] = useState('users');
  return (
    <>
      <PageHeader title="Team" sub="Your staff and what each role may do" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'users', label: 'Users' }, { key: 'roles', label: 'Roles & permissions' }]} />
      {tab === 'users' ? <Users /> : <Roles />}
    </>
  );
}

function Users() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['users'], queryFn: () => get<any[]>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<any[]>('/roles') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get<any[]>('/branches') });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', email: '', roleId: '', branchId: '' });
  const [created, setCreated] = useState<any>(null);
  const [pinFor, setPinFor] = useState<any>(null);
  const [pin, setPin] = useState('');
  const invite = useMutation({ mutationFn: () => post('/users', { name: f.name, email: f.email, roleId: f.roleId, branchId: f.branchId || null }), onSuccess: (r) => { setCreated(r); setAdding(false); qc.invalidateQueries({ queryKey: ['users'] }); }, onError: fail });
  const act = useMutation({ mutationFn: ({ id, what }: { id: string; what: string }) => post(`/users/${id}/${what}`), onSuccess: (r: any, v) => { if (v.what === 'reset-password') setCreated({ name: 'password reset', tempPassword: r.tempPassword }); else toast.ok('Done'); qc.invalidateQueries({ queryKey: ['users'] }); }, onError: fail });
  const setPinM = useMutation({ mutationFn: () => put(`/users/${pinFor.id}/pin`, { pin }), onSuccess: () => { toast.ok('PIN saved'); setPinFor(null); setPin(''); }, onError: fail });
  return (
    <>
      <div className="mb-3 flex justify-end"><button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add staff</button></div>
      <Table head={['Name', 'Email', 'Roles', 'Status', '']} empty={q.data?.length === 0 && <Empty>No users.</Empty>}>
        {q.data?.map((u) => (
          <tr key={u.id}><td className="td font-medium">{u.name}</td><td className="td">{u.email}</td>
            <td className="td text-xs">{u.roles.map((r: any) => `${r.role_name}${r.branch_id ? ` @ ${branches.data?.find((b) => b.id === r.branch_id)?.name ?? ''}` : ' (all branches)'}`).join(', ')}</td>
            <td className="td"><Badge tone={u.status === 'active' ? 'green' : 'slate'}>{u.status}</Badge></td>
            <td className="td text-right whitespace-nowrap">
              <button className="btn btn-ghost" onClick={() => setPinFor(u)}>Set PIN</button>
              <button className="btn btn-ghost" onClick={() => act.mutate({ id: u.id, what: 'reset-password' })}>Reset password</button>
              {u.id !== me.user.id && (u.status === 'active' ? <button className="btn btn-ghost text-red-600" onClick={() => act.mutate({ id: u.id, what: 'deactivate' })}>Deactivate</button> : <button className="btn btn-ghost" onClick={() => act.mutate({ id: u.id, what: 'reactivate' })}>Reactivate</button>)}
            </td></tr>
        ))}
      </Table>
      <p className="mt-2 text-xs text-slate-400">Plan limit: {me.limits.max_users ?? 'unlimited'} users.</p>
      {adding && (
        <Modal title="Add staff" onClose={() => setAdding(false)}>
          <Field label="Name"><input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role"><select className="input" value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}><option value="">Choose…</option>{roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Works at"><select className="input" value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">All branches</option>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <div className="flex justify-end gap-2"><button className="btn btn-secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" disabled={!f.name || !f.email || !f.roleId || invite.isPending} onClick={() => invite.mutate()}>Add</button></div>
        </Modal>
      )}
      {created && <Modal title="Temporary password" onClose={() => setCreated(null)}><p className="mb-2 text-sm">Give this to {created.name}. It is shown once and they must change it at first sign-in.</p><div className="rounded-md bg-slate-100 p-3 text-center font-mono text-lg">{created.tempPassword}</div></Modal>}
      {pinFor && <Modal title={`PIN for ${pinFor.name}`} onClose={() => setPinFor(null)}><Field label="4 to 8 digits" hint="Used for quick user switching at a till, and by managers to approve discounts and voids"><input className="input" type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></Field><button className="btn btn-primary" disabled={pin.length < 4} onClick={() => setPinM.mutate()}>Save PIN</button></Modal>}
    </>
  );
}

const PERM_GROUPS: Record<string, string[]> = {
  Selling: ['sale.create', 'payment.take', 'price.override_on_sale', 'discount.large', 'sale.void', 'sale.refund', 'tint.mix'],
  'Stock & products': ['catalog.manage', 'price.change', 'stock.receive', 'stock.count', 'stock.adjust_request', 'stock.adjust', 'lowstock.receive_alerts', 'transfer.manage', 'import.manage'],
  'Money & people': ['purchase.manage', 'customer.manage', 'credit.manage', 'cost.view', 'profit.view', 'report.view', 'approval.grant'],
  Administration: ['user.manage', 'role.manage', 'branch.manage', 'terminal.manage', 'shop.settings'],
};

function Roles() {
  const qc = useQueryClient();
  const hasCustom = useHas('custom_roles');
  const canEdit = useCan('role.manage');
  const q = useQuery({ queryKey: ['roles'], queryFn: () => get<any[]>('/roles') });
  const [sel, setSel] = useState<any>(null);
  const [perms, setPerms] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const open = (r: any) => { setSel(r); setPerms(r.permissions); };
  const save = useMutation({ mutationFn: () => patch(`/roles/${sel.id}`, { permissions: perms }), onSuccess: () => { toast.ok('Role saved'); setSel(null); qc.invalidateQueries({ queryKey: ['roles'] }); }, onError: fail });
  const create = useMutation({ mutationFn: () => post('/roles', { name, permissions: perms }), onSuccess: () => { toast.ok('Role created'); setCreating(false); setName(''); setPerms([]); qc.invalidateQueries({ queryKey: ['roles'] }); }, onError: fail });
  const remove = useMutation({ mutationFn: (id: string) => del(`/roles/${id}`), onSuccess: () => { toast.ok('Role deleted'); qc.invalidateQueries({ queryKey: ['roles'] }); }, onError: fail });
  const Matrix = ({ locked }: { locked: boolean }) => (
    <div className="max-h-96 overflow-auto">
      {Object.entries(PERM_GROUPS).map(([g, ps]) => (
        <div key={g} className="mb-3"><div className="label">{g}</div>
          <div className="grid grid-cols-2 gap-1 text-sm">{ps.map((p) => <label key={p}><input type="checkbox" disabled={locked} checked={perms.includes(p)} onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))} /> {p}</label>)}</div></div>
      ))}
    </div>
  );
  return (
    <>
      {canEdit && hasCustom && <div className="mb-3 flex justify-end"><button className="btn btn-primary" onClick={() => { setCreating(true); setPerms([]); }}>+ New role</button></div>}
      <Table head={['Role', 'Type', 'Permissions', '']}>
        {q.data?.map((r) => (
          <tr key={r.id}><td className="td font-medium">{r.name}</td><td className="td">{r.is_system ? <Badge>system</Badge> : <Badge tone="blue">custom</Badge>}</td><td className="td text-xs text-slate-500">{r.permissions.length} permissions</td>
            <td className="td text-right">{r.system_key !== 'owner' && canEdit ? <button className="btn btn-secondary" onClick={() => open(r)}>Edit</button> : <button className="btn btn-ghost" onClick={() => open(r)}>View</button>}
              {!r.is_system && canEdit && <button className="btn btn-ghost text-red-600" onClick={() => remove.mutate(r.id)}>Delete</button>}</td></tr>
        ))}
      </Table>
      {!hasCustom && <p className="mt-2 text-xs text-slate-400">Creating your own roles is a plan feature. You can still edit the permissions of Manager, Cashier and Storekeeper.</p>}
      {sel && <Modal title={`Role: ${sel.name}`} onClose={() => setSel(null)} wide><Matrix locked={sel.system_key === 'owner' || !canEdit} />{sel.system_key !== 'owner' && canEdit && <div className="mt-3 flex justify-end"><button className="btn btn-primary" onClick={() => save.mutate()}>Save</button></div>}</Modal>}
      {creating && <Modal title="New role" onClose={() => setCreating(false)} wide><Field label="Role name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field><Matrix locked={false} /><div className="mt-3 flex justify-end"><button className="btn btn-primary" disabled={!name} onClick={() => create.mutate()}>Create</button></div></Modal>}
    </>
  );
}
