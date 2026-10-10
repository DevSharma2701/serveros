/**
 * HTTP client for the ServeOS API.
 *
 * - The access token lives only in memory (never in localStorage), so scripts injected into
 *   the page cannot steal a long-lived credential. The refresh token is an httpOnly cookie.
 * - A 401 triggers one silent refresh and one retry; concurrent requests share that refresh.
 * - Network failures surface as ApiError with code "NETWORK" so callers can go offline-aware.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const BASE = `${API_URL}/api/v1`;

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
let refreshing: Promise<boolean> | null = null;
let onSignedOut: (() => void) | null = null;

export const getAccessToken = (): string | null => accessToken;
export const setAccessToken = (token: string | null): void => void (accessToken = token);
export const setApiOutlet = (id: string | null): void => void (outletId = id);
export const getApiOutlet = (): string | null => outletId;
export const onSessionExpired = (handler: () => void): void => void (onSignedOut = handler);

/** Exchanges the refresh cookie for a new access token. Shared by all callers that need it at once. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(async (res) => {
      if (!res.ok) return false;
      accessToken = (await res.json()).accessToken;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Makes a retried create/pay request safe: the server returns the first result again. */
  idempotencyKey?: string;
  /** Overrides the selected outlet for this call (null sends no outlet header). */
  outletId?: string | null;
  signal?: AbortSignal;
  /** Return the raw text (CSV downloads) instead of parsing JSON. */
  asText?: boolean;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const outlet = options.outletId === undefined ? outletId : options.outletId;
  if (outlet) headers['X-Outlet-Id'] = outlet;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const query = Object.entries(options.query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const url = `${BASE}${path}${query.length ? `?${new URLSearchParams(query.map(([k, v]) => [k, String(v)]))}` : ''}`;
  try {
    return await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      signal: options.signal,
      body: options.body === undefined ? undefined : isForm ? (options.body as FormData) : JSON.stringify(options.body),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options);
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    if (await refreshSession()) res = await send(path, options);
    else onSignedOut?.();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const error = body?.error;
    throw new ApiError(res.status, error?.code ?? 'REQUEST_FAILED', error?.message ?? `Request failed (${res.status})`, error?.details, error?.correlationId);
  }
  if (res.status === 204) return undefined as T;
  if (options.asText) return (await res.text()) as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** A unique key for one user action (one order attempt, one payment attempt). */
export function newKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Turns any thrown value into a sentence fit to show a user. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const fields = Array.isArray(err.details) ? (err.details as Array<{ path: string; message: string }>).map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)) : [];
    return fields.length ? `${err.message}: ${fields.join('; ')}` : err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Full URL for a file path returned by the API (for example an uploaded product image). */
export const assetUrl = (path: string | null | undefined): string | undefined => (path ? (path.startsWith('http') ? path : `${API_URL}${path}`) : undefined);
