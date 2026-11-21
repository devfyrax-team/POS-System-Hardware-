import { create } from 'zustand';
import { lineCents } from './money';

// ---------- toasts ----------
export interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}
let toastId = 0;
export const useToasts = create<{ toasts: Toast[]; push: (kind: Toast['kind'], text: string) => void; dismiss: (id: number) => void }>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
export const toast = {
  ok: (t: string) => useToasts.getState().push('ok', t),
  error: (t: string) => useToasts.getState().push('error', t),
};

// ---------- POS cart (lives only on the till) ----------
export interface CartLine {
  key: string;
  productId: string;
  name: string;
  unitId?: string;
  unit: string;
  unitOptions?: { id: string; unit: string }[];
  decimalQty: boolean;
  qty: string;
  price: string; // shelf price per selling unit (preview only; the server decides)
  discount: string; // amount off this line
  priceOverride?: string;
  batchId?: string;
  stock?: string;
}

export interface CartCustomer {
  id: string;
  name: string;
  type: string;
  balance?: string;
  credit_limit?: string;
}

interface CartState {
  lines: CartLine[];
  customer: CartCustomer | null;
  billDiscount: string;
  approvals: Record<string, string>;
  attempt: { key: string; hash: string } | null;
  add: (l: Omit<CartLine, 'key' | 'qty' | 'discount'> & { qty?: string }) => void;
  setQty: (key: string, qty: string) => void;
  setLine: (key: string, patch: Partial<CartLine>) => void;
  remove: (key: string) => void;
  setCustomer: (c: CartCustomer | null) => void;
  setBillDiscount: (v: string) => void;
  setApproval: (action: string, token: string) => void;
  clear: () => void;
  load: (s: Partial<Pick<CartState, 'lines' | 'customer' | 'billDiscount'>>) => void;
  keyFor: (hash: string) => string;
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export const useCart = create<CartState>((set, get) => ({
  lines: [],
  customer: null,
  billDiscount: '0',
  approvals: {},
  attempt: null,
  add: (l) =>
    set((s) => {
      const same = s.lines.find((x) => x.productId === l.productId && x.unitId === l.unitId && !x.priceOverride && !x.batchId);
      if (same) return { lines: s.lines.map((x) => (x === same ? { ...x, qty: String(Number(x.qty) + Number(l.qty ?? 1)) } : x)) };
      return { lines: [...s.lines, { ...l, key: uid(), qty: l.qty ?? '1', discount: '0' }] };
    }),
  setQty: (key, qty) => set((s) => ({ lines: s.lines.map((x) => (x.key === key ? { ...x, qty } : x)) })),
  setLine: (key, patch) => set((s) => ({ lines: s.lines.map((x) => (x.key === key ? { ...x, ...patch } : x)) })),
  remove: (key) => set((s) => ({ lines: s.lines.filter((x) => x.key !== key) })),
  setCustomer: (customer) => set({ customer }),
  setBillDiscount: (billDiscount) => set({ billDiscount }),
  setApproval: (action, token) => set((s) => ({ approvals: { ...s.approvals, [action]: token } })),
  clear: () => set({ lines: [], customer: null, billDiscount: '0', approvals: {}, attempt: null }),
  load: (p) => set({ lines: [], customer: null, billDiscount: '0', approvals: {}, attempt: null, ...p }),
  // The same bill retried keeps its idempotency key (no duplicate sale); a changed bill gets a new one.
  keyFor: (hash) => {
    const a = get().attempt;
    if (a && a.hash === hash) return a.key;
    const key = uid();
    set({ attempt: { key, hash } });
    return key;
  },
}));

export const cartTotalCents = (lines: CartLine[], billDiscount = '0'): bigint => {
  const sum = lines.reduce((a, l) => a + lineCents(l.priceOverride ?? l.price, l.qty, l.discount), 0n);
  const d = lineCents('1', billDiscount);
  return sum - d < 0n ? 0n : sum - d;
};
