import { useQueryClient } from '@tanstack/react-query';
import type { PermissionKey } from '@serveos/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onSessionExpired, refreshSession, setAccessToken, setApiOutlet } from './api';
import { clearRefreshToken, clearStoredOutlet, getRefreshToken, getStoredOutlet, saveRefreshToken, saveStoredOutlet } from './storage';
import type { Me, OutletRef, Tokens } from './types';

/**
 * loading: reading the stored session. anonymous: show the login screen.
 * unreachable: a session exists on this device but the server could not be reached to resume it.
 */
export type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'unreachable';

interface AuthState {
  status: AuthStatus;
  me: Me | null;
  outlet: OutletRef | null;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  selectOutlet(id: string): void;
  /** Tries again to resume the stored session (used by the "cannot reach server" screen). */
  retry(): void;
  /** Re-reads the profile (permissions and outlets can change while the app is open). */
  reloadProfile(): Promise<void>;
  /** UI hint only: the server enforces every permission again on each request. */
  can(permission: PermissionKey): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [outletId, setOutletId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const adopt = useCallback(async (profile: Me) => {
    const stored = await getStoredOutlet();
    const valid = profile.outlets.find((o) => o.id === stored)?.id ?? (profile.outlets.length === 1 ? profile.outlets[0]!.id : null);
    setApiOutlet(valid);
    setOutletId(valid);
    setMe(profile);
    setStatus('authenticated');
  }, []);

  const signOutLocally = useCallback(() => {
    setAccessToken(null);
    setApiOutlet(null);
    setMe(null);
    setOutletId(null);
    setStatus('anonymous');
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    onSessionExpired(() => {
      void clearRefreshToken();
      signOutLocally();
    });
    return () => onSessionExpired(null);
  }, [signOutLocally]);

  // Resume the session stored on this device, if there is one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!(await getRefreshToken())) {
        if (!cancelled) signOutLocally();
        return;
      }
      const result = await refreshSession();
      if (cancelled) return;
      if (result === 'invalid') return signOutLocally();
      if (result === 'unreachable') return setStatus('unreachable');
      const profile = await api<Me>('/auth/me', { outletId: null });
      if (!cancelled) await adopt(profile);
    })().catch(() => {
      if (!cancelled) setStatus((current) => (current === 'loading' ? 'unreachable' : current));
    });
    return () => {
      cancelled = true;
    };
  }, [adopt, signOutLocally, attempt]);

  const value = useMemo<AuthState>(() => {
    const outlet = me?.outlets.find((o) => o.id === outletId) ?? null;
    const permissions = new Set<string>([...(me?.permissions ?? []), ...((outletId && me?.outletPermissions[outletId]) || [])]);
    return {
      status,
      me,
      outlet,
      async login(email, password) {
        const tokens = await api<Tokens>('/auth/login', { method: 'POST', body: { email, password, client: 'mobile' }, outletId: null });
        await saveRefreshToken(tokens.refreshToken);
        setAccessToken(tokens.accessToken);
        await adopt(await api<Me>('/auth/me', { outletId: null }));
      },
      async logout() {
        await api('/auth/logout', { method: 'POST', outletId: null }).catch(() => undefined);
        await clearRefreshToken();
        await clearStoredOutlet();
        signOutLocally();
      },
      selectOutlet(id) {
        if (!me?.outlets.some((o) => o.id === id)) return;
        void saveStoredOutlet(id);
        setApiOutlet(id);
        setOutletId(id);
        queryClient.clear(); // never show one outlet's data under another outlet's name
      },
      retry() {
        setStatus('loading');
        setAttempt((n) => n + 1);
      },
      async reloadProfile() {
        setMe(await api<Me>('/auth/me', { outletId: null }));
      },
      can: (permission) => permissions.has(permission),
    };
  }, [status, me, outletId, adopt, signOutLocally, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
