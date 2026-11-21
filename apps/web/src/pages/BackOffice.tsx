import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../api';
import { money, qtyText } from '../money';
import { useCan, useHas, useMe } from '../session';
import { Badge, Empty, Loading, PageHeader, Stat, Table } from '../ui';
import { dateTimeText } from './bo/shared';
import { Products } from './bo/Products';
import { StockPage, ExpiryPage, TransfersPage } from './bo/StockPages';
import { Purchasing } from './bo/Purchasing';
import { Customers, Team } from './bo/People';
import { SalesPage, ReportsPage } from './bo/SalesReports';
import { SettingsPage } from './bo/Settings';
import { TintPage } from './bo/Tint';

interface NavItem {
  to: string;
  label: string;
  show: boolean;
}

export function BackOffice() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = (...p: string[]) => p.some((x) => me.permissions.includes(x));
  const has = (f: string) => me.features.includes(f);
  const items: NavItem[] = [
    { to: '/app', label: 'Dashboard', show: can('report.view', 'profit.view') },
    { to: '/app/products', label: 'Products', show: can('catalog.manage') },
    { to: '/app/stock', label: 'Stock', show: can('stock.count', 'stock.receive', 'stock.adjust_request') },
    { to: '/app/buying', label: 'Purchasing', show: can('purchase.manage', 'stock.receive') },
    { to: '/app/customers', label: 'Customers', show: can('customer.manage') },
    { to: '/app/sales', label: 'Sales', show: can('sale.create', 'report.view') },
    { to: '/app/reports', label: 'Profit', show: can('profit.view') },
    { to: '/app/expiry', label: 'Expiry', show: has('batch_expiry') && can('stock.count', 'report.view') },
    { to: '/app/tint', label: 'Tinting', show: has('colour_tinting') && can('tint.mix') },
    { to: '/app/transfers', label: 'Transfers', show: has('branch_transfers') && can('transfer.manage') },
    { to: '/app/team', label: 'Team', show: can('user.manage') },
    { to: '/app/settings', label: 'Settings', show: can('shop.settings') },
  ].filter((i) => i.show);
  const first = items[0]?.to ?? '/';
  const logout = useMutation({
    mutationFn: () => post('/auth/logout'),
    onSettled: () => { qc.clear(); nav('/login'); },
  });

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col bg-brand-900 text-brand-100">
        <div className="p-4">
          <div className="text-lg font-semibold text-white">{me.shop.name}</div>
          <div className="mt-1 flex gap-1"><Badge tone="blue">{me.shop.shop_type}</Badge><Badge>{me.subscription.plan}</Badge></div>
        </div>
        <nav className="flex-1 overflow-auto px-2">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.to === '/app'} className={({ isActive }) => `mb-1 block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-brand-700 text-white' : 'hover:bg-brand-700/50'}`}>
              {i.label}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-1 border-t border-brand-700 p-3 text-sm">
          {can('sale.create') && <button className="btn btn-ghost w-full justify-start text-brand-100 hover:bg-brand-700" onClick={() => nav(me.session.terminalId ? '/pos' : '/till')}>Open till</button>}
          <div className="px-3 text-xs text-brand-100/70">{me.user.name}</div>
          <button className="btn btn-ghost w-full justify-start text-brand-100 hover:bg-brand-700" onClick={() => logout.mutate()}>Sign out</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-6">
        {['restricted', 'cancelled'].includes(me.subscription.status) && (
          <div className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-800">This shop is read-only because the subscription is {me.subscription.status}. You can still view and export your data (Settings → Export).</div>
        )}
        {me.subscription.status === 'past_due' && <div className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-800">Your subscription payment is overdue. Please pay soon to avoid read-only mode.</div>}
        <Routes>
          <Route index element={can('report.view', 'profit.view') ? <Dashboard /> : <Navigate to={first} replace />} />
          <Route path="products" element={<Products />} />
          <Route path="stock" element={<StockPage />} />
          <Route path="buying" element={<Purchasing />} />
          <Route path="customers" element={<Customers />} />
          <Route path="sales" element={<SalesPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="expiry" element={<ExpiryPage />} />
          <Route path="tint" element={<TintPage />} />
          <Route path="transfers" element={<TransfersPage />} />
          <Route path="team" element={<Team />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Dashboard() {
  const me = useMe();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => get<any>('/reports/dashboard'), refetchInterval: 60_000 });
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => get<any[]>('/notifications'), refetchInterval: 60_000 });
  const qc = useQueryClient();
  const read = useMutation({ mutationFn: (id: number) => post(`/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const canProfit = useCan('profit.view');
  const hasCredit = useHas('credit_sales');
  if (q.isLoading) return <Loading />;
  const d = q.data;
  if (!d) return <Empty>Could not load the dashboard.</Empty>;
  const unread = (notes.data ?? []).filter((n) => !n.read_at);
  return (
    <>
      <PageHeader title="Today" sub={me.branchMode.mode === 'multi' ? 'All branches you can see' : undefined} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sales today" value={money(d.today.sales)} />
        <Stat label="Bills" value={d.today.bills} />
        <Stat label="Returns" value={money(d.today.returns)} />
        {canProfit && d.today.estimatedGrossProfit !== undefined && <Stat label="Est. gross profit" value={money(d.today.estimatedGrossProfit)} />}
        <button className="text-left" onClick={() => nav('/app/stock')}><Stat label="Low stock items" value={d.lowStockItems} tone={d.lowStockItems ? 'amber' : undefined} /></button>
        <button className="text-left" onClick={() => nav('/app/stock')}><Stat label="Out of stock" value={d.outOfStockItems} tone={d.outOfStockItems ? 'red' : undefined} /></button>
        {hasCredit && <Stat label="Overdue credit" value={`${money(d.overdueCredit.amount)} (${d.overdueCredit.customers})`} tone={d.overdueCredit.customers ? 'red' : undefined} />}
        {hasCredit && <Stat label="Cheques due this week" value={`${money(d.chequesDueThisWeek.amount)} (${d.chequesDueThisWeek.count})`} />}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 font-semibold">Takings by method (today)</h2>
          <Table head={['Method', 'Net']} empty={d.byMethod.length === 0 && <Empty>No sales yet today.</Empty>}>
            {d.byMethod.map((m: any) => (
              <tr key={m.method}><td className="td capitalize">{m.method.replace('_', ' ')}</td><td className="td">{money(m.net)}</td></tr>
            ))}
          </Table>
        </div>
        <div>
          <h2 className="mb-2 font-semibold">Alerts {unread.length > 0 && <Badge tone="red">{unread.length} new</Badge>}</h2>
          <div className="card divide-y divide-slate-100">
            {(notes.data ?? []).length === 0 && <Empty>Nothing needs your attention.</Empty>}
            {(notes.data ?? []).slice(0, 8).map((n) => (
              <div key={n.id} className={`flex items-start justify-between gap-2 p-3 text-sm ${n.read_at ? 'opacity-60' : ''}`}>
                <div>
                  <div className="font-medium">{n.title}</div>
                  {n.body && <div className="text-xs text-slate-500">{n.body}</div>}
                  <div className="text-xs text-slate-400">{dateTimeText(n.created_at)}</div>
                </div>
                {!n.read_at && <button className="btn btn-ghost text-xs" onClick={() => read.mutate(n.id)}>Mark read</button>}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-6 text-xs text-slate-400">{qtyText(d.today.bills)} bill(s) today. Figures refresh every minute.</p>
    </>
  );
}
