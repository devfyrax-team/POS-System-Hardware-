export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

/** One shared refresh at a time; true when a new access cookie was issued. */
async function refresh(): Promise<boolean> {
  refreshing ??= fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

export interface Opts {
  headers?: Record<string, string>;
  noRefresh?: boolean;
}

export async function api<T = any>(method: string, path: string, body?: unknown, opts: Opts = {}): Promise<T> {
  const send = () =>
    fetch(`/v1${path}`, {
      method,
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let res = await send();
  if (res.status === 401 && !opts.noRefresh && !path.startsWith('/auth/') && !path.startsWith('/admin/auth/')) {
    if (await refresh()) res = await send();
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const j = (typeof data === 'object' ? data : {}) as any;
    throw new ApiError(res.status, j.code ?? 'ERROR', j.message ?? `Request failed (${res.status})`, j.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown, o?: Opts) => api<T>('POST', p, b ?? {}, o);
export const put = <T = any>(p: string, b?: unknown) => api<T>('PUT', p, b ?? {});
export const patch = <T = any>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});
export const del = <T = any>(p: string, b?: unknown) => api<T>('DELETE', p, b);

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface Me {
  user: { id: string; name: string; email: string; must_change_password: boolean };
  shop: { id: string; name: string; shop_type: 'hardware' | 'paint' | 'both' };
  session: { branchId?: string; terminalId?: string };
  permissions: string[];
  features: string[];
  limits: Record<string, number | null>;
  subscription: { status: string; plan: string };
  branchMode: { mode: 'single' | 'multi'; singleBranchId?: string };
}
