import { ReactNode, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../../api';
import { money, qtyText } from '../../money';

export interface Product {
  id: string;
  name: string;
  sku: string;
  short_code?: string;
  base_unit: string;
  decimal_qty: boolean;
  price: string | null;
  stock: string;
  track_batches?: boolean;
  category?: string;
  favourite?: boolean;
  needs_review?: boolean;
  version?: number;
  min_level?: string;
}

/** Type to search the shop's products; pick one. Used wherever a form needs "an item". */
export function ProductPicker({ onPick, placeholder = 'Search item by name, SKU or code' }: { onPick: (p: Product) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const r = useQuery({ queryKey: ['picker', debounced], queryFn: () => get<Product[]>(`/products/search${qs({ q: debounced, limit: 8 })}`), enabled: debounced.length > 0 });
  return (
    <div className="relative">
      <input className="input" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {debounced && r.data && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {r.data.length === 0 && <div className="p-3 text-sm text-slate-400">No match</div>}
          {r.data.map((p) => (
            <button key={p.id} type="button" className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-brand-50" onClick={() => { onPick(p); setQ(''); setDebounced(''); }}>
              <span>{p.name}<span className="ml-2 text-xs text-slate-400">{p.sku}</span></span>
              <span className="text-xs text-slate-400">{p.price ? money(p.price) : 'no price'} · {qtyText(p.stock)} {p.base_unit}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: ReactNode }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${value === t.key ? 'border-brand-700 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const today = () => new Date().toISOString().slice(0, 10);
export const dateText = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '');
export const dateTimeText = (d?: string | null) => (d ? new Date(d).toLocaleString() : '');
export const pickNum = (s: string) => s.replace(/[^\d.]/g, '');
