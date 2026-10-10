import { useQueryClient } from '@tanstack/react-query';
import { REALTIME_EVENTS } from '@serveos/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { io } from 'socket.io-client';
import { getAccessToken, refreshSession } from './api';
import { useAuth } from './auth';
import { API_URL } from './config';

/** Which cached queries each server event makes stale (first element of the query key). */
const INVALIDATES: Record<string, string[]> = {
  [REALTIME_EVENTS.orderChanged]: ['orders', 'order', 'dashboard', 'shifts'],
  [REALTIME_EVENTS.ticketChanged]: ['orders', 'order'],
  [REALTIME_EVENTS.menuChanged]: ['catalog'],
  [REALTIME_EVENTS.floorChanged]: ['orders'],
};
const LIVE_KEYS = ['orders', 'order', 'catalog', 'dashboard'];

const RealtimeContext = createContext(false);

/**
 * Keeps live screens fresh. Events are only hints: they mark queries stale and the data is
 * re-read from the API. After every (re)connect everything live is re-read, so anything that
 * happened while the socket was down (app in the background, no signal) is picked up.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { status, outlet } = useAuth();
  const outletId = status === 'authenticated' ? (outlet?.id ?? null) : null;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!outletId) return;
    const socket = io(API_URL, {
      auth: (cb) => cb({ token: getAccessToken() }),
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: 10_000,
    });
    const refetch = (keys: string[]) => keys.forEach((key) => void queryClient.invalidateQueries({ queryKey: [key] }));

    socket.on('connect', () => {
      socket.emit('subscribe', { outletId }, (res: { ok?: boolean } | undefined) => setConnected(!!res?.ok));
      refetch(LIVE_KEYS);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err: Error) => {
      setConnected(false);
      // An expired access token: get a new one; the socket then retries by itself.
      if (err.message === 'Not authenticated') void refreshSession();
    });
    for (const [event, keys] of Object.entries(INVALIDATES)) socket.on(event, () => refetch(keys));
    return () => {
      socket.close();
      setConnected(false);
    };
  }, [outletId, queryClient]);

  return <RealtimeContext.Provider value={connected}>{children}</RealtimeContext.Provider>;
}

/** True while the socket is connected and subscribed to the selected outlet. */
export const useRealtimeConnected = (): boolean => useContext(RealtimeContext);
