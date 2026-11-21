import { createContext, ReactNode, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError, get, Me } from './api';
import { Loading } from './ui';

const Ctx = createContext<Me | null>(null);

export const useMe = () => {
  const me = useContext(Ctx);
  if (!me) throw new Error('useMe outside session');
  return me;
};

export function useCan(...perms: string[]) {
  const me = useMe();
  return perms.some((p) => me.permissions.includes(p));
}
export const useHas = (feature: string) => useMe().features.includes(feature);

export function meQuery() {
  return { queryKey: ['me'], queryFn: () => get<Me>('/auth/me'), retry: false, staleTime: 60_000 };
}

/** Wraps shop screens: redirects to the sign-in page when there is no session. */
export function RequireShop({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const q = useQuery(meQuery());
  if (q.isLoading) return <Loading />;
  if (q.error instanceof ApiError && q.error.status === 401) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (q.error) return <div className="p-8 text-center text-red-600">{(q.error as Error).message}</div>;
  return <Ctx.Provider value={q.data!}>{children}</Ctx.Provider>;
}

/** Super Admin screens use their own cookie; probe an admin endpoint to learn if we are signed in. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ['admin-probe'], queryFn: () => get('/admin/plans'), retry: false });
  if (q.isLoading) return <Loading />;
  if (q.error) return <Navigate to="/admin/login" replace />;
  return <>{children}</>;
}
