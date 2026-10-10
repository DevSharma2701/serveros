import { vi } from 'vitest';
import type { Station, Ticket, TicketItem } from '../lib/types';

export const OUTLET = { id: 'outlet-1', name: 'Indiranagar', code: 'BLR1' };
export const GRILL: Station = { id: 'st-grill', key: 'GRILL', name: 'Grill & tandoor', isActive: true };
export const BEVERAGE: Station = { id: 'st-bev', key: 'BEVERAGE', name: 'Beverages', isActive: true };

let nextId = 1;
export const item = (name: string, patch: Partial<TicketItem> = {}): TicketItem => ({ id: `item-${nextId++}`, name, quantity: 1, modifiers: '', notes: '', isPrepared: false, isCancelled: false, ...patch });

/** A ticket fired `ageMinutes` before the (faked) current time. */
export function ticket(number: string, station: Station, ageMinutes: number, patch: Partial<Ticket> = {}): Ticket {
  return {
    id: `ticket-${number}`,
    orderId: `order-${number}`,
    stationId: station.id,
    station,
    ticketNumber: number,
    status: 'PENDING',
    orderType: 'DINE_IN',
    orderNumber: `260101-${number}`,
    tableLabel: 'T1',
    notes: '',
    firedAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    startedAt: null,
    readyAt: null,
    items: [item('Paneer Tikka')],
    ...patch,
  };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
  outletId: string | null;
}

/**
 * An in-memory stand-in for the kitchen API, installed as global fetch. It applies status
 * changes the way the real service does, so tests assert on what the "server" answered.
 */
export function fakeServer(tickets: Ticket[] = []) {
  const server = {
    tickets,
    stations: [GRILL, BEVERAGE],
    calls: [] as Call[],
    /** Simulates a dead network: every request rejects like a real failed fetch. */
    down: false,
    /** If set, the next PATCH is answered with this error instead of being applied. */
    failNextPatch: null as { status: number; code: string; message: string } | null,
    patches: (): Call[] => server.calls.filter((c) => c.method === 'PATCH'),
    ticketFetches: (): number => server.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/kitchen/tickets?scope=active')).length,
  };

  const respond = (status: number, body: unknown): Response =>
    ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(input);
      const path = url.pathname.replace('/api/v1', '');
      const method = init.method ?? 'GET';
      const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
      server.calls.push({ method, path: path + url.search, body, outletId: (init.headers as Record<string, string>)['X-Outlet-Id'] ?? null });
      if (server.down) throw new TypeError('Failed to fetch');

      if (method === 'GET' && path === '/kitchen/stations') return respond(200, server.stations);
      if (method === 'GET' && path === '/kitchen/tickets') {
        const wanted = url.searchParams.get('scope') === 'recent' ? ['READY'] : ['PENDING', 'PREPARING'];
        return respond(200, server.tickets.filter((t) => wanted.includes(t.status)));
      }
      const match = /^\/kitchen\/tickets\/([^/]+)(?:\/items\/([^/]+))?$/.exec(path);
      if (method === 'PATCH' && match) {
        if (server.failNextPatch) {
          const { status, ...error } = server.failNextPatch;
          server.failNextPatch = null;
          return respond(status, { error: { ...error, details: null, correlationId: 'test' } });
        }
        const found = server.tickets.find((t) => t.id === match[1]);
        if (!found) return respond(404, { error: { code: 'NOT_FOUND', message: 'Kitchen ticket not found' } });
        if (match[2]) {
          const { isPrepared } = body as { isPrepared: boolean };
          found.items = found.items.map((i) => (i.id === match[2] ? { ...i, isPrepared } : i));
          const open = found.items.filter((i) => !i.isCancelled);
          found.status = open.every((i) => i.isPrepared) ? 'READY' : 'PREPARING';
        } else {
          found.status = (body as { status: Ticket['status'] }).status;
          if (found.status === 'READY') found.items = found.items.map((i) => ({ ...i, isPrepared: true }));
        }
        found.readyAt = found.status === 'READY' ? new Date().toISOString() : null;
        return respond(200, structuredClone(found));
      }
      return respond(404, { error: { code: 'NOT_FOUND', message: `No route ${method} ${path}` } });
    }),
  );
  return server;
}
