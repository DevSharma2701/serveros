import { REALTIME_EVENTS } from '@serveos/shared';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, getAccessToken, recoverSession } from './api';

const RETRY_MS = 5000;

/**
 * Keeps the board live. Socket messages are only hints: each one (and every successful
 * (re)connect) calls `onHint`, which re-reads the authoritative ticket list from the API.
 * Anything that happened while the socket was down is therefore picked up on reconnect.
 *
 * Returns true only while connected AND subscribed to the outlet's room.
 */
export function useRealtime(outletId: string, onHint: () => void): boolean {
  const [connected, setConnected] = useState(false);
  const hint = useRef(onHint);
  hint.current = onHint;

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const socket = io(API_URL, { auth: (cb) => cb({ token: getAccessToken() }), transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });

    socket.on('connect', () => {
      socket.emit('subscribe', { outletId }, (res: { ok: boolean } | undefined) => {
        if (!closed) setConnected(!!res?.ok);
      });
      // Refetch on every (re)connect, whether or not the subscription ack has arrived yet.
      hint.current();
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err: Error) => {
      setConnected(false);
      if (err.message !== 'Not authenticated') return; // transport error: socket.io retries by itself
      // The access token expired. A handshake refused by the server is not retried by
      // socket.io (socket.active is false then), so reconnect explicitly with the new token.
      void recoverSession().then((result) => {
        if (closed || result === 'denied' || socket.active) return;
        retry = setTimeout(() => socket.connect(), result === 'ok' ? 0 : RETRY_MS);
      });
    });
    socket.on(REALTIME_EVENTS.ticketChanged, () => hint.current());
    socket.on(REALTIME_EVENTS.orderChanged, () => hint.current());

    return () => {
      closed = true;
      clearTimeout(retry);
      socket.close();
      setConnected(false);
    };
  }, [outletId]);

  return connected;
}
