import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BEVERAGE, fakeServer, GRILL, item, OUTLET, ticket } from '../test/fake-server';
import { BoardPage, POLL_DEGRADED_MS, POLL_LIVE_MS } from './BoardPage';

/** A hand-driven Socket.IO client: tests decide when it connects, drops and receives events. */
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const fake = {
    active: true,
    emitted: [] as Array<{ event: string; payload: unknown }>,
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return fake;
    },
    emit(event: string, payload: unknown, ack?: (res: { ok: boolean }) => void) {
      fake.emitted.push({ event, payload });
      ack?.({ ok: true });
    },
    connect() {},
    close() {},
    /** Delivers a server-side event to the app. */
    fire(event: string, ...args: unknown[]) {
      handlers.get(event)?.forEach((handler) => handler(...args));
    },
    reset() {
      handlers.clear();
      fake.emitted.length = 0;
    },
  };
  return fake;
});
vi.mock('socket.io-client', () => ({ io: () => socket }));

/** Lets pending requests and their state updates settle, then moves the clock by `ms`. */
const tick = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const fire = (event: string, ...args: unknown[]) =>
  act(async () => {
    socket.fire(event, ...args);
    await vi.advanceTimersByTimeAsync(0);
  });

async function renderBoard(canUpdate = true) {
  render(<BoardPage outlet={OUTLET} userName="Vikram" canUpdate={canUpdate} onSignOut={() => undefined} />);
  await tick();
}
const card = (number: string) => screen.getByRole('article', { name: `Ticket ${number}` });
const queryCard = (number: string) => screen.queryByRole('article', { name: `Ticket ${number}` });
const connection = () => screen.getByRole('status').textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  localStorage.clear();
  socket.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ticket appearance', () => {
  it('shows a ticket from the API with items, modifiers, notes and a ticking age', async () => {
    fakeServer([
      ticket('K0001', GRILL, 5, {
        orderType: 'DINE_IN',
        tableLabel: 'P2',
        notes: 'Allergy: nuts',
        items: [item('Paneer Tikka', { quantity: 2, modifiers: 'Spicy, Extra butter', notes: 'well done' }), item('Tandoori Roti', { quantity: 4 })],
      }),
    ]);
    await renderBoard();

    const k1 = within(card('K0001'));
    expect(k1.getByText('Dine-in')).toBeInTheDocument();
    expect(k1.getByText('Table P2')).toBeInTheDocument();
    expect(k1.getByText('Grill & tandoor')).toBeInTheDocument();
    expect(k1.getByText('Order 260101-K0001')).toBeInTheDocument();
    expect(k1.getByText('Waiting')).toBeInTheDocument();
    expect(k1.getByText('2×')).toBeInTheDocument();
    expect(k1.getByText('Paneer Tikka')).toBeInTheDocument();
    expect(k1.getByText('+ Spicy, Extra butter')).toBeInTheDocument();
    expect(k1.getByText('well done')).toBeInTheDocument();
    expect(k1.getByText('4×')).toBeInTheDocument();
    expect(k1.getByText('Tandoori Roti')).toBeInTheDocument();
    // The order note mentions an allergy, so it is labelled as one rather than as a plain note.
    expect(k1.getByText('Allergy:')).toBeInTheDocument();
    expect(k1.getByText('Allergy: nuts')).toBeInTheDocument();

    expect(k1.getByTestId('age')).toHaveTextContent('05:00');
    await tick(1000);
    expect(k1.getByTestId('age')).toHaveTextContent('05:01');
  });

  it('puts the oldest ticket first and labels late and overdue tickets in words', async () => {
    fakeServer([ticket('K0003', GRILL, 1), ticket('K0001', GRILL, 16), ticket('K0002', GRILL, 9)]);
    await renderBoard();

    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Ticket K0001', 'Ticket K0002', 'Ticket K0003']);
    expect(within(card('K0001')).getByText('OVERDUE')).toBeInTheDocument();
    expect(within(card('K0002')).getByText('LATE')).toBeInTheDocument();
    expect(within(card('K0003')).queryByText(/OVERDUE|LATE/)).toBeNull();
  });

  it('uses the thresholds saved on this device', async () => {
    localStorage.setItem('serveos.kds.settings', JSON.stringify({ warnMinutes: 2, overdueMinutes: 4 }));
    fakeServer([ticket('K0001', GRILL, 5), ticket('K0002', GRILL, 3)]);
    await renderBoard();

    expect(within(card('K0001')).getByText('OVERDUE')).toBeInTheDocument();
    expect(within(card('K0002')).getByText('LATE')).toBeInTheDocument();
  });

  it('says so when there is nothing to cook', async () => {
    fakeServer([]);
    await renderBoard();
    expect(screen.getByText('No tickets - all caught up')).toBeInTheDocument();
  });

  it('shows an error with a retry when the first load is refused', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 1)]);
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL', message: 'Database is down' } }) }) as Response);
    await renderBoard();
    expect(screen.getByText('Could not load tickets')).toBeInTheDocument();
    expect(screen.getByText('Database is down')).toBeInTheDocument();

    vi.stubGlobal('fetch', realFetch);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await tick();
    expect(card('K0001')).toBeInTheDocument();
    expect(server.ticketFetches()).toBe(1);
  });
});

describe('station routing and filters', () => {
  it('shows only the chosen station, remembers the choice, and can filter by order type', async () => {
    fakeServer([ticket('K0001', GRILL, 3), ticket('K0002', BEVERAGE, 2, { orderType: 'TAKEAWAY', tableLabel: '' }), ticket('K0003', GRILL, 1, { orderType: 'TAKEAWAY', tableLabel: '' })]);
    await renderBoard();
    expect(screen.getAllByRole('article')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Beverages' }));
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Ticket K0002']);
    expect(screen.getByRole('button', { name: 'Beverages' })).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(localStorage.getItem('serveos.kds.settings')!)).toMatchObject({ stationId: BEVERAGE.id });

    fireEvent.click(screen.getByRole('button', { name: 'Grill & tandoor' }));
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Ticket K0001', 'Ticket K0003']);

    fireEvent.click(screen.getByRole('button', { name: 'Takeaway' }));
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Ticket K0003']);

    fireEvent.click(screen.getByRole('button', { name: 'Delivery' }));
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByText('3 tickets are hidden by the current filters.')).toBeInTheDocument();
  });
});

describe('state transitions', () => {
  it('Start then Ready send the right PATCH and the board shows what the server answered', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2)]);
    await renderBoard();

    fireEvent.click(screen.getByRole('button', { name: 'Start ticket K0001' }));
    await tick();
    expect(server.patches()).toEqual([{ method: 'PATCH', path: '/kitchen/tickets/ticket-K0001', body: { status: 'PREPARING' }, outletId: OUTLET.id }]);
    expect(within(card('K0001')).getByText('Preparing')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ready ticket K0001' }));
    await tick();
    expect(server.patches()[1]).toMatchObject({ path: '/kitchen/tickets/ticket-K0001', body: { status: 'READY' } });
    expect(queryCard('K0001')).toBeNull(); // off the active board
    expect(screen.getByText('No tickets - all caught up')).toBeInTheDocument();

    // It is now in the recently-ready view, from where it can be recalled.
    fireEvent.click(screen.getByRole('button', { name: 'Recently ready' }));
    await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Recall ticket K0001' }));
    await tick();
    expect(server.patches()[2]).toMatchObject({ body: { status: 'PREPARING' } });
    expect(queryCard('K0001')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Active/ }));
    await tick();
    expect(screen.getByRole('button', { name: 'Ready ticket K0001' })).toBeInTheDocument();
  });

  it('tapping items marks them prepared; the server readies the ticket after the last one', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2, { items: [item('Dal'), item('Naan')] })]);
    const [dal, naan] = server.tickets[0]!.items;
    await renderBoard();

    fireEvent.click(screen.getByRole('button', { name: /Dal/ }));
    await tick();
    expect(server.patches()[0]).toMatchObject({ path: `/kitchen/tickets/ticket-K0001/items/${dal!.id}`, body: { isPrepared: true } });
    expect(screen.getByRole('button', { name: /Dal/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(card('K0001')).getByText('Preparing')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Naan/ }));
    await tick();
    expect(server.patches()[1]).toMatchObject({ path: `/kitchen/tickets/ticket-K0001/items/${naan!.id}`, body: { isPrepared: true } });
    expect(queryCard('K0001')).toBeNull();
  });

  it('a user with view-only access sees tickets but no bump or item buttons', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2)]);
    await renderBoard(false);

    expect(within(card('K0001')).getByText('Paneer Tikka')).toBeInTheDocument();
    expect(within(card('K0001')).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Start|Ready ticket|Recall/ })).toBeNull();
    expect(server.patches()).toHaveLength(0);
  });

  it('a refused change shows the error and falls back to the server state', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2), ticket('K0002', GRILL, 1)]);
    await renderBoard();

    // Meanwhile the cashier cancelled the order: the ticket is gone and the PATCH is refused.
    server.tickets = server.tickets.filter((t) => t.ticketNumber !== 'K0001');
    server.failNextPatch = { status: 409, code: 'TICKET_CLOSED', message: 'This ticket belongs to an order that is already closed' };
    fireEvent.click(screen.getByRole('button', { name: 'Start ticket K0001' }));
    await tick();

    expect(screen.getByRole('alert')).toHaveTextContent('Ticket K0001 was not updated: This ticket belongs to an order that is already closed');
    expect(queryCard('K0001')).toBeNull();
    expect(within(card('K0002')).getByText('Waiting')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('connection handling', () => {
  it('subscribes to the outlet and reports Live only once the socket is connected', async () => {
    fakeServer([ticket('K0001', GRILL, 2)]);
    await renderBoard();
    expect(connection()).toBe('Reconnecting');

    await fire('connect');
    expect(socket.emitted).toEqual([{ event: 'subscribe', payload: { outletId: OUTLET.id } }]);
    expect(connection()).toBe('Live');
  });

  it('refetches on reconnect, so tickets created while the socket was down appear', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2)]);
    await renderBoard();
    await fire('connect');

    await fire('disconnect');
    expect(connection()).toBe('Reconnecting');
    server.tickets.push(ticket('K0002', BEVERAGE, 0, { orderType: 'TAKEAWAY', tableLabel: '' }));
    expect(queryCard('K0002')).toBeNull();

    const before = server.ticketFetches();
    await fire('connect'); // no timers advance here: the reconnect itself triggers the refetch
    expect(server.ticketFetches()).toBe(before + 1);
    expect(connection()).toBe('Live');
    expect(card('K0002')).toBeInTheDocument();
    expect(within(card('K0002')).getByText('NEW')).toBeInTheDocument();
    expect(screen.getByTestId('announcer')).toHaveTextContent('New ticket K0002, Takeaway');
    expect(within(card('K0001')).queryByText('NEW')).toBeNull();
  });

  it('treats socket events as hints and re-reads the list', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2)]);
    await renderBoard();
    await fire('connect');

    server.tickets.push(ticket('K0002', GRILL, 0));
    await fire('kitchen.ticket.changed', { ticketId: 'ticket-K0002', orderId: 'order-K0002', outletId: OUTLET.id });
    expect(card('K0002')).toBeInTheDocument();
  });

  it('polls as a safety net: faster while the socket is down, slower while it is live', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2)]);
    await renderBoard(); // the socket never connects in this test until later

    server.tickets.push(ticket('K0002', GRILL, 0));
    await tick(POLL_DEGRADED_MS);
    expect(card('K0002')).toBeInTheDocument();

    await fire('connect');
    const before = server.ticketFetches();
    await tick(POLL_LIVE_MS - 1);
    expect(server.ticketFetches()).toBe(before);
    await tick(1);
    expect(server.ticketFetches()).toBe(before + 1);
  });

  it('when the server is unreachable: says the board may be stale, disables bumping, then recovers', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2)]);
    await renderBoard();
    await fire('connect');
    expect(screen.queryByRole('alert')).toBeNull();

    server.down = true;
    await fire('disconnect');
    await tick(POLL_DEGRADED_MS);
    expect(connection()).toBe('Offline');
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('OFFLINE - this board may be out of date');
    expect(banner).toHaveTextContent(/Last updated .+ \(00:05 ago\)/);
    expect(card('K0001')).toBeInTheDocument(); // the last known tickets stay on screen
    expect(screen.getByRole('button', { name: 'Start ticket K0001' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start ticket K0001' }));
    expect(server.patches()).toHaveLength(0);

    server.down = false;
    server.tickets.push(ticket('K0002', GRILL, 0));
    await tick(POLL_DEGRADED_MS);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(connection()).toBe('Reconnecting'); // API reachable again, socket still down
    expect(card('K0002')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start ticket K0001' })).toBeEnabled();
  });

  it('checks the server at once when the browser reports the network is gone', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2)]);
    await renderBoard();
    await fire('connect');

    server.down = true;
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await vi.advanceTimersByTimeAsync(0); // no poll interval elapses
    });
    expect(connection()).toBe('Offline');
    expect(screen.getByRole('alert')).toHaveTextContent('OFFLINE');

    server.down = false;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(connection()).toBe('Live');
  });

  it('a bump that fails on the network is reported and does not change the ticket', async () => {
    const server = fakeServer([ticket('K0001', GRILL, 2)]);
    await renderBoard();
    await fire('connect');

    server.down = true;
    fireEvent.click(screen.getByRole('button', { name: 'Start ticket K0001' }));
    await tick();
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/Ticket K0001 was not updated: Cannot reach the server/);
    expect(connection()).toBe('Offline');
    expect(within(card('K0001')).getByText('Waiting')).toBeInTheDocument();
    expect(server.tickets[0]!.status).toBe('PENDING');
  });
});

describe('sound alert', () => {
  it('is off until tapped, shows the real audio state, and beeps for a new ticket', async () => {
    const oscillators: number[] = [];
    class FakeAudioContext {
      state: AudioContextState = 'suspended';
      currentTime = 0;
      destination = {};
      onstatechange: (() => void) | null = null;
      async resume() {
        this.state = 'running';
      }
      async suspend() {
        this.state = 'suspended';
      }
      createOscillator() {
        oscillators.push(1);
        return { type: '', frequency: { value: 0 }, connect: (node: unknown) => node, start() {}, stop() {} };
      }
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node };
      }
    }
    const server = fakeServer([ticket('K0001', GRILL, 2)]);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    await renderBoard();
    await fire('connect');

    const off = screen.getByRole('button', { name: 'Sound off' });
    expect(off).toHaveAttribute('aria-pressed', 'false');
    server.tickets.push(ticket('K0002', GRILL, 0));
    await tick(POLL_LIVE_MS);
    expect(oscillators).toHaveLength(0); // muted: a new ticket makes no sound

    fireEvent.click(off);
    await tick();
    expect(screen.getByRole('button', { name: 'Sound on' })).toHaveAttribute('aria-pressed', 'true');
    const afterConfirmation = oscillators.length;
    expect(afterConfirmation).toBeGreaterThan(0);

    server.tickets.push(ticket('K0003', GRILL, 0));
    await fire('order.changed', { orderId: 'order-K0003', outletId: OUTLET.id });
    expect(oscillators.length).toBeGreaterThan(afterConfirmation);

    fireEvent.click(screen.getByRole('button', { name: 'Sound on' }));
    await tick();
    expect(screen.getByRole('button', { name: 'Sound off' })).toBeInTheDocument();
  });
});
