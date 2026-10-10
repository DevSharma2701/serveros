import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import { byNewestReady, byOldestFired } from './format';
import type { BoardView, BumpStatus, Station, Ticket, TicketItem } from './types';

export interface Board {
  /** null until the first successful load. */
  active: Ticket[] | null;
  /** Tickets marked ready in the last two hours; loaded only while that view is open. */
  recent: Ticket[] | null;
  stations: Station[];
  /** Why the last refresh failed, or null if it succeeded. */
  loadError: string | null;
  /** False once a request failed at the network level, until one succeeds again. */
  reachable: boolean;
  lastUpdated: number | null;
  /** Ids of tickets with a change in flight. */
  busy: ReadonlySet<string>;
  actionError: string | null;
  refresh(): Promise<void>;
  setStatus(ticket: Ticket, status: BumpStatus): Promise<void>;
  setItemPrepared(ticket: Ticket, item: TicketItem, isPrepared: boolean): Promise<void>;
  dismissActionError(): void;
}

/**
 * The ticket board's data. The API is the only source of truth: nothing is changed on screen
 * until the server has answered, and every hint, poll, reconnect and mutation ends in a refetch.
 *
 * `onNewTickets` is called with active tickets that were not on the board before (never for
 * the first load), so the page can flash them and sound the alert.
 */
export function useBoard(outletId: string, view: BoardView, onNewTickets: (tickets: Ticket[]) => void): Board {
  const [active, setActive] = useState<Ticket[] | null>(null);
  const [recent, setRecent] = useState<Ticket[] | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reachable, setReachable] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const alive = useRef(true);
  const seen = useRef<Set<string> | null>(null); // every ticket id shown as active so far
  const stationsLoaded = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const notify = useRef(onNewTickets);
  notify.current = onNewTickets;

  const load = useCallback(async (): Promise<void> => {
    const tickets = (scope: BoardView) => api<Ticket[]>('/kitchen/tickets', { query: { scope }, outletId });
    try {
      const [nextActive, nextRecent] = await Promise.all([tickets('active'), viewRef.current === 'recent' ? tickets('recent') : null]);
      if (!alive.current) return;
      setActive([...nextActive].sort(byOldestFired));
      if (nextRecent) setRecent([...nextRecent].sort(byNewestReady));
      setLoadError(null);
      setReachable(true);
      setLastUpdated(Date.now());

      const known = seen.current;
      seen.current = new Set([...(known ?? []), ...nextActive.map((t) => t.id)]);
      const fresh = known ? nextActive.filter((t) => !known.has(t.id)) : [];
      if (fresh.length) notify.current(fresh);

      // Stations rarely change: load them once, but keep trying until that has worked.
      if (!stationsLoaded.current) {
        const list = await api<Station[]>('/kitchen/stations', { outletId });
        stationsLoaded.current = true;
        if (alive.current) setStations(list.filter((s) => s.isActive !== false));
      }
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.isNetwork) setReachable(false);
      setLoadError(errorMessage(err));
    }
  }, [outletId]);

  /** Coalesces bursts (two socket events arrive per change): at most one extra run is queued. */
  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    inFlight.current = load().finally(() => {
      inFlight.current = null;
      if (again.current && alive.current) {
        again.current = false;
        void refresh();
      }
    });
    return inFlight.current;
  }, [load]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Initial load, and again when the view changes (the "recent" list is only read on demand).
  useEffect(() => void refresh(), [refresh, view]);

  // The browser knows first when the network cable is pulled or comes back.
  useEffect(() => {
    // Also re-check at once: a request already on the wire may still succeed and flip the
    // state back to reachable, and the next poll could be 20 s away.
    const offline = () => {
      setReachable(false);
      void refresh();
    };
    const online = () => void refresh();
    const visible = () => document.visibilityState === 'visible' && void refresh();
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  /** Puts the server's version of one ticket where it now belongs. */
  const apply = useCallback((ticket: Ticket) => {
    seen.current?.add(ticket.id); // a ticket we recalled ourselves is not a "new order"
    const isActive = ticket.status === 'PENDING' || ticket.status === 'PREPARING';
    setActive((list) => list && [...list.filter((t) => t.id !== ticket.id), ...(isActive ? [ticket] : [])].sort(byOldestFired));
    setRecent((list) => list && [...list.filter((t) => t.id !== ticket.id), ...(ticket.status === 'READY' ? [ticket] : [])].sort(byNewestReady));
  }, []);

  const mutate = useCallback(
    async (ticket: Ticket, path: string, body: unknown): Promise<void> => {
      const mark = (on: boolean) =>
        setBusy((current) => {
          const next = new Set(current);
          if (on) next.add(ticket.id);
          else next.delete(ticket.id);
          return next;
        });
      mark(true);
      setActionError(null);
      try {
        const updated = await api<Ticket>(path, { method: 'PATCH', body, outletId });
        if (alive.current) apply(updated);
      } catch (err) {
        if (!alive.current) return;
        if (err instanceof ApiError && err.isNetwork) setReachable(false);
        setActionError(`Ticket ${ticket.ticketNumber} was not updated: ${errorMessage(err)}`);
      } finally {
        if (alive.current) mark(false);
      }
      // Success or failure, re-read the truth (other tickets of the order may have moved too).
      await refresh();
    },
    [apply, outletId, refresh],
  );

  return {
    active,
    recent,
    stations,
    loadError,
    reachable,
    lastUpdated,
    busy,
    actionError,
    refresh,
    setStatus: useCallback((ticket: Ticket, status: BumpStatus) => mutate(ticket, `/kitchen/tickets/${ticket.id}`, { status }), [mutate]),
    setItemPrepared: useCallback((ticket: Ticket, item: TicketItem, isPrepared: boolean) => mutate(ticket, `/kitchen/tickets/${ticket.id}/items/${item.id}`, { isPrepared }), [mutate]),
    dismissActionError: useCallback(() => setActionError(null), []),
  };
}
