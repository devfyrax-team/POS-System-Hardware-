import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ApiError, get, post, qs } from '../api';
import { centsToDecimal, fmtCents, lineCents, money, parseScaled, qtyText, toCents } from '../money';
import { useCan, useHas, useMe } from '../session';
import { CartCustomer, CartLine, cartTotalCents, toast, useCart } from '../store';
import { Badge, errText, Field, Modal } from '../ui';

interface Hit {
  id: string;
  name: string;
  name_si?: string;
  sku: string;
  short_code?: string;
  base_unit: string;
  decimal_qty: boolean;
  price: string | null;
  stock: string;
  unit_id?: string;
  track_batches?: boolean;
}

const METHODS = [
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Card' },
  { key: 'bank_transfer', label: 'Bank transfer' },
  { key: 'cheque', label: 'Cheque' },
  { key: 'credit', label: 'Credit' },
] as const;
type Method = (typeof METHODS)[number]['key'];

export function Pos() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const cart = useCart();
  const hasCredit = useHas('credit_sales');
  const canTint = useCan('tint.mix') && useHas('colour_tinting');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pay, setPay] = useState(false);
  const [held, setHeld] = useState(false);
  const [done, setDone] = useState<{ saleId: string; invoiceNo: string; total: string; change: string } | null>(null);
  const [approval, setApproval] = useState<{ action: string } | null>(null);
  const [custOpen, setCustOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // The till must be bound to a registered terminal.
  useEffect(() => {
    if (!me.session.terminalId) nav('/till', { replace: true });
  }, [me.session.terminalId, nav]);

  const favourites = useQuery({ queryKey: ['favourites', me.session.branchId], queryFn: () => get<Hit[]>('/products/search?q='), staleTime: 60_000 });

  // debounce search; an Enter press with an exact barcode / SKU / short code adds the item at once (scanner = keyboard)
  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setResults(await get<Hit[]>(`/products/search${qs({ q })}`));
      } catch (e) {
        toast.error(errText(e));
      } finally {
        setSearching(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const addHit = async (h: Hit) => {
    let unitOptions: { id: string; unit: string }[] | undefined;
    try {
      const p = await get<{ units: { id: string; unit: string; factor: string; is_base: boolean }[] }>(`/products/${h.id}`);
      if (p.units.length > 1) unitOptions = p.units.map((u) => ({ id: u.id, unit: u.unit }));
    } catch {
      /* the till still works with the base unit */
    }
    if (h.price === null) toast.error(`"${h.name}" has no price yet. Set a price in Back office → Products.`);
    cart.add({ productId: h.id, name: h.name, unit: h.base_unit, unitId: h.unit_id, unitOptions, decimalQty: h.decimal_qty, price: h.price ?? '0', stock: h.stock });
    setQ('');
    setResults([]);
    searchRef.current?.focus();
  };

  const onEnter = () => {
    if (results.length >= 1 && (results.length === 1 || results[0].sku.toLowerCase() === q.trim().toLowerCase() || results[0].short_code?.toLowerCase() === q.trim().toLowerCase())) void addHit(results[0]);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'F9' && cart.lines.length) { e.preventDefault(); setPay(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [cart.lines.length]);

  const total = cartTotalCents(cart.lines, cart.billDiscount);
  const items = cart.lines.length;

  const hold = useMutation({
    mutationFn: () => post('/held-bills', { label: cart.customer?.name ?? `${items} item(s)`, cart: { lines: cart.lines, customer: cart.customer, billDiscount: cart.billDiscount } }),
    onSuccess: () => { cart.clear(); toast.ok('Bill held'); },
    onError: (e) => toast.error(errText(e)),
  });

  if (!me.session.terminalId) return null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between bg-brand-900 px-4 py-2 text-white">
        <div className="flex items-center gap-3">
          <span className="font-semibold">{me.shop.name}</span>
          <Badge tone="green">Till</Badge>
          <span className="text-sm text-brand-100">{me.user.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {canTint && <button className="btn btn-ghost text-white hover:bg-brand-700" onClick={() => nav('/app/tint')}>Tinting</button>}
          <button className="btn btn-ghost text-white hover:bg-brand-700" onClick={() => setHeld(true)}>Held bills</button>
          <button className="btn btn-ghost text-white hover:bg-brand-700" onClick={() => nav('/app')}>Back office</button>
          <button
            className="btn btn-ghost text-white hover:bg-brand-700"
            onClick={async () => { await post('/auth/logout').catch(() => undefined); qc.clear(); cart.clear(); nav('/login'); }}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[1fr_28rem]">
        {/* ----- find items ----- */}
        <section className="flex min-h-0 flex-col">
          <input
            ref={searchRef}
            autoFocus
            className="input py-3 text-base"
            placeholder="Scan barcode, or type name / size / SKU / short code   (F2)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onEnter()}
          />
          <div className="mt-3 min-h-0 flex-1 overflow-auto">
            {q.trim() ? (
              <div className="card divide-y divide-slate-100">
                {searching && results.length === 0 && <div className="p-4 text-sm text-slate-400">Searching…</div>}
                {!searching && results.length === 0 && <div className="p-4 text-sm text-slate-400">Nothing found for "{q}". Ask a manager to add it, or use Quick add.</div>}
                {results.map((h) => <HitRow key={h.id} h={h} onPick={() => addHit(h)} />)}
              </div>
            ) : (
              <>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Favourites</p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
                  {(favourites.data ?? []).map((h) => (
                    <button key={h.id} className="card p-3 text-left hover:border-brand-600" onClick={() => addHit(h)}>
                      <div className="line-clamp-2 text-sm font-medium">{h.name}</div>
                      <div className="mt-1 text-sm text-brand-700">{h.price ? money(h.price) : 'no price'}</div>
                    </button>
                  ))}
                  {favourites.data?.length === 0 && <p className="col-span-full text-sm text-slate-400">Mark items as favourites in Back office → Products for one-touch selling.</p>}
                </div>
              </>
            )}
            <QuickAdd onAdded={(h) => addHit(h)} />
          </div>
        </section>

        {/* ----- the bill ----- */}
        <section className="card flex min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 p-3">
            <button className="text-left text-sm" onClick={() => setCustOpen(true)}>
              <span className="label !mb-0">Customer</span>
              <span className="font-medium">{cart.customer ? cart.customer.name : 'Walk-in'}</span>
              {cart.customer && <span className="ml-2 text-xs text-slate-400">{cart.customer.type}</span>}
            </button>
            {cart.lines.length > 0 && <button className="btn btn-ghost text-red-600" onClick={() => cart.clear()}>Clear</button>}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {cart.lines.length === 0 && <div className="p-8 text-center text-sm text-slate-400">The bill is empty.<br />Scan or search to add items.</div>}
            {cart.lines.map((l) => <CartRow key={l.key} l={l} />)}
          </div>
          <div className="border-t border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-slate-500">Bill discount</span>
              <input className="input !w-28 text-right" inputMode="decimal" value={cart.billDiscount === '0' ? '' : cart.billDiscount} placeholder="0.00" onChange={(e) => cart.setBillDiscount(e.target.value.replace(/[^\d.]/g, '') || '0')} />
            </div>
            <div className="mb-3 flex items-end justify-between">
              <span className="text-sm text-slate-500">{items} item{items === 1 ? '' : 's'}</span>
              <span className="text-3xl font-bold">{fmtCents(total)}</span>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-secondary" disabled={!items || hold.isPending} onClick={() => hold.mutate()}>Hold</button>
              <button className="btn btn-primary flex-1 py-3 text-base" disabled={!items} onClick={() => setPay(true)}>Pay (F9)</button>
            </div>
          </div>
        </section>
      </div>

      {pay && <PayModal total={total} hasCredit={hasCredit} onClose={() => setPay(false)} onNeedApproval={(action) => { setPay(false); setApproval({ action }); }} onDone={(r) => { setPay(false); setDone(r); cart.clear(); qc.invalidateQueries({ queryKey: ['favourites'] }); }} />}
      {done && <ReceiptModal sale={done} onClose={() => { setDone(null); searchRef.current?.focus(); }} />}
      {held && <HeldModal onClose={() => setHeld(false)} />}
      {custOpen && <CustomerModal onClose={() => setCustOpen(false)} />}
      {approval && <ApprovalModal action={approval.action} onClose={() => setApproval(null)} onGranted={() => { setApproval(null); setPay(true); }} />}
    </div>
  );
}

function HitRow({ h, onPick }: { h: Hit; onPick: () => void }) {
  const low = Number(h.stock) <= 0;
  return (
    <button className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-brand-50" onClick={onPick}>
      <div>
        <div className="font-medium">{h.name}</div>
        <div className="text-xs text-slate-400">{h.sku}{h.short_code ? ` · ${h.short_code}` : ''}{h.name_si ? ` · ${h.name_si}` : ''}</div>
      </div>
      <div className="text-right">
        <div className="font-semibold">{h.price ? money(h.price) : <span className="text-amber-600">no price</span>}<span className="text-xs font-normal text-slate-400"> / {h.base_unit}</span></div>
        <div className={`text-xs ${low ? 'text-red-600' : 'text-slate-400'}`}>{low ? 'Out of stock' : `${qtyText(h.stock)} in stock`}</div>
      </div>
    </button>
  );
}

function CartRow({ l }: { l: CartLine }) {
  const cart = useCart();
  const price = l.priceOverride ?? l.price;
  const lineTotal = lineCents(price, l.qty, l.discount);
  const set = (v: string) => cart.setQty(l.key, v.replace(l.decimalQty ? /[^\d.]/g : /[^\d]/g, ''));
  return (
    <div className="border-b border-slate-100 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{l.name}</div>
          <div className="text-xs text-slate-400">
            {money(price)} / {l.unit}
            {l.stock !== undefined && Number(l.qty) > Number(l.stock) && <span className="ml-2 font-medium text-red-600">only {qtyText(l.stock)} in stock</span>}
          </div>
        </div>
        <div className="text-right text-sm font-semibold">{fmtCents(lineTotal)}</div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button className="btn btn-secondary !px-2" onClick={() => set(String(Math.max(0, Number(l.qty) - 1)))} aria-label="less">−</button>
        <input className="input !w-20 text-center" inputMode="decimal" value={l.qty} onChange={(e) => set(e.target.value)} onBlur={() => !Number(l.qty) && cart.remove(l.key)} />
        <button className="btn btn-secondary !px-2" onClick={() => set(String(Number(l.qty) + 1))} aria-label="more">+</button>
        {l.unitOptions && (
          <select className="input !w-24" value={l.unitId ?? ''} onChange={(e) => { const o = l.unitOptions!.find((u) => u.id === e.target.value)!; cart.setLine(l.key, { unitId: o.id, unit: o.unit }); }}>
            <option value="">{l.unit}</option>
            {l.unitOptions.map((u) => <option key={u.id} value={u.id}>{u.unit}</option>)}
          </select>
        )}
        <input className="input !w-20 text-right" inputMode="decimal" placeholder="disc." title="Discount amount" value={l.discount === '0' ? '' : l.discount} onChange={(e) => cart.setLine(l.key, { discount: e.target.value.replace(/[^\d.]/g, '') || '0' })} />
        <button className="btn btn-ghost ml-auto text-red-600" onClick={() => cart.remove(l.key)} aria-label="remove">✕</button>
      </div>
    </div>
  );
}

function QuickAdd({ onAdded }: { onAdded: (h: Hit) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('pcs');
  const [price, setPrice] = useState('');
  const m = useMutation({
    mutationFn: () => post('/products/quick-add', { name, unit, price }),
    onSuccess: (p: any) => {
      toast.ok('Item created and flagged for review');
      onAdded({ id: p.id, name: p.name, sku: p.sku, short_code: p.short_code, base_unit: p.base_unit, decimal_qty: p.decimal_qty, price, stock: '0' });
      setOpen(false); setName(''); setPrice('');
    },
    onError: (e) => toast.error(errText(e)),
  });
  if (!open) return <button className="btn btn-ghost mt-3 text-sm" onClick={() => setOpen(true)}>+ Quick add an unlisted item</button>;
  return (
    <div className="card mt-3 p-3">
      <div className="grid grid-cols-[1fr_6rem_7rem_auto] items-end gap-2">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Unit"><input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
        <Field label="Price"><input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        <button className="btn btn-primary mb-3" disabled={!name || !price || m.isPending} onClick={() => m.mutate()}>Add</button>
      </div>
      <p className="text-xs text-slate-400">The item is created in seconds and flagged for a manager to review. It has no stock until counted, so it cannot be sold until stock is added.</p>
    </div>
  );
}

function PayModal({ total, hasCredit, onClose, onDone, onNeedApproval }: {
  total: bigint;
  hasCredit: boolean;
  onClose: () => void;
  onDone: (r: { saleId: string; invoiceNo: string; total: string; change: string }) => void;
  onNeedApproval: (action: string) => void;
}) {
  const cart = useCart();
  const [amounts, setAmounts] = useState<Partial<Record<Method, string>>>({ cash: centsToDecimal(total) });
  const [refs, setRefs] = useState<Partial<Record<Method, string>>>({});
  const set = (m: Method, v: string) => setAmounts((a) => ({ ...a, [m]: v.replace(/[^\d.]/g, '') }));
  const paid = METHODS.reduce((a, m) => a + toCents(amounts[m.key]), 0n);
  const nonCash = METHODS.filter((m) => m.key !== 'cash').reduce((a, m) => a + toCents(amounts[m.key]), 0n);
  const cashNeeded = total - nonCash;
  const change = toCents(amounts.cash) - cashNeeded;
  const covered = nonCash <= total && toCents(amounts.cash) >= cashNeeded;

  const submit = useMutation({
    mutationFn: async () => {
      const payments = METHODS.filter((m) => toCents(amounts[m.key]) > 0n && (m.key !== 'credit' || hasCredit)).map((m) => ({
        method: m.key, amount: centsToDecimal(toCents(amounts[m.key])), reference: refs[m.key] || undefined,
        cheque: m.key === 'cheque' ? { chequeNo: refs.cheque ?? '', chequeDate: new Date().toISOString().slice(0, 10) } : undefined,
      }));
      const body = {
        customerId: cart.customer?.id,
        lines: cart.lines.map((l) => ({
          productId: l.productId, unitId: l.unitId, qty: l.qty, discount: l.discount !== '0' ? l.discount : undefined,
          priceOverride: l.priceOverride, batchId: l.batchId,
        })),
        payments,
        billDiscount: cart.billDiscount !== '0' ? cart.billDiscount : undefined,
        approvals: Object.keys(cart.approvals).length ? cart.approvals : undefined,
      };
      const key = cart.keyFor(JSON.stringify(body));
      return post('/sales', body, { headers: { 'Idempotency-Key': key } });
    },
    onSuccess: (r: any) => onDone({ saleId: r.saleId, invoiceNo: r.invoiceNo, total: r.total, change: r.change }),
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') return onNeedApproval(e.details?.action);
      toast.error(errText(e));
    },
  });

  return (
    <Modal title={`Pay ${fmtCents(total)}`} onClose={onClose}>
      {METHODS.filter((m) => m.key !== 'credit' || hasCredit).map((m) => (
        <div key={m.key} className="mb-2 grid grid-cols-[7rem_1fr_1fr] items-center gap-2">
          <span className="text-sm font-medium">{m.label}</span>
          <input className="input text-right" inputMode="decimal" placeholder="0.00" value={amounts[m.key] ?? ''} onChange={(e) => set(m.key, e.target.value)} disabled={m.key === 'credit' && !cart.customer} />
          {m.key === 'cash' ? (
            <div className="flex gap-1">
              {['500', '1000', '2000', '5000'].map((v) => <button key={v} type="button" className="btn btn-secondary !px-2 text-xs" onClick={() => set('cash', v)}>{v}</button>)}
            </div>
          ) : m.key === 'credit' ? (
            <span className="text-xs text-slate-400">{cart.customer ? `limit ${money(cart.customer.credit_limit)}` : 'choose a customer'}</span>
          ) : (
            <input className="input" placeholder={m.key === 'cheque' ? 'Cheque no.' : 'Reference'} value={refs[m.key] ?? ''} onChange={(e) => setRefs((r) => ({ ...r, [m.key]: e.target.value }))} />
          )}
        </div>
      ))}
      <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
        <div className="flex justify-between"><span>Total</span><b>{fmtCents(total)}</b></div>
        <div className="flex justify-between"><span>Received</span><b>{fmtCents(paid)}</b></div>
        {covered && change > 0n && <div className="flex justify-between text-lg text-brand-700"><span>Change</span><b>{fmtCents(change)}</b></div>}
        {!covered && <div className="flex justify-between text-red-600"><span>Still to pay</span><b>{fmtCents(cashNeeded - toCents(amounts.cash) > 0n ? cashNeeded - toCents(amounts.cash) : 0n)}</b></div>}
      </div>
      <div className="mt-4 flex gap-2">
        <button className="btn btn-secondary" onClick={onClose}>Back</button>
        <button className="btn btn-primary flex-1 py-3" disabled={!covered || submit.isPending} onClick={() => submit.mutate()}>{submit.isPending ? 'Saving…' : 'Complete sale'}</button>
      </div>
      <p className="mt-2 text-xs text-slate-400">The server checks prices, stock and credit again and calculates every total itself. A retry never creates a second bill.</p>
    </Modal>
  );
}

function ReceiptModal({ sale, onClose }: { sale: { saleId: string; invoiceNo: string; total: string; change: string }; onClose: () => void }) {
  const q = useQuery({ queryKey: ['receipt', sale.saleId], queryFn: () => get<{ text: string; needsRaster: boolean }>(`/sales/${sale.saleId}/receipt`) });
  return (
    <Modal title={`Sale ${sale.invoiceNo}`} onClose={onClose}>
      <div className="mb-3 text-center">
        <div className="text-3xl font-bold text-brand-700">{money(sale.total)}</div>
        {Number(sale.change) > 0 && <div className="text-lg">Change: <b>{money(sale.change)}</b></div>}
      </div>
      <div className="print-area max-h-72 overflow-auto rounded-md border border-dashed border-slate-300 bg-white p-2">
        <pre className="whitespace-pre text-[11px] leading-4" style={{ fontFamily: "'Courier New', monospace" }}>{q.data?.text ?? 'Loading receipt…'}</pre>
      </div>
      {q.data?.needsRaster && <p className="mt-1 text-xs text-amber-700">This receipt contains Sinhala or Tamil text: it prints as an image on thermal printers.</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn btn-secondary flex-1" onClick={() => window.print()}>Print receipt</button>
        <button className="btn btn-primary flex-1" autoFocus onClick={onClose}>New sale</button>
      </div>
    </Modal>
  );
}

function HeldModal({ onClose }: { onClose: () => void }) {
  const cart = useCart();
  const q = useQuery({ queryKey: ['held'], queryFn: () => get<{ id: string; label: string; created_at: string }[]>('/held-bills'), staleTime: 0 });
  const recall = useMutation({
    mutationFn: (id: string) => post<{ cart: any }>(`/held-bills/${id}/recall`),
    onSuccess: (r) => { cart.load({ lines: r.cart.lines ?? [], customer: r.cart.customer ?? null, billDiscount: r.cart.billDiscount ?? '0' }); onClose(); },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <Modal title="Held bills" onClose={onClose}>
      {q.data?.length === 0 && <p className="text-sm text-slate-400">No bills on hold at this till.</p>}
      {q.data?.map((h) => (
        <button key={h.id} className="mb-2 flex w-full items-center justify-between rounded-md border border-slate-200 p-3 text-left hover:bg-brand-50" onClick={() => recall.mutate(h.id)}>
          <span className="font-medium">{h.label}</span>
          <span className="text-xs text-slate-400">{new Date(h.created_at).toLocaleTimeString()}</span>
        </button>
      ))}
      <p className="mt-2 text-xs text-slate-400">Holding a bill does not reserve stock.</p>
    </Modal>
  );
}

function CustomerModal({ onClose }: { onClose: () => void }) {
  const cart = useCart();
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const list = useQuery({ queryKey: ['cust-search', q], queryFn: () => get<CartCustomer[]>(`/customers/search${qs({ q })}`) });
  const add = useMutation({
    mutationFn: () => post<CartCustomer>('/customers', { name, phone: phone || undefined }),
    onSuccess: (c) => { cart.setCustomer(c); onClose(); },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <Modal title="Customer" onClose={onClose}>
      <input className="input mb-3" autoFocus placeholder="Search by name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      <button className="btn btn-secondary mb-2 w-full" onClick={() => { cart.setCustomer(null); onClose(); }}>Walk-in (no customer)</button>
      <div className="max-h-56 overflow-auto">
        {list.data?.map((c) => (
          <button key={c.id} className="mb-1 flex w-full items-center justify-between rounded-md border border-slate-200 p-2 text-left text-sm hover:bg-brand-50" onClick={() => { cart.setCustomer(c); onClose(); }}>
            <span>{c.name}<span className="ml-2 text-xs text-slate-400">{(c as any).phone ?? ''}</span></span>
            <span className="text-xs text-slate-400">{c.type}{Number(c.balance) > 0 ? ` · owes ${money(c.balance)}` : ''}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 border-t border-slate-200 pt-3">
        <p className="label">New customer</p>
        <div className="flex gap-2">
          <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn btn-primary" disabled={!name || add.isPending} onClick={() => add.mutate()}>Add</button>
        </div>
      </div>
    </Modal>
  );
}

const ACTION_TEXT: Record<string, string> = {
  'discount.large': 'This discount is above your limit.',
  'price.override': 'Changing the price needs approval.',
  'sale.void': 'Voiding a sale needs approval.',
  'sale.refund': 'A refund needs approval.',
};

/** A supervisor enters their email and PIN at the till; the token is used for this one action. */
function ApprovalModal({ action, onClose, onGranted }: { action: string; onClose: () => void; onGranted: () => void }) {
  const cart = useCart();
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const m = useMutation({
    mutationFn: () => post<{ token: string }>('/approvals', { action, approverEmail: email, pin }),
    onSuccess: (r) => { cart.setApproval(action, r.token); toast.ok('Approved'); onGranted(); },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <Modal title="Supervisor approval" onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">{ACTION_TEXT[action] ?? `Approval needed for ${action}.`} A manager or owner enters their email and PIN. Both of you are recorded.</p>
      <Field label="Supervisor email"><input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="PIN"><input className="input" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
      <div className="flex gap-2">
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary flex-1" disabled={!email || pin.length < 4 || m.isPending} onClick={() => m.mutate()}>Approve</button>
      </div>
    </Modal>
  );
}

export { parseScaled, useMemo };
