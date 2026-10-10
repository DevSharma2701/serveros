import { useQueryClient } from '@tanstack/react-query';
import type { PermissionKey } from '@serveos/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onSessionExpired, refreshSession, setAccessToken, setApiOutlet } from './api';
import type { Me, OutletRef } from './types';

const OUTLET_KEY = 'serveos.outlet';
const ME_CACHE_KEY = 'serveos.me';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthState {
  status: Status;
  me: Me | null;
  outlet: OutletRef | null;
  /** True when the profile came from the local cache because the server could not be reached. */
  offlineSession: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  selectOutlet(id: string): void;
  /** UI hint only: the server enforces every permission again on each request. */
  can(permission: PermissionKey): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

function readCachedMe(): Me | null {
  try {
    return JSON.parse(localStorage.getItem(ME_CACHE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletId] = useState<string | null>(() => localStorage.getItem(OUTLET_KEY));
  const [offlineSession, setOfflineSession] = useState(false);

  const adopt = useCallback((profile: Me, fromCache = false) => {
    setMe(profile);
    setOfflineSession(fromCache);
    // The cached profile holds no credentials: only names and permissions, so the POS can open offline.
    if (!fromCache) localStorage.setItem(ME_CACHE_KEY, JSON.stringify(profile));
    setOutletId((current) => {
      const valid = profile.outlets.find((o) => o.id === current)?.id ?? (profile.outlets.length === 1 ? profile.outlets[0]!.id : null);
      setApiOutlet(valid);
      return valid;
    });
    setStatus('authenticated');
  }, []);

  const signOutLocally = useCallback(() => {
    setAccessToken(null);
    setMe(null);
    setStatus('anonymous');
    localStorage.removeItem(ME_CACHE_KEY);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    onSessionExpired(signOutLocally);
    let cancelled = false;
    (async () => {
      const cached = readCachedMe();
      if (!navigator.onLine && cached) return adopt(cached, true);
      if (await refreshSession()) {
        const profile = await api<Me>('/auth/me');
        if (!cancelled) adopt(profile);
      } else if (!cancelled) {
        // Either signed out, or the server is unreachable. Only the second keeps the cached session.
        const reachable = await fetch(`${import.meta.env.VITE_API_URL ?? 'http://localhost:4000'}/api/v1/health`).then((r) => r.ok).catch(() => false);
        if (!reachable && cached) adopt(cached, true);
        else signOutLocally();
      }
    })().catch(() => !cancelled && signOutLocally());
    return () => {
      cancelled = true;
    };
  }, [adopt, signOutLocally]);

  // When the connection returns, swap an offline session for a real one.
  useEffect(() => {
    if (!offlineSession) return;
    const restore = async () => {
      if (await refreshSession()) adopt(await api<Me>('/auth/me'));
    };
    window.addEventListener('online', restore);
    return () => window.removeEventListener('online', restore);
  }, [offlineSession, adopt]);

  const value = useMemo<AuthState>(() => {
    const outlet = me?.outlets.find((o) => o.id === outletId) ?? null;
    const permissions = new Set<string>([...(me?.permissions ?? []), ...((outletId && me?.outletPermissions[outletId]) || [])]);
    return {
      status,
      me,
      outlet,
      offlineSession,
      async login(email, password) {
        const tokens = await api<{ accessToken: string }>('/auth/login', { method: 'POST', body: { email, password, client: 'web' }, outletId: null });
        setAccessToken(tokens.accessToken);
        adopt(await api<Me>('/auth/me', { outletId: null }));
      },
      async logout() {
        await api('/auth/logout', { method: 'POST', outletId: null }).catch(() => undefined);
        signOutLocally();
      },
      selectOutlet(id) {
        if (!me?.outlets.some((o) => o.id === id)) return;
        localStorage.setItem(OUTLET_KEY, id);
        setApiOutlet(id);
        setOutletId(id);
        queryClient.clear(); // never show one outlet's data under another outlet's name
      },
      can: (permission) => permissions.has(permission),
    };
  }, [status, me, outletId, offlineSession, adopt, signOutLocally, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The selected outlet; pages that render inside the app shell always have one. */
export function useOutlet(): OutletRef {
  const { outlet } = useAuth();
  if (!outlet) throw new Error('No outlet selected');
  return outlet;
}
