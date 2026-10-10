import { useQueryClient } from '@tanstack/react-query';
import { REALTIME_EVENTS } from '@serveos/shared';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, getAccessToken, refreshSession } from './api';

/** Which cached queries each server event makes stale. */
const INVALIDATES: Record<string, string[]> = {
  [REALTIME_EVENTS.orderChanged]: ['orders', 'order', 'floor', 'shift', 'dashboard'],
  [REALTIME_EVENTS.ticketChanged]: ['kitchen'],
  [REALTIME_EVENTS.menuChanged]: ['catalog'],
  [REALTIME_EVENTS.floorChanged]: ['floor'],
};

/**
 * Keeps the screen live. Events are only hints: they mark queries stale and the data is
 * re-read from the API. After every (re)connect everything live is re-read, so anything
 * that happened while the socket was down is picked up.
 */
export function useRealtime(outletId: string | null): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!outletId) return;
    const socket = io(API_URL, { auth: (cb) => cb({ token: getAccessToken() }), transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });
    const refetch = (keys: string[]) => keys.forEach((key) => void queryClient.invalidateQueries({ queryKey: [key] }));

    socket.on('connect', () => {
      socket.emit('subscribe', { outletId }, (res: { ok: boolean }) => setConnected(!!res?.ok));
      refetch(['orders', 'order', 'floor', 'kitchen', 'catalog', 'shift']);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => {
      setConnected(false);
      // An expired access token. A handshake the server refused is not retried automatically,
      // so get a new token and connect again ourselves.
      if (err.message === 'Not authenticated') void refreshSession().then((ok) => ok && socket.connect());
    });
    for (const [event, keys] of Object.entries(INVALIDATES)) socket.on(event, () => refetch(keys));
    return () => {
      socket.close();
      setConnected(false);
    };
  }, [outletId, queryClient]);

  return connected;
}
