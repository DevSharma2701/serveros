import type { PermissionKey } from '@serveos/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onSessionExpired, refreshSession, setAccessToken, setApiOutlet } from './api';
import type { Me, OutletRef } from './types';

const OUTLET_KEY = 'serveos.kds.outlet';
/**
 * A non-secret marker that this device has signed in before. Without it we skip the refresh
 * call on start-up, which would only produce a 401 (and a console error) on a fresh device.
 */
const SESSION_HINT_KEY = 'serveos.kds.session';
const RETRY_MS = 5000;

const store = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked (private mode); the value then simply lasts until reload.
  }
};
const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** "unreachable": a session may exist but the server cannot be asked yet; we keep retrying. */
type Status = 'loading' | 'unreachable' | 'anonymous' | 'authenticated';

interface AuthState {
  status: Status;
  me: Me | null;
  outlet: OutletRef | null;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Pass null to go back to the outlet picker. */
  selectOutlet(id: string | null): void;
  /** UI hint only: the server enforces every permission again on each request. */
  can(permission: PermissionKey): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletId] = useState<string | null>(() => read(OUTLET_KEY));

  const adopt = useCallback((profile: Me) => {
    setMe(profile);
    store(SESSION_HINT_KEY, '1');
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
    store(SESSION_HINT_KEY, null);
    setStatus('anonymous');
  }, []);

  // Restore the session from the refresh cookie. If the server is down, keep trying rather
  // than showing a sign-in form that could not work anyway.
  useEffect(() => {
    onSessionExpired(signOutLocally);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restore = async (): Promise<void> => {
      if (!read(SESSION_HINT_KEY)) return signOutLocally();
      const result = await refreshSession();
      if (cancelled) return;
      if (result === 'denied') return signOutLocally();
      try {
        if (result === 'unreachable') throw new Error('unreachable');
        const profile = await api<Me>('/auth/me', { outletId: null });
        if (!cancelled) adopt(profile);
      } catch {
        if (cancelled) return;
        // api() has already signed us out if the server rejected the session; otherwise retry.
        setStatus((current) => (current === 'anonymous' ? current : 'unreachable'));
        timer = setTimeout(() => void restore(), RETRY_MS);
      }
    };
    void restore();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      onSessionExpired(null);
    };
  }, [adopt, signOutLocally]);

  const value = useMemo<AuthState>(() => {
    const outlet = me?.outlets.find((o) => o.id === outletId) ?? null;
    const permissions = new Set<string>([...(me?.permissions ?? []), ...((outletId && me?.outletPermissions?.[outletId]) || [])]);
    return {
      status,
      me,
      outlet,
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
        if (id && !me?.outlets.some((o) => o.id === id)) return;
        store(OUTLET_KEY, id);
        setApiOutlet(id);
        setOutletId(id);
      },
      can: (permission) => permissions.has(permission),
    };
  }, [status, me, outletId, adopt, signOutLocally]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
