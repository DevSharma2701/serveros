import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../common/prisma.service';
import { OrdersService } from '../modules/orders.module';
import { createTestApp, curryLine, key, lineId, loginAs, order, seedTenant, teaLine, type Client, type Fixture } from './harness';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Fixture;
let other: Fixture;
let owner: Client;
let manager: Client;
let cashier: Client;
let token: string; // QR secret of table T1

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  f = await seedTenant(prisma, 'guest');
  other = await seedTenant(prisma, 'guestother');
  owner = await loginAs(app, f.users.owner.email, f.outletId);
  manager = await loginAs(app, f.users.manager.email, f.outletId);
  cashier = await loginAs(app, f.users.cashier.email, f.outletId);
});
afterAll(() => app.close());

const pub = () => request(app.getHttpServer());
const guestOrder = (items: object[], t = token, k = key('qr'), extra: object = {}) => pub().post(`/api/v1/public/tables/${t}/orders`).set('Idempotency-Key', k).send({ items, ...extra });
const view = async (guestToken: string) => (await pub().get(`/api/v1/public/orders/${guestToken}`).expect(200)).body;
const payOnline = async (guestToken: string, outcome: 'success' | 'failure' = 'success') => {
  await pub().post(`/api/v1/public/orders/${guestToken}/pay`).send({ method: 'UPI' }).expect(200);
  return (await pub().post(`/api/v1/public/orders/${guestToken}/dev-pay`).send({ outcome }).expect(200)).body;
};
const tea = (quantity = 1) => ({ clientLineId: lineId(), productId: f.tea.id, variantId: f.tea.variantId, quantity });
const milk = async () => Number((await prisma.inventoryBalance.findUniqueOrThrow({ where: { outletId_ingredientId: { outletId: f.outletId, ingredientId: f.milkId } } })).quantity);
const tickets = (orderNumber: string) => prisma.kitchenTicket.count({ where: { orderNumber } });

describe('QR codes', () => {
  it('are managed by staff with the right permission and never leak through the floor plan', async () => {
    await cashier.get('/qr-codes').expect(403);
    const codes = (await owner.get('/qr-codes').expect(200)).body;
    expect(codes.enabled).toBe(false);
    expect(codes.tables).toHaveLength(3);
    token = codes.tables.find((t: { name: string }) => t.name === 'T1').qrToken;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(new Set(codes.tables.map((t: { qrToken: string }) => t.qrToken)).size).toBe(3);
    expect((await owner.get('/qr-codes').expect(200)).body.tables.find((t: { name: string }) => t.name === 'T1').qrToken).toBe(token); // stable
    expect(JSON.stringify((await cashier.get('/floor').expect(200)).body)).not.toContain(token);
  });

  it('do nothing until the outlet switches guest ordering on', async () => {
    await pub().get(`/api/v1/public/tables/${token}`).expect(404);
    await guestOrder([tea()]).expect(404);
    await owner.patch(`/outlets/${f.outletId}`, { qrOrderingEnabled: true }).expect(200);
    await pub().get(`/api/v1/public/tables/${token}`).expect(200);
  });

  it('answer "not found" for unknown, malformed or other-outlet tokens alike', async () => {
    await pub().get('/api/v1/public/tables/short').expect(404);
    await pub().get(`/api/v1/public/tables/${'x'.repeat(32)}`).expect(404);
    await pub().get(`/api/v1/public/orders/${'y'.repeat(32)}`).expect(404);
  });
});

describe('the guest menu', () => {
  it('needs no login and shows only what a guest should see', async () => {
    const res = await pub().get(`/api/v1/public/tables/${token}`).expect(200);
    expect(res.body).toMatchObject({ table: 'T1', outlet: 'Main', currency: 'INR', onlinePayment: 'dev' });
    expect(res.body.products.map((p: { name: string }) => p.name).sort()).toEqual(['Curry', 'Tea']);
    expect(res.body.products[0].variants[0]).toHaveProperty('priceMinor');
    const text = JSON.stringify(res.body);
    for (const secret of ['restaurantId', 'costPerBase', 'discountApprovalThreshold', 'taxCategoryId', 'sku', 'passwordHash', 'qrToken']) expect(text).not.toContain(secret);
  });

  it('quotes with server prices', async () => {
    const res = await pub().post(`/api/v1/public/tables/${token}/quote`).send({ items: [{ ...tea(2), priceMinor: 1, unitPriceMinor: 1 }] }).expect(200);
    expect(res.body).toMatchObject({ subtotalMinor: 20_000, taxMinor: 1_000, totalMinor: 21_000 });
  });
});

describe('pay first, then straight to the kitchen', () => {
  it('holds an unpaid order back from the kitchen and from stock', async () => {
    const before = await milk();
    const res = await guestOrder([tea(2)], token, key('qr'), { guestName: 'Asha', totalMinor: 1, status: 'CONFIRMED', paidMinor: 99999 }).expect(201);
    expect(res.body).toMatchObject({ status: 'PLACED', table: 'T1', guestName: 'Asha', totalMinor: 21_000, payment: { state: 'UNPAID' }, kitchen: { tickets: 0 } });
    expect(res.body.payment.payBy).toBeTruthy();
    expect(await tickets(res.body.orderNumber)).toBe(0);
    expect(await milk()).toBe(before);
    const saved = await prisma.order.findUniqueOrThrow({ where: { guestToken: res.body.guestToken } });
    expect(saved).toMatchObject({ source: 'QR', createdById: null, guestTableId: f.tables[0], paidMinor: 0 });
    // Staff cannot push an unpaid guest order into the kitchen either.
    expect((await cashier.post(`/orders/${saved.id}/accept`).expect(409)).body.error.code).toBe('PAYMENT_DUE');
  });

  it('sends the order to the kitchen the moment the payment is confirmed', async () => {
    const before = await milk();
    const placed = (await guestOrder([tea(1), { ...curryLine(f, 'full', [f.mods.hot, f.mods.butter]), notes: 'no onion' }]).expect(201)).body;
    const pending = (await pub().post(`/api/v1/public/orders/${placed.guestToken}/pay`).send({ method: 'UPI' }).expect(200)).body;
    expect(pending).toMatchObject({ status: 'PLACED', payment: { state: 'PENDING', provider: 'dev' } });
    expect(await tickets(placed.orderNumber)).toBe(0); // a started payment is not a payment

    const paid = (await pub().post(`/api/v1/public/orders/${placed.guestToken}/dev-pay`).send({ outcome: 'success' }).expect(200)).body;
    expect(paid).toMatchObject({ status: 'CONFIRMED', payment: { state: 'PAID' }, kitchen: { tickets: 2, ready: 0 }, needsStaff: false });
    expect(await milk()).toBe(before - 100);

    const staffView = (await cashier.get(`/orders?q=${placed.orderNumber}`).expect(200)).body.items[0];
    expect(staffView).toMatchObject({ source: 'QR', status: 'CONFIRMED', paymentStatus: 'PAID', tableLabel: 'T1' });
    const detail = (await cashier.get(`/orders/${staffView.id}`).expect(200)).body;
    expect(detail.invoice).toBeTruthy();
    expect(detail.payments[0]).toMatchObject({ verification: 'GATEWAY', state: 'SUCCEEDED', receivedById: null });
    expect(detail.events.map((e: { type: string; toStatus: string | null }) => [e.type, e.toStatus])).toEqual([['CREATED', 'PLACED'], ['PAYMENT', null], ['INVOICE_ISSUED', null], ['STATUS_CHANGED', 'CONFIRMED']]);

    // The guest follows the kitchen's progress, and staff finish the order as usual.
    const kitchen = await loginAs(app, f.users.kitchen.email, f.outletId);
    for (const t of await prisma.kitchenTicket.findMany({ where: { orderId: staffView.id } })) await kitchen.patch(`/kitchen/tickets/${t.id}`, { status: 'READY' }).expect(200);
    expect(await view(placed.guestToken)).toMatchObject({ status: 'READY', kitchen: { tickets: 2, ready: 2 } });
    await cashier.post(`/orders/${staffView.id}/complete`).expect(200);
    expect((await view(placed.guestToken)).status).toBe('COMPLETED');
    const receipt = await pub().get(`/api/v1/public/orders/${placed.guestToken}/receipt`).expect(200);
    expect(receipt.body.text).toContain('TAX INVOICE');
  });

  it('a declined payment leaves the order unpaid, uncooked and payable again', async () => {
    const placed = (await guestOrder([tea()]).expect(201)).body;
    const failed = await payOnline(placed.guestToken, 'failure');
    expect(failed).toMatchObject({ status: 'PLACED', payment: { state: 'UNPAID', lastFailure: 'Declined (simulated)' } });
    expect(await tickets(placed.orderNumber)).toBe(0);
    expect((await payOnline(placed.guestToken, 'success')).status).toBe('CONFIRMED');
    await pub().post(`/api/v1/public/orders/${placed.guestToken}/pay`).send({}).expect(409); // nothing left to pay
  });

  it('tapping pay twice, or retrying the order request, never doubles anything', async () => {
    const k = key('qr');
    const first = (await guestOrder([tea()], token, k).expect(201)).body;
    const again = (await guestOrder([tea(9)], token, k).expect(201)).body;
    expect(again.guestToken).toBe(first.guestToken);
    expect(again.totalMinor).toBe(10_500);

    await Promise.all(Array.from({ length: 5 }, () => pub().post(`/api/v1/public/orders/${first.guestToken}/pay`).send({ method: 'UPI' })));
    const saved = await prisma.order.findUniqueOrThrow({ where: { guestToken: first.guestToken }, include: { payments: true } });
    expect(saved.payments).toHaveLength(1);
    await pub().post(`/api/v1/public/orders/${first.guestToken}/dev-pay`).send({ outcome: 'success' }).expect(200);
    await pub().post(`/api/v1/public/orders/${first.guestToken}/dev-pay`).send({ outcome: 'success' }).expect(409);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: saved.id } })).paidMinor).toBe(10_500);
    expect(await tickets(first.orderNumber)).toBe(1);
  });

  it('can also be paid at the counter, which releases it the same way', async () => {
    const placed = (await guestOrder([tea()]).expect(201)).body;
    const saved = await prisma.order.findUniqueOrThrow({ where: { guestToken: placed.guestToken } });
    await cashier.post(`/orders/${saved.id}/payments`, { tenders: [{ method: 'UPI', amountMinor: 10_500, reference: 'COUNTER1' }] }, { 'Idempotency-Key': key('pay') }).expect(201);
    expect(await view(placed.guestToken)).toMatchObject({ status: 'CONFIRMED', payment: { state: 'PAID' }, kitchen: { tickets: 1 } });
  });
});

describe('guards on a public endpoint', () => {
  it('applies the normal menu rules: unavailable items, modifier rules, quantity caps', async () => {
    await guestOrder([{ ...curryLine(f), modifierOptionIds: [] }]).expect(400);
    await guestOrder([tea(21)]).expect(400);
    await guestOrder([]).expect(400);
    await guestOrder([{ clientLineId: lineId(), productId: other.tea.id, variantId: other.tea.variantId, quantity: 1 }]).expect(404); // another restaurant's product
    await pub().post(`/api/v1/public/tables/${token}/orders`).send({ items: [tea()] }).expect(400); // idempotency key is mandatory
    await owner.put(`/menu/products/${f.tea.id}/availability`, { isAvailable: false }).expect(200);
    expect((await guestOrder([tea()]).expect(409)).body.error.code).toBe('ITEM_UNAVAILABLE');
    await owner.put(`/menu/products/${f.tea.id}/availability`, { isAvailable: true }).expect(200);
  });

  it('a guest sees only their own order, and cannot use staff endpoints', async () => {
    const mine = (await guestOrder([tea()]).expect(201)).body;
    const saved = await prisma.order.findUniqueOrThrow({ where: { guestToken: mine.guestToken } });
    await pub().get(`/api/v1/public/orders/${saved.id}`).expect(404); // the internal id is not a key
    await pub().get(`/api/v1/orders/${saved.id}`).expect(401);
    await pub().post(`/api/v1/orders/${saved.id}/complete`).expect(401);
    expect(JSON.stringify(mine)).not.toMatch(/restaurantId|outletId|createdById|"id"/);
    // A staff-created order has no guest token, so no public URL can reach it.
    const staffOrder = (await order(cashier, [teaLine(f)]).expect(201)).body;
    expect(staffOrder.guestToken).toBeNull();
  });

  it('limits how many unpaid orders one table can pile up', async () => {
    await prisma.order.updateMany({ where: { source: 'QR', status: 'PLACED', paidMinor: 0 }, data: { status: 'CANCELLED' } });
    for (let i = 0; i < 5; i++) await guestOrder([tea()]).expect(201);
    expect((await guestOrder([tea()]).expect(409)).body.error.code).toBe('TOO_MANY_UNPAID_ORDERS');
    const t2 = (await owner.get('/qr-codes')).body.tables.find((t: { name: string }) => t.name === 'T2').qrToken;
    await guestOrder([tea()], t2).expect(201); // other tables are unaffected
  });

  it('cancels orders nobody paid for, and only those', async () => {
    const paid = (await guestOrder([tea()], (await owner.get('/qr-codes')).body.tables[1].qrToken).expect(201)).body;
    await payOnline(paid.guestToken);
    await prisma.order.updateMany({ where: { source: 'QR' }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
    const cancelled = await app.get(OrdersService).expireUnpaidGuestOrders();
    expect(cancelled).toBeGreaterThanOrEqual(5);
    expect(await prisma.order.count({ where: { source: 'QR', status: 'PLACED', paidMinor: 0 } })).toBe(0);
    expect((await view(paid.guestToken)).status).toBe('CONFIRMED');
    const gone = await prisma.order.findFirstOrThrow({ where: { source: 'QR', status: 'CANCELLED', cancelReason: 'Payment was not completed in time' }, include: { payments: true } });
    expect(gone.payments.every((p) => p.state !== 'PENDING')).toBe(true);
    await pub().post(`/api/v1/public/orders/${gone.guestToken}/pay`).send({}).expect(409); // an expired order cannot be paid
  });

  it('regenerating a QR code kills the old one', async () => {
    const t3 = (await owner.get('/qr-codes')).body.tables.find((t: { name: string }) => t.name === 'T3');
    await pub().get(`/api/v1/public/tables/${t3.qrToken}`).expect(200);
    await cashier.post(`/qr-codes/${t3.id}/regenerate`).expect(403);
    const fresh = (await owner.post(`/qr-codes/${t3.id}/regenerate`).expect(200)).body;
    expect(fresh.qrToken).not.toBe(t3.qrToken);
    await pub().get(`/api/v1/public/tables/${t3.qrToken}`).expect(404);
    await pub().get(`/api/v1/public/tables/${fresh.qrToken}`).expect(200);
    await owner.post(`/qr-codes/${other.tables[0]}/regenerate`).expect(404);
  });
});

describe('alongside staff', () => {
  it('does not lock the table: a waiter can still run a normal bill on it, and the floor shows it in use', async () => {
    await prisma.order.updateMany({ where: { outletId: f.outletId, status: { in: ['PLACED', 'CONFIRMED', 'PREPARING', 'READY'] } }, data: { status: 'CANCELLED' } });
    const table = async () => (await cashier.get('/floor').expect(200)).body[0].tables.find((t: { id: string }) => t.id === f.tables[0]);
    expect(await table()).toMatchObject({ status: 'AVAILABLE', guestOrders: 0 });
    const unpaid = (await guestOrder([tea()]).expect(201)).body;
    expect((await table()).status).toBe('AVAILABLE'); // an unpaid order does not occupy a table
    await payOnline(unpaid.guestToken);
    expect(await table()).toMatchObject({ status: 'OCCUPIED', guestOrders: 1, order: null });
    await order(cashier, [teaLine(f)], { type: 'DINE_IN', tableId: f.tables[0] }).expect(201);
    expect((await table()).order).toBeTruthy();
  });

  it('if the kitchen cannot take a paid order, it is held and flagged for staff, who can send or refund it', async () => {
    await prisma.inventoryBalance.update({ where: { outletId_ingredientId: { outletId: f.outletId, ingredientId: f.milkId } }, data: { quantity: 50 } });
    const placed = (await guestOrder([tea()]).expect(201)).body;
    const held = await payOnline(placed.guestToken);
    expect(held).toMatchObject({ status: 'PLACED', payment: { state: 'PAID' }, needsStaff: true, kitchen: { tickets: 0 } });
    const saved = await prisma.order.findUniqueOrThrow({ where: { guestToken: placed.guestToken }, include: { events: true, payments: true } });
    expect(saved.paidMinor).toBe(10_500); // the money is recorded even though the order is stuck
    expect(saved.events.find((e) => e.type === 'ATTENTION')!.message).toMatch(/Not enough Milk/);

    // Option 1: restock, then staff send it.
    expect((await cashier.post(`/orders/${saved.id}/accept`).expect(409)).body.error.code).toBe('INSUFFICIENT_STOCK');
    await prisma.inventoryBalance.update({ where: { outletId_ingredientId: { outletId: f.outletId, ingredientId: f.milkId } }, data: { quantity: 5_000 } });
    expect((await cashier.post(`/orders/${saved.id}/accept`).expect(200)).body.status).toBe('CONFIRMED');
    expect((await view(placed.guestToken)).kitchen.tickets).toBe(1);

    // Option 2: refund and cancel.
    await prisma.inventoryBalance.update({ where: { outletId_ingredientId: { outletId: f.outletId, ingredientId: f.milkId } }, data: { quantity: 0 } });
    const second = (await guestOrder([tea()]).expect(201)).body;
    await payOnline(second.guestToken);
    const stuck = await prisma.order.findUniqueOrThrow({ where: { guestToken: second.guestToken }, include: { payments: true } });
    await manager.post(`/payments/${stuck.payments[0]!.id}/refunds`, { amountMinor: 10_500, reason: 'Out of stock' }, { 'Idempotency-Key': key('ref') }).expect(201);
    await manager.post(`/orders/${stuck.id}/cancel`, { reason: 'Out of stock' }).expect(200);
    expect(await view(second.guestToken)).toMatchObject({ status: 'CANCELLED', cancelReason: 'Out of stock', refundedMinor: 10_500 });
  });
});
