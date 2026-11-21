import { ReactNode, useEffect } from 'react';
import { ApiError } from './api';
import { toast, useToasts } from './store';

export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'STOCK_SHORT' && e.details?.lines) return `Not enough stock: ${e.details.lines.map((l: any) => `${l.name} (only ${l.available} available)`).join(', ')}`;
    if (e.code === 'STOCK_SHORT' && e.details?.available !== undefined) return `Only ${e.details.available} available`;
    if (e.code === 'CREDIT_LIMIT') return `Credit limit exceeded. Available: ${e.details?.available}`;
    if (e.code === 'FEATURE_NOT_ENABLED') return `This feature is not enabled for your shop (${e.details?.feature ?? ''}). Contact support to turn it on.`;
    if (e.code === 'PLAN_LIMIT') return `Your plan limit was reached (${e.details?.resource}: ${e.details?.limit}).`;
    if (e.code === 'VALIDATION' && Array.isArray(e.details)) return `${e.message}: ${e.details.map((d: any) => `${d.path} ${d.message}`).join('; ')}`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export const fail = (e: unknown) => toast.error(errText(e));

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="fixed right-4 top-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} onClick={() => dismiss(t.id)} className={`cursor-pointer rounded-md px-4 py-3 text-sm shadow-lg ${t.kind === 'ok' ? 'bg-brand-700 text-white' : 'bg-red-600 text-white'}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-900/50 p-4 pt-16" onMouseDown={onClose}>
      <div className={`card w-full ${wide ? 'max-w-3xl' : 'max-w-md'} p-5`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-3 block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export function PageHeader({ title, children, sub }: { title: string; children?: ReactNode; sub?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {sub && <p className="text-sm text-slate-500">{sub}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-400">{children}</div>;
}

export function Loading() {
  return <div className="p-8 text-center text-sm text-slate-400">Loading…</div>;
}

export function Badge({ tone = 'slate', children }: { tone?: 'slate' | 'green' | 'red' | 'amber' | 'blue'; children: ReactNode }) {
  const c = { slate: 'bg-slate-100 text-slate-600', green: 'bg-emerald-100 text-emerald-700', red: 'bg-red-100 text-red-700', amber: 'bg-amber-100 text-amber-700', blue: 'bg-sky-100 text-sky-700' }[tone];
  return <span className={`badge ${c}`}>{children}</span>;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'red' | 'amber' }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : ''}`}>{value}</div>
    </div>
  );
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>{head.map((h, i) => <th key={i} className="th">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}
