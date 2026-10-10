import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { PrismaService } from '../common/prisma.service';
import { createTestApp, curryLine, loginAs, order, seedTenant, teaLine, type Client, type Fixture } from './harness';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Fixture;
let other: Fixture;
let cashier: Client;
let kitchen: Client;
let manager: Client;
let url: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  f = await seedTenant(prisma, 'kds');
  other = await seedTenant(prisma, 'kdsother');
  await app.listen(0);
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  cashier = await loginAs(app, f.users.cashier.email, f.outletId);
  kitchen = await loginAs(app, f.users.kitchen.email, f.outletId);
  manager = await loginAs(app, f.users.manager.email, f.outletId);
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await app.close();
});

type Ticket = { id: string; orderId: string; status: string; station: { key: string }; items: Array<{ id: string; name: string; quantity: number; modifiers: string; notes: string; isPrepared: boolean; isCancelled: boolean }> };
const ticketsFor = async (orderId: string, scope = 'active'): Promise<Ticket[]> =>
  (await kitchen.get(`/kitchen/tickets?scope=${scope}`).expect(200)).body.filter((t: Ticket) => t.orderId === orderId);
const orderStatus = async (id: string): Promise<string> => (await cashier.get(`/orders/${id}`).expect(200)).body.status;

function connect(token: string | undefined): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}
const subscribe = (socket: Socket, outletId: string): Promise<{ ok: boolean }> => new Promise((resolve) => socket.emit('subscribe', { outletId }, resolve));
const nextEvent = (socket: Socket, event: string, ms = 3000): Promise<Record<string, unknown> | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

describe('kitchen tickets', () => {
  it('routes each item to its station with quantities, modifiers and notes', async () => {
    const placed = await order(cashier, [teaLine(f, 2, { notes: 'less sugar' }), curryLine(f, 'full', [f.mods.hot, f.mods.butter])], { notes: 'Allergy: nuts' }).expect(201);
    const tickets = await ticketsFor(placed.body.id);
    expect(tickets.map((t) => t.station.key).sort()).toEqual(['BEVERAGE', 'HOT']);
    const beverage = tickets.find((t) => t.station.key === 'BEVERAGE')!;
    expect(beverage.items).toEqual([expect.objectContaining({ name: 'Tea', quantity: 2, notes: 'less sugar' })]);
    const hot = tickets.find((t) => t.station.key === 'HOT')!;
    expect(hot.items[0]).toMatchObject({ name: 'Curry (Full)', modifiers: 'Hot, Butter' });
    expect((hot as unknown as { notes: string }).notes).toBe('Allergy: nuts');

    const stations = (await kitchen.get('/kitchen/stations').expect(200)).body;
    const onlyBeverage = await kitchen.get(`/kitchen/tickets?stationId=${stations.find((s: { key: string }) => s.key === 'BEVERAGE').id}`).expect(200);
    expect(onlyBeverage.body.every((t: Ticket) => t.station.key === 'BEVERAGE')).toBe(true);
  });

  it('sends items with an unknown station to the default station', async () => {
    await prisma.product.update({ where: { id: f.tea.id }, data: { stationKey: 'NOWHERE' } });
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    expect((await ticketsFor(placed.body.id)).map((t) => t.station.key)).toEqual(['HOT']);
    await prisma.product.update({ where: { id: f.tea.id }, data: { stationKey: 'BEVERAGE' } });
  });

  it('moves the order through preparing and ready as tickets progress', async () => {
    const placed = await order(cashier, [teaLine(f), curryLine(f)]).expect(201);
    const [one, two] = await ticketsFor(placed.body.id);
    await kitchen.patch(`/kitchen/tickets/${one!.id}`, { status: 'PREPARING' }).expect(200);
    expect(await orderStatus(placed.body.id)).toBe('PREPARING');
    await kitchen.patch(`/kitchen/tickets/${one!.id}`, { status: 'READY' }).expect(200);
    expect(await orderStatus(placed.body.id)).toBe('PREPARING'); // the other station is not done
    await kitchen.patch(`/kitchen/tickets/${two!.id}`, { status: 'READY' }).expect(200);
    expect(await orderStatus(placed.body.id)).toBe('READY');
    expect(await ticketsFor(placed.body.id)).toHaveLength(0); // no longer on the active board
    expect(await ticketsFor(placed.body.id, 'recent')).toHaveLength(2);

    // Recall a ticket by mistake: the order steps back with it.
    await kitchen.patch(`/kitchen/tickets/${two!.id}`, { status: 'PREPARING' }).expect(200);
    expect(await orderStatus(placed.body.id)).toBe('PREPARING');
    await kitchen.patch(`/kitchen/tickets/${two!.id}`, { status: 'CANCELLED' }).expect(400);
  });

  it('marks single items prepared and completes the ticket when all are done', async () => {
    const placed = await order(cashier, [curryLine(f, 'half'), curryLine(f, 'full')]).expect(201);
    const [ticket] = await ticketsFor(placed.body.id);
    const first = await kitchen.patch(`/kitchen/tickets/${ticket!.id}/items/${ticket!.items[0]!.id}`, { isPrepared: true }).expect(200);
    expect(first.body.status).toBe('PREPARING');
    const second = await kitchen.patch(`/kitchen/tickets/${ticket!.id}/items/${ticket!.items[1]!.id}`, { isPrepared: true }).expect(200);
    expect(second.body.status).toBe('READY');
    expect(await orderStatus(placed.body.id)).toBe('READY');
  });

  it('new items on a ready order create a new ticket and reopen the order', async () => {
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    const [ticket] = await ticketsFor(placed.body.id);
    await kitchen.patch(`/kitchen/tickets/${ticket!.id}`, { status: 'READY' }).expect(200);
    await cashier.post(`/orders/${placed.body.id}/items`, { items: [curryLine(f)] }).expect(200);
    expect(await orderStatus(placed.body.id)).toBe('PREPARING');
    const active = await ticketsFor(placed.body.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.items[0]!.name).toBe('Curry (Full)');
  });

  it('removes voided items from the ticket and closes tickets of cancelled orders', async () => {
    const placed = await order(cashier, [teaLine(f), curryLine(f)]).expect(201);
    const tea = placed.body.items.find((i: { productName: string }) => i.productName === 'Tea');
    await manager.post(`/orders/${placed.body.id}/items/${tea.id}/void`, { reason: 'ordered by mistake' }).expect(200);
    expect((await ticketsFor(placed.body.id)).map((t) => t.station.key)).toEqual(['HOT']);
    await manager.post(`/orders/${placed.body.id}/cancel`, { reason: 'guest left' }).expect(200);
    expect(await ticketsFor(placed.body.id)).toHaveLength(0);
    const [closed] = await prisma.kitchenTicket.findMany({ where: { orderId: placed.body.id, station: { key: 'HOT' } } });
    expect((await kitchen.patch(`/kitchen/tickets/${closed!.id}`, { status: 'READY' }).expect(409)).body.error.code).toBe('TICKET_CLOSED');
  });

  it('only kitchen-capable roles may change tickets, and only in their own restaurant', async () => {
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    const [ticket] = await ticketsFor(placed.body.id);
    await cashier.patch(`/kitchen/tickets/${ticket!.id}`, { status: 'READY' }).expect(403);
    const stranger = await loginAs(app, other.users.kitchen.email, other.outletId);
    await stranger.patch(`/kitchen/tickets/${ticket!.id}`, { status: 'READY' }).expect(404);
    expect((await stranger.get('/kitchen/tickets').expect(200)).body).toHaveLength(0);
  });

  it('station set-up always keeps one default station', async () => {
    const created = await manager.post('/kitchen/stations', { key: 'grill', name: 'Grill' }).expect(201);
    expect(created.body.key).toBe('GRILL');
    await manager.post('/kitchen/stations', { key: 'GRILL', name: 'Duplicate' }).expect(409);
    await kitchen.post('/kitchen/stations', { key: 'COLD', name: 'Cold' }).expect(403);
    const stations = (await manager.get('/kitchen/stations').expect(200)).body;
    const hot = stations.find((s: { key: string }) => s.key === 'HOT');
    expect((await manager.patch(`/kitchen/stations/${hot.id}`, { isActive: false }).expect(409)).body.error.code).toBe('DEFAULT_STATION_REQUIRED');
    await manager.patch(`/kitchen/stations/${created.body.id}`, { isDefault: true }).expect(200);
    expect((await manager.get('/kitchen/stations')).body.filter((s: { isDefault: boolean }) => s.isDefault)).toHaveLength(1);
    await manager.patch(`/kitchen/stations/${hot.id}`, { isDefault: true }).expect(200);
  });
});

describe('live updates', () => {
  it('rejects sockets without a valid token', async () => {
    const socket = io(url, { auth: { token: 'garbage' }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    const outcome = await new Promise<string>((resolve) => {
      socket.on('connect_error', (err) => resolve(err.message));
      socket.on('disconnect', () => resolve('disconnected'));
      setTimeout(() => resolve('still connected'), 3000);
    });
    expect(outcome).toBe('Not authenticated');
  });

  it('pushes a ticket notification to the kitchen when an order is placed', async () => {
    const socket = await connect(kitchen.token);
    expect(await subscribe(socket, f.outletId)).toEqual({ ok: true });
    const waiting = nextEvent(socket, 'kitchen.ticket.changed');
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    expect(await waiting).toMatchObject({ orderId: placed.body.id, outletId: f.outletId });
  });

  it("refuses subscriptions to another restaurant's outlet and leaks nothing to them", async () => {
    const stranger = await loginAs(app, other.users.kitchen.email, other.outletId);
    const socket = await connect(stranger.token);
    expect(await subscribe(socket, f.outletId)).toEqual({ ok: false });
    expect(await subscribe(socket, other.outletId)).toEqual({ ok: true });
    const waiting = nextEvent(socket, 'kitchen.ticket.changed', 800);
    await order(cashier, [teaLine(f)]).expect(201);
    expect(await waiting).toBeNull();
  });

  it('after a dropped connection the full ticket list is still available from the API', async () => {
    const socket = await connect(kitchen.token);
    await subscribe(socket, f.outletId);
    socket.close(); // the screen goes offline
    const missed = await Promise.all([order(cashier, [teaLine(f)]), order(cashier, [curryLine(f)])]);
    // On reconnect the KDS re-reads the board; nothing depends on having received the events.
    const board = (await kitchen.get('/kitchen/tickets').expect(200)).body as Ticket[];
    for (const res of missed) expect(board.some((t) => t.orderId === res.body.id)).toBe(true);
    const again = await connect(kitchen.token);
    expect(await subscribe(again, f.outletId)).toEqual({ ok: true });
  });
});
