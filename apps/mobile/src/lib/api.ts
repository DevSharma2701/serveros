/**
 * HTTP client for the ServeOS API (mobile).
 *
 * - The access token lives only in memory. The refresh token lives only in SecureStore.
 * - A 401 triggers ONE refresh shared by every request in flight (single-flight), then one retry.
 *   Refresh tokens rotate: the new one is saved before anything else, the old one is dead.
 * - If the refresh token is rejected the user is signed out. If the server simply cannot be
 *   reached the session is kept and the request fails with code "NETWORK".
 * - All API errors look like { error: { code, message, details, correlationId } }.
 */
import { API_BASE } from './config';
import { clearRefreshToken, getRefreshToken, saveRefreshToken } from './storage';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isNetwork(): boolean {
    return this.code === 'NETWORK';
  }
}

let accessToken: string | null = null;
let outletId: string | null = null;
let refreshing: Promise<RefreshResult> | null = null;
let onSignedOut: (() => void) | null = null;

export const getAccessToken = (): string | null => accessToken;
export const setAccessToken = (token: string | null): void => void (accessToken = token);
export const setApiOutlet = (id: string | null): void => void (outletId = id);
export const getApiOutlet = (): string | null => outletId;
export const onSessionExpired = (handler: (() => void) | null): void => void (onSignedOut = handler);

/** ok: new tokens are in place. invalid: the session is over. unreachable: try again later. */
export type RefreshResult = 'ok' | 'invalid' | 'unreachable';

async function doRefresh(): Promise<RefreshResult> {
  const stored = await getRefreshToken();
  if (!stored) return 'invalid';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: stored }),
    });
  } catch {
    return 'unreachable';
  }
  if (res.status === 400 || res.status === 401) {
    accessToken = null;
    await clearRefreshToken();
    return 'invalid';
  }
  if (!res.ok) return 'unreachable'; // rate limited or server error: the stored token is still good
  const body = (await res.json().catch(() => null)) as { accessToken?: string; refreshToken?: string } | null;
  if (!body?.accessToken || !body.refreshToken) return 'unreachable';
  // The server has already rotated the token: persist the new one before using anything.
  await saveRefreshToken(body.refreshToken);
  accessToken = body.accessToken;
  return 'ok';
}

/** Exchanges the stored refresh token for new tokens. Concurrent callers share one request. */
export function refreshSession(): Promise<RefreshResult> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Overrides the selected outlet for this call (null sends no X-Outlet-Id header). */
  outletId?: string | null;
  signal?: AbortSignal;
}

const networkError = (): ApiError => new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const outlet = options.outletId === undefined ? outletId : options.outletId;
  if (outlet) headers['X-Outlet-Id'] = outlet;

  const query = Object.entries(options.query ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  const url = `${API_BASE}${path}${query.length ? `?${query.join('&')}` : ''}`;
  try {
    return await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      signal: options.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (err) {
    if ((err as Error | undefined)?.name === 'AbortError') throw err;
    throw networkError();
  }
}

const isAuthExchange = (path: string): boolean => path.startsWith('/auth/login') || path.startsWith('/auth/refresh');

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options);
  if (res.status === 401 && !isAuthExchange(path)) {
    const result = await refreshSession();
    if (result === 'ok') res = await send(path, options);
    else if (result === 'unreachable') throw networkError();
    else onSignedOut?.();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown; correlationId?: string } } | null;
    const error = body?.error;
    throw new ApiError(res.status, error?.code ?? 'REQUEST_FAILED', error?.message ?? `Request failed (${res.status})`, error?.details, error?.correlationId);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Turns any thrown value into a sentence fit to show a user. Prefers the API's own message. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const fields = Array.isArray(err.details)
      ? (err.details as Array<{ path?: string; message?: string }>).map((d) => (d.path ? `${d.path}: ${d.message ?? ''}` : String(d.message ?? ''))).filter(Boolean)
      : [];
    return fields.length ? `${err.message}: ${fields.join('; ')}` : err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

export const isForbidden = (err: unknown): boolean => err instanceof ApiError && err.status === 403;
