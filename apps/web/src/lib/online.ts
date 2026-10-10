import { useSyncExternalStore } from 'react';
import { API_URL } from './api';

/**
 * Tracks whether the ServeOS server can be reached. `navigator.onLine` alone is not enough
 * (Wi-Fi can be up while the internet is down), so while offline we probe the health endpoint.
 */
let online = typeof navigator === 'undefined' ? true : navigator.onLine;
const listeners = new Set<() => void>();
let probe: ReturnType<typeof setInterval> | null = null;

function set(next: boolean): void {
  if (online === next) return;
  online = next;
  listeners.forEach((l) => l());
  if (!next && !probe) probe = setInterval(checkServer, 5000);
  if (next && probe) {
    clearInterval(probe);
    probe = null;
  }
}

export async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/v1/health`, { cache: 'no-store' });
    set(res.ok);
  } catch {
    set(false);
  }
  return online;
}

/** Call when a request fails at the network level. */
export const reportOffline = (): void => set(false);
export const isOnline = (): boolean => online;

export function subscribeOnline(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void checkServer());
  window.addEventListener('offline', () => set(false));
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true);
}
