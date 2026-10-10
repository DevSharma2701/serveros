import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../common/prisma.service';
import { hmac } from '../common/util';
import { createTestApp, key, loginAs, openShift, order, pay, seedTenant, teaLine, type Client, type Fixture } from './harness';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Fixture;
let owner: Client;
let manager: Client;
let cashier: Client;
let waiter: Client;
let shiftId: string;

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  f = await seedTenant(prisma, 'pay');
  owner = await loginAs(app, f.users.owner.email, f.outletId);
  manager = await loginAs(app, f.users.manager.email, f.outletId);
  cashier = await loginAs(app, f.users.cashier.email, f.outletId);
  waiter = await loginAs(app, f.users.waiter.email, f.outletId);
});
afterAll(() => app.close());

const tea = async (qty = 1, extra: object = {}) => (await order(cashier, [teaLine(f, qty)], extra).expect(201)).body as { id: string; totalMinor: number; orderNumber: string };
const get = async (id: string) => (await cashier.get(`/orders/${id}`).expect(200)).body;
const webhook = (body: object, signature?: string) => {
  const raw = JSON.stringify(body);
  return request(app.getHttpServer())
    .post('/api/v1/payments/webhooks/dev')
    .set('Content-Type', 'application/json')
    .set('X-ServeOS-Signature', signature ?? hmac(process.env.PAYMENT_WEBHOOK_SECRET!, raw))
    .send(raw);
};

describe('cash shifts', () => {
  it('cash cannot be taken without an open shift', async () => {
    const o = await tea();
    const res = await pay(cashier, o.id, [{ method: 'CASH', amountMinor: o.totalMinor }]).expect(409);
    expect(res.body.error.code).toBe('NO_OPEN_SHIFT');
    expect((await get(o.id)).paidMinor).toBe(0);
  });

  it('opens one shift per register and one per cashier', async () => {
    const opened = await openShift(cashier, f.registerId, 100_000).expect(201);
    shiftId = opened.body.shift.id;
    expect(opened.body.cash).toMatchObject({ openingFloatMinor: 100_000, expectedCashMinor: 100_000 });
    expect((await openShift(cashier, f.register2Id).expect(409)).body.error.code).toBe('SHIFT_ALREADY_OPEN');
    expect((await openShift(manager, f.registerId).expect(409)).body.error.code).toBe('REGISTER_IN_USE');
    await openShift(waiter, f.register2Id).expect(403);
    expect((await cashier.get('/shifts/current').expect(200)).body.shift.id).toBe(shiftId);
  });
});

describe('recording payments', () => {
  it('takes cash, works out the change and marks the order paid', async () => {
    const o = await tea();
    const res = await pay(cashier, o.id, [{ method: 'CASH', amountMinor: 10_500, tenderedMinor: 20_000 }]).expect(201);
    expect(res.body.payments[0]).toMatchObject({ method: 'CASH', state: 'SUCCEEDED', amountMinor: 10_500, tenderedMinor: 20_000, changeMinor: 9_500, verification: 'NOT_REQUIRED', shiftId });
    expect(await get(o.id)).toMatchObject({ paidMinor: 10_500, paymentStatus: 'PAID', dueMinor: 0 });
    await pay(cashier, (await tea()).id, [{ method: 'CASH', amountMinor: 10_500, tenderedMinor: 5_000 }]).expect(400);
  });

  it('rejects overpayment and, by default, part payment', async () => {
    const o = await tea();
    expect((await pay(cashier, o.id, [{ method: 'UPI', amountMinor: 10_501 }]).expect(409)).body.error).toMatchObject({ code: 'OVERPAYMENT', details: { dueMinor: 10_500 } });
    expect((await pay(cashier, o.id, [{ method: 'UPI', amountMinor: 5_000 }]).expect(409)).body.error.code).toBe('PARTIAL_PAYMENT_NOT_ALLOWED');
    expect((await get(o.id)).paidMinor).toBe(0);

    await owner.patch('/restaurant', { allowPartialPayment: true }).expect(200);
    await pay(cashier, o.id, [{ method: 'UPI', amountMinor: 5_000 }]).expect(201);
    expect(await get(o.id)).toMatchObject({ paymentStatus: 'PARTIALLY_PAID', dueMinor: 5_500 });
    expect((await cashier.post(`/orders/${o.id}/complete`).expect(409)).body.error.code).toBe('PAYMENT_DUE');
    await owner.patch('/restaurant', { allowPartialPayment: false }).expect(200);
  });

  it('settles a split payment across methods in one transaction', async () => {
    const o = await tea(2); // 210.00
    await pay(cashier, o.id, [{ method: 'CASH', amountMinor: 10_000 }, { method: 'CARD', amountMinor: 20_000, reference: 'SLIP1' }]).expect(409); // too much: nothing recorded
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0);
    const res = await pay(cashier, o.id, [{ method: 'CASH', amountMinor: 10_000 }, { method: 'CARD', amountMinor: 11_000, reference: 'SLIP1' }]).expect(201);
    expect(res.body.payments.map((p: { method: string; verification: string }) => [p.method, p.verification])).toEqual([['CASH', 'NOT_REQUIRED'], ['CARD', 'MANUAL']]);
    expect(await get(o.id)).toMatchObject({ paidMinor: 21_000, paymentStatus: 'PAID' });
  });

  it('a retried payment request is not charged twice', async () => {
    const o = await tea();
    const k = key('pay');
    const first = await pay(cashier, o.id, [{ method: 'CASH', amountMinor: 10_500 }], k).expect(201);
    const second = await pay(cashier, o.id, [{ method: 'CASH', amountMinor: 10_500 }], k).expect(201);
    expect(second.body.replayed).toBe(true);
    expect(second.body.payments[0].id).toBe(first.body.payments[0].id);
    expect((await get(o.id)).paidMinor).toBe(10_500);
    expect(await prisma.cashMovement.count({ where: { paymentId: first.body.payments[0].id } })).toBe(1);
    await cashier.post(`/orders/${o.id}/payments`, { tenders: [{ method: 'CASH', amountMinor: 1 }] }).expect(400); // key is mandatory

    const burst = await tea();
    const k2 = key('burst');
    const results = await Promise.all(Array.from({ length: 6 }, () => pay(cashier, burst.id, [{ method: 'CASH', amountMinor: 10_500 }], k2)));
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.payment.count({ where: { orderId: burst.id } })).toBe(1);
    expect((await get(burst.id)).paidMinor).toBe(10_500);
  });

  it('waiters cannot record payments and nobody can pay a draft', async () => {
    const o = await tea();
    await pay(waiter, o.id, [{ method: 'CASH', amountMinor: 10_500 }]).expect(403);
    const draft = (await order(cashier, [teaLine(f)], { action: 'DRAFT' }).expect(201)).body;
    expect((await pay(cashier, draft.id, [{ method: 'UPI', amountMinor: 10_500 }]).expect(409)).body.error.code).toBe('ORDER_NOT_PAYABLE');
  });
});

describe('gateway payments (development adapter)', () => {
  const start = async () => {
    const o = await tea();
    const res = await pay(cashier, o.id, [{ method: 'UPI', amountMinor: 10_500, mode: 'GATEWAY' }]).expect(201);
    return { o, payment: res.body.payments[0] as { id: string; providerRef: string; state: string } };
  };

  it('a gateway payment stays pending and unpaid until the provider confirms it', async () => {
    const { o, payment } = await start();
    expect(payment.state).toBe('PENDING');
    expect(await get(o.id)).toMatchObject({ paidMinor: 0, paymentStatus: 'UNPAID' });
    expect((await cashier.post(`/orders/${o.id}/complete`).expect(409)).body.error.code).toBe('PAYMENT_DUE');
    // The amount is reserved: it cannot be paid a second time while pending.
    await pay(cashier, o.id, [{ method: 'CASH', amountMinor: 10_500 }]).expect(409);
    expect((await cashier.get('/payments?state=PENDING').expect(200)).body.items.map((p: { id: string }) => p.id)).toContain(payment.id);
  });

  it('rejects callbacks with a wrong or missing signature', async () => {
    const { o, payment } = await start();
    const body = { id: 'evt_forged_1', type: 'payment.succeeded', data: { providerRef: payment.providerRef, amountMinor: 10_500 } };
    await webhook(body, 'deadbeef').expect(401);
    await webhook(body, hmac('some-other-secret', JSON.stringify(body))).expect(401);
    await request(app.getHttpServer()).post('/api/v1/payments/webhooks/dev').send(body).expect(401);
    await request(app.getHttpServer()).post('/api/v1/payments/webhooks/unknown').send(body).expect(404);
    expect((await get(o.id)).paidMinor).toBe(0);
  });

  it('confirms on a signed callback and ignores a repeated delivery', async () => {
    const { o, payment } = await start();
    const body = { id: 'evt_once_1', type: 'payment.succeeded', data: { providerRef: payment.providerRef, amountMinor: 10_500 } };
    expect((await webhook(body).expect(200)).body.status).toBe('processed');
    expect((await webhook(body).expect(200)).body.status).toBe('duplicate');
    expect((await webhook({ ...body, id: 'evt_once_2' }).expect(200)).body.status).toBe('already_final'); // new event id, same payment
    const after = await get(o.id);
    expect(after).toMatchObject({ paidMinor: 10_500, paymentStatus: 'PAID' });
    expect(after.payments[0]).toMatchObject({ state: 'SUCCEEDED', verification: 'GATEWAY' });
    expect(after.invoice).toBeTruthy();
  });

  it('does not accept a confirmation for a different amount', async () => {
    const { o, payment } = await start();
    await webhook({ id: 'evt_amount_1', type: 'payment.succeeded', data: { providerRef: payment.providerRef, amountMinor: 100 } }).expect(200);
    const after = await get(o.id);
    expect(after.paidMinor).toBe(0);
    expect(after.payments[0]).toMatchObject({ state: 'FAILED', failureReason: 'Amount does not match the payment request' });
  });

  it('recovers from a failed payment: the order can be paid another way', async () => {
    const { o, payment } = await start();
    const failed = await cashier.post(`/payments/${payment.id}/dev-simulate`, { outcome: 'failure' }).expect(200);
    expect(failed.body.state).toBe('FAILED');
    expect(await get(o.id)).toMatchObject({ paidMinor: 0, dueMinor: 10_500 });
    await pay(cashier, o.id, [{ method: 'CASH', amountMinor: 10_500 }]).expect(201);
    expect((await get(o.id)).paymentStatus).toBe('PAID');
    await cashier.post(`/payments/${payment.id}/dev-simulate`, { outcome: 'success' }).expect(409); // already final
  });

  it('a pending payment can be cancelled to free the bill', async () => {
    const { o, payment } = await start();
    expect((await cashier.post(`/payments/${payment.id}/cancel`).expect(200)).body.state).toBe('CANCELLED');
    await cashier.post(`/payments/${payment.id}/cancel`).expect(409);
    await pay(cashier, o.id, [{ method: 'CARD', amountMinor: 10_500, reference: 'SLIP9' }]).expect(201);
  });
});

describe('invoices and receipts', () => {
  it('issues one sequential invoice per order, even when orders are paid at the same moment', async () => {
    const orders = await Promise.all(Array.from({ length: 6 }, () => tea()));
    await Promise.all(orders.map((o) => pay(cashier, o.id, [{ method: 'UPI', amountMinor: o.totalMinor }]).expect(201)));
    const invoices = await prisma.invoice.findMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
    const numbers = invoices.map((i) => Number(i.invoiceNumber.split('/')[2])).sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(6);
    expect(numbers[5]! - numbers[0]!).toBe(5); // consecutive: no gaps, no duplicates
    expect(invoices.every((i) => i.invoiceNumber.length <= 16)).toBe(true);
  });

  it('prints a receipt that keeps matching the invoice after the menu changes', async () => {
    const o = await tea(2, { customerId: f.customerId });
    const before = await cashier.get(`/orders/${o.id}/receipt`).expect(200);
    expect(before.body.isInvoice).toBe(false);
    expect(before.body.text).toContain('BILL (NOT YET INVOICED)');
    await pay(cashier, o.id, [{ method: 'CASH', amountMinor: 21_000, tenderedMinor: 50_000 }]).expect(201);
    await prisma.product.update({ where: { id: f.tea.id }, data: { name: 'Renamed later' } });
    const receipt = await cashier.get(`/orders/${o.id}/receipt`).expect(200);
    expect(receipt.body.isInvoice).toBe(true);
    expect(receipt.body.document.lines[0]).toMatchObject({ name: 'Tea', quantity: 2, amountMinor: 20_000 });
    expect(receipt.body.document.totals).toMatchObject({ subtotalMinor: 20_000, taxMinor: 1_000, totalMinor: 21_000 });
    expect(receipt.body.text).toContain('TAX INVOICE');
    expect(receipt.body.text).toContain('2 x Tea');
    expect(receipt.body.text).toMatch(/CGST 2\.5%\s+5\.00/);
    expect(receipt.body.text).toMatch(/Tendered \/ change\s+500\.00 \/ 290\.00/);
    await prisma.product.update({ where: { id: f.tea.id }, data: { name: 'Tea' } });
  });
});

describe('refunds', () => {
  const paidAndCompleted = async (method: 'CASH' | 'UPI' = 'CASH') => {
    const o = await tea(1, { customerId: f.customerId });
    const res = await pay(cashier, o.id, [{ method, amountMinor: 10_500 }]).expect(201);
    await cashier.post(`/orders/${o.id}/complete`).expect(200);
    return { o, paymentId: res.body.payments[0].id as string };
  };
  const refund = (c: Client, paymentId: string, amountMinor: number, k = key('ref')) => c.post(`/payments/${paymentId}/refunds`, { amountMinor, reason: 'Hair in food' }, { 'Idempotency-Key': k });

  it('needs the refund permission, a reason and an idempotency key', async () => {
    const { paymentId } = await paidAndCompleted('UPI');
    await refund(cashier, paymentId, 1_000).expect(403);
    await manager.post(`/payments/${paymentId}/refunds`, { amountMinor: 1_000 }, { 'Idempotency-Key': key() }).expect(400);
    await manager.post(`/payments/${paymentId}/refunds`, { amountMinor: 1_000, reason: 'ok reason' }).expect(400);
  });

  it('records partial and full refunds as new rows with credit notes; the sale itself is never deleted', async () => {
    const { o, paymentId } = await paidAndCompleted('UPI');
    const pointsAfterSale = (await prisma.customer.findUniqueOrThrow({ where: { id: f.customerId } })).loyaltyPoints;
    const k = key('ref');
    const part = await refund(manager, paymentId, 4_000, k).expect(201);
    expect(part.body.refund.creditNoteNumber).toMatch(/^MAINC\d{4}\/\d{5}$/);
    expect((await refund(manager, paymentId, 4_000, k).expect(201)).body.replayed).toBe(true);
    expect(await get(o.id)).toMatchObject({ status: 'COMPLETED', refundedMinor: 4_000, paymentStatus: 'PARTIALLY_REFUNDED' });
    expect((await refund(manager, paymentId, 6_501).expect(409)).body.error).toMatchObject({ code: 'REFUND_TOO_LARGE', details: { refundableMinor: 6_500 } });

    await refund(manager, paymentId, 6_500).expect(201);
    const after = await get(o.id);
    expect(after).toMatchObject({ status: 'REFUNDED', paidMinor: 10_500, refundedMinor: 10_500, paymentStatus: 'REFUNDED', totalMinor: 10_500 });
    expect(after.payments).toHaveLength(1);
    expect(after.refunds).toHaveLength(2);
    expect(after.invoice).toBeTruthy();
    expect(after.events.at(-1)).toMatchObject({ type: 'REFUND', fromStatus: 'COMPLETED', toStatus: 'REFUNDED' });
    expect((await owner.get('/audit-events?action=payment.refund')).body.total).toBeGreaterThanOrEqual(2);
    // Points earned on the order are taken back when it is fully refunded.
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: f.customerId } })).loyaltyPoints).toBe(pointsAfterSale - 10);
  });

  it('concurrent refunds can never exceed the payment', async () => {
    const { o, paymentId } = await paidAndCompleted('UPI');
    const results = await Promise.all(Array.from({ length: 5 }, () => refund(manager, paymentId, 6_000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await get(o.id)).refundedMinor).toBe(6_000);
  });
});

describe('cash reconciliation', () => {
  it('expected cash counts only cash: sales, refunds and drawer movements', async () => {
    const before = (await cashier.get('/shifts/current').expect(200)).body.cash.expectedCashMinor as number;
    const cashOrder = await tea();
    const cashPay = await pay(cashier, cashOrder.id, [{ method: 'CASH', amountMinor: 10_500, tenderedMinor: 11_000 }]).expect(201);
    const upiOrder = await tea();
    await pay(cashier, upiOrder.id, [{ method: 'UPI', amountMinor: 10_500 }]).expect(201); // digital: must not move expected cash
    await cashier.post(`/shifts/${shiftId}/movements`, { type: 'CASH_IN', amountMinor: 5_000, reason: 'Change from bank' }).expect(201);
    await cashier.post(`/shifts/${shiftId}/movements`, { type: 'CASH_OUT', amountMinor: 2_000, reason: 'Paid vegetable vendor' }).expect(201);
    await cashier.post(`/shifts/${shiftId}/movements`, { type: 'PETTY_CASH', amountMinor: 500, reason: 'Tea for staff' }).expect(201);
    await cashier.post(`/shifts/${shiftId}/movements`, { type: 'CASH_OUT', amountMinor: 100 }).expect(400); // a reason is required

    // The manager refunds part of the cash sale from their own drawer.
    await openShift(manager, f.register2Id, 20_000).expect(201);
    await cashier.post(`/orders/${cashOrder.id}/complete`).expect(200);
    await manager.post(`/payments/${cashPay.body.payments[0].id}/refunds`, { amountMinor: 3_000, reason: 'Cold tea' }, { 'Idempotency-Key': key() }).expect(201);
    const managerShift = (await manager.get('/shifts/current').expect(200)).body;
    expect(managerShift.cash).toMatchObject({ refundsMinor: -3_000, expectedCashMinor: 17_000 });

    const summary = (await cashier.get('/shifts/current').expect(200)).body;
    expect(summary.cash.expectedCashMinor).toBe(before + 10_500 + 5_000 - 2_000 - 500);
    expect(summary.cash).toMatchObject({ cashInMinor: 5_000, cashOutMinor: -2_000, pettyCashMinor: -500 });
    const upi = summary.byMethod.find((m: { method: string }) => m.method === 'UPI');
    expect(upi.collectedMinor).toBeGreaterThanOrEqual(10_500);
  });

  it("a cashier cannot touch someone else's shift", async () => {
    const managerShiftId = (await manager.get('/shifts/current')).body.shift.id;
    await cashier.post(`/shifts/${managerShiftId}/movements`, { type: 'CASH_OUT', amountMinor: 1_000, reason: 'sneaky' }).expect(403);
    await cashier.post(`/shifts/${managerShiftId}/close`, { countedCashMinor: 0 }).expect(403);
    await cashier.get(`/shifts/${managerShiftId}`).expect(403);
    expect((await cashier.get('/shifts').expect(200)).body.every((s: { openedById: string }) => s.openedById === f.users.cashier.id)).toBe(true);
    expect((await manager.get('/shifts').expect(200)).body.length).toBeGreaterThanOrEqual(2);
  });

  it('a large variance needs a manager; a closed shift is final', async () => {
    const expected = (await cashier.get('/shifts/current')).body.cash.expectedCashMinor as number;
    const short = await cashier.post(`/shifts/${shiftId}/close`, { countedCashMinor: expected - 60_000, note: 'Cannot find the difference' }).expect(409);
    expect(short.body.error).toMatchObject({ code: 'VARIANCE_NEEDS_APPROVAL', details: { varianceMinor: -60_000 } });
    expect((await cashier.get('/shifts/current')).body.shift.status).toBe('OPEN');

    const closed = await manager.post(`/shifts/${shiftId}/close`, { countedCashMinor: expected - 60_000, note: 'Reviewed with cashier' }).expect(200);
    expect(closed.body.shift).toMatchObject({ status: 'CLOSED', expectedCashMinor: expected, countedCashMinor: expected - 60_000, varianceMinor: -60_000, varianceApprovedById: f.users.manager.id, closedById: f.users.manager.id });

    await manager.post(`/shifts/${shiftId}/close`, { countedCashMinor: expected }).expect(409);
    expect((await manager.post(`/shifts/${shiftId}/movements`, { type: 'CASH_IN', amountMinor: 60_000, reason: 'Found it' }).expect(409)).body.error.code).toBe('SHIFT_CLOSED');
    expect((await cashier.get('/shifts/current').expect(200)).body).toEqual({});
    const o = await tea();
    expect((await pay(cashier, o.id, [{ method: 'CASH', amountMinor: 10_500 }]).expect(409)).body.error.code).toBe('NO_OPEN_SHIFT');
    expect((await owner.get('/audit-events?action=shift.close')).body.items[0].metadata).toMatchObject({ varianceMinor: -60_000, approved: true });

    // A small variance is fine for the cashier to close alone.
    const reopened = await openShift(cashier, f.registerId, 50_000).expect(201);
    const ok = await cashier.post(`/shifts/${reopened.body.shift.id}/close`, { countedCashMinor: 49_000 }).expect(200);
    expect(ok.body.shift).toMatchObject({ varianceMinor: -1_000, varianceApprovedById: null });
  });
});
