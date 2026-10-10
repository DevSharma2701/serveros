/**
 * HTTP client for the ServeOS API (adapted from the POS web app; the KDS builds on its own).
 *
 * - The access token lives only in memory; the refresh token is an httpOnly cookie.
 * - A 401 triggers one silent refresh and one retry; concurrent requests share that refresh.
 * - Network failures surface as ApiError with code "NETWORK" so the board can show "offline".
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

/**
 * "denied" means the server said the session is over; "unreachable" means we could not ask.
 * The difference matters on a kitchen wall: a Wi-Fi blip must never throw the screen back to
 * the sign-in page, where nobody would see incoming orders.
 */
export type RefreshResult = 'ok' | 'denied' | 'unreachable';

let accessToken: string | null = null;
let outletId: string | null = null;
let refreshing: Promise<RefreshResult> | null = null;
let onSignedOut: (() => void) | null = null;

export const getAccessToken = (): string | null => accessToken;
export const setAccessToken = (token: string | null): void => void (accessToken = token);
export const setApiOutlet = (id: string | null): void => void (outletId = id);
export const onSessionExpired = (handler: (() => void) | null): void => void (onSignedOut = handler);

/** Exchanges the refresh cookie for a new access token. Shared by all callers that need it at once. */
export function refreshSession(): Promise<RefreshResult> {
  refreshing ??= fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(async (res): Promise<RefreshResult> => {
      if (res.status === 401 || res.status === 403) return 'denied';
      if (!res.ok) return 'unreachable'; // 5xx or proxy error: the session may still be fine
      accessToken = ((await res.json()) as { accessToken: string }).accessToken;
      return 'ok';
    })
    .catch((): RefreshResult => 'unreachable')
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** Refreshes the session and signs the user out locally only if the server refused it. */
export async function recoverSession(): Promise<RefreshResult> {
  const result = await refreshSession();
  if (result === 'denied') onSignedOut?.();
  return result;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Overrides the selected outlet for this call (null sends no outlet header). */
  outletId?: string | null;
}

const networkError = (): ApiError => new ApiError(0, 'NETWORK', 'Cannot reach the server. Check the network connection.');

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const outlet = options.outletId === undefined ? outletId : options.outletId;
  if (outlet) headers['X-Outlet-Id'] = outlet;

  const query = Object.entries(options.query ?? {}).filter((entry): entry is [string, string] => !!entry[1]);
  const url = `${BASE}${path}${query.length ? `?${new URLSearchParams(query)}` : ''}`;
  try {
    return await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw networkError();
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown; correlationId?: string };
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options);
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    const refreshed = await recoverSession();
    if (refreshed === 'ok') res = await send(path, options);
    else if (refreshed === 'unreachable') throw networkError();
  }
  if (!res.ok) {
    const error = ((await res.json().catch(() => null)) as ErrorBody | null)?.error;
    throw new ApiError(res.status, error?.code ?? 'REQUEST_FAILED', error?.message ?? `Request failed (${res.status})`, error?.details, error?.correlationId);
  }
  const text = res.status === 204 ? '' : await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Turns any thrown value into a sentence fit to show on the board. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
