import './razorpay-env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../common/prisma.service';
import { OrdersService } from '../modules/orders.module';
import { PaymentsService } from '../modules/payments.module';
import { createTestApp, key, lineId, loginAs, order, pay, seedTenant, teaLine, type Client, type Fixture } from './harness';

const KEY_ID = process.env.PAYMENT_API_KEY!;
const KEY_SECRET = process.env.PAYMENT_API_SECRET!;
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET!;
const sign = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex');

/** A stand-in for api.razorpay.com that remembers what it was asked. */
const razorpay = {
  down: false,
  refuseRefunds: false,
  orders: new Map<string, { amount: number; status: 'created' | 'paid'; paymentId?: string }>(),
  requests: [] as Array<{ method: string; path: string; body: Record<string, unknown> | null; auth: string }>,
  capture(orderId: string) {
    const paymentId = `pay_${orderId.slice(6)}`;
    Object.assign(this.orders.get(orderId)!, { status: 'paid', paymentId });
    return paymentId;
  },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Fixture;
let owner: Client;
let manager: Client;
let cashier: Client;
let token: string;
const realFetch = global.fetch;

beforeAll(async () => {
  global.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith('https://api.razorpay.com/v1')) throw new Error(`unexpected outbound request to ${url}`);
    if (razorpay.down) throw new TypeError('fetch failed');
    const path = url.replace('https://api.razorpay.com/v1', '');
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    razorpay.requests.push({ method: init.method ?? 'GET', path, body, auth: String((init.headers as Record<string, string>).Authorization) });
    if (init.method === 'POST' && path === '/orders') {
      const id = `order_T${razorpay.orders.size + 1}`;
      razorpay.orders.set(id, { amount: Number(body!.amount), status: 'created' });
      return json({ id, amount: body!.amount, status: 'created' });
    }
    const orderMatch = /^\/orders\/(order_\w+)(\/payments)?$/.exec(path);
    if (orderMatch) {
      const o = razorpay.orders.get(orderMatch[1]!);
      if (!o) return json({ error: { description: 'not found' } }, 404);
      if (orderMatch[2]) return json({ items: o.paymentId ? [{ id: o.paymentId, status: 'captured' }] : [] });
      return json({ id: orderMatch[1], status: o.status, amount_paid: o.status === 'paid' ? o.amount : 0 });
    }
    if (init.method === 'POST' && /^\/payments\/pay_\w+\/refund$/.test(path)) return razorpay.refuseRefunds ? json({ error: { description: 'insufficient balance in account' } }, 400) : json({ id: 'rfnd_1' });
    return json({ error: { description: 'unknown route' } }, 404);
  }) as typeof fetch;

  ({ app, prisma } = await createTestApp());
  f = await seedTenant(prisma, 'rzp');
  owner = await loginAs(app, f.users.owner.email, f.outletId);
  manager = await loginAs(app, f.users.manager.email, f.outletId);
  cashier = await loginAs(app, f.users.cashier.email, f.outletId);
  await owner.patch(`/outlets/${f.outletId}`, { qrOrderingEnabled: true }).expect(200);
  token = (await owner.get('/qr-codes').expect(200)).body.tables[0].qrToken;
});
afterAll(async () => {
  global.fetch = realFetch;
  await app.close();
});
beforeEach(async () => {
  razorpay.down = false;
  razorpay.refuseRefunds = false;
  // Each test starts with no unpaid guest orders, so the per-table cap is not what is being tested here.
  await prisma.order.updateMany({ where: { source: 'QR', status: 'PLACED', paidMinor: 0 }, data: { status: 'CANCELLED' } });
});

const pub = () => request(app.getHttpServer());
const tea = (quantity = 1) => ({ clientLineId: lineId(), productId: f.tea.id, variantId: f.tea.variantId, quantity });
const view = async (guestToken: string) => (await pub().get(`/api/v1/public/orders/${guestToken}`).expect(200)).body;
/** A guest orders one tea (105.00) and taps Pay: returns the order and the provider's order id. */
const start = async () => {
  const placed = (await pub().post(`/api/v1/public/tables/${token}/orders`).set('Idempotency-Key', key('qr')).send({ items: [tea()] }).expect(201)).body;
  const pending = (await pub().post(`/api/v1/public/orders/${placed.guestToken}/pay`).send({ method: 'UPI' }).expect(200)).body;
  return { guestToken: placed.guestToken as string, rzpOrder: pending.payment.checkout.orderId as string, pending };
};
const confirm = (guestToken: string, rzpOrder: string, paymentId: string, signature = sign(KEY_SECRET, `${rzpOrder}|${paymentId}`)) =>
  pub().post(`/api/v1/public/orders/${guestToken}/confirm`).send({ razorpay_order_id: rzpOrder, razorpay_payment_id: paymentId, razorpay_signature: signature });
const webhook = (body: object, eventId: string, secret = WEBHOOK_SECRET) => {
  const raw = JSON.stringify(body);
  return pub().post('/api/v1/payments/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sign(secret, raw)).set('X-Razorpay-Event-Id', eventId).send(raw);
};
const orderPaid = (rzpOrder: string, paymentId: string, amount = 10_500) => ({
  event: 'order.paid',
  payload: { order: { entity: { id: rzpOrder, amount, amount_paid: amount, status: 'paid' } }, payment: { entity: { id: paymentId, order_id: rzpOrder, amount, status: 'captured' } } },
});
const saved = (guestToken: string) => prisma.order.findUniqueOrThrow({ where: { guestToken }, include: { payments: true, events: true } });

describe('starting a Razorpay payment', () => {
  it('creates a Razorpay order for the exact server total and gives the page only public values', async () => {
    const { pending, rzpOrder } = await start();
    expect(pending.payment).toMatchObject({ state: 'PENDING', provider: 'razorpay', checkout: { provider: 'razorpay', keyId: KEY_ID, orderId: rzpOrder, amountMinor: 10_500, currency: 'INR' } });
    expect(JSON.stringify(pending)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(pending)).not.toContain(WEBHOOK_SECRET);

    const created = razorpay.requests.filter((r) => r.path === '/orders').at(-1)!;
    expect(created.body).toMatchObject({ amount: 10_500, currency: 'INR' });
    expect(Buffer.from(created.auth.replace('Basic ', ''), 'base64').toString()).toBe(`${KEY_ID}:${KEY_SECRET}`);
    expect((await pub().get(`/api/v1/public/tables/${token}`).expect(200)).body.onlinePayment).toBe('razorpay');
  });

  it('tapping Pay again reuses the same Razorpay order', async () => {
    const { guestToken, rzpOrder } = await start();
    const before = razorpay.orders.size;
    const again = (await pub().post(`/api/v1/public/orders/${guestToken}/pay`).send({}).expect(200)).body;
    expect(again.payment.checkout.orderId).toBe(rzpOrder);
    expect(razorpay.orders.size).toBe(before);
  });

  it('if Razorpay cannot be reached, nothing is left half-created', async () => {
    const placed = (await pub().post(`/api/v1/public/tables/${token}/orders`).set('Idempotency-Key', key('qr')).send({ items: [tea()] }).expect(201)).body;
    razorpay.down = true;
    const res = await pub().post(`/api/v1/public/orders/${placed.guestToken}/pay`).send({}).expect(502);
    expect(res.body.error.code).toBe('GATEWAY_UNREACHABLE');
    expect((await saved(placed.guestToken)).payments).toHaveLength(0);
    razorpay.down = false;
    await pub().post(`/api/v1/public/orders/${placed.guestToken}/pay`).send({}).expect(200);
  });

  it('the simulator is not available with a real provider, and the counter records card/UPI by hand', async () => {
    const { guestToken } = await start();
    await pub().post(`/api/v1/public/orders/${guestToken}/dev-pay`).send({ outcome: 'success' }).expect(404);
    expect((await view(guestToken)).status).toBe('PLACED');
    expect((await owner.get('/auth/me').expect(200)).body.paymentGateway).toBe('razorpay');
    const staffOrder = (await order(cashier, [teaLine(f)]).expect(201)).body;
    expect((await pay(cashier, staffOrder.id, [{ method: 'UPI', amountMinor: 10_500, mode: 'GATEWAY' }]).expect(400)).body.error.code).toBe('GATEWAY_NOT_CONFIGURED');
    await pay(cashier, staffOrder.id, [{ method: 'UPI', amountMinor: 10_500, reference: 'UPI-REF-1' }]).expect(201);
  });
});

describe('confirmation returned by the checkout page', () => {
  it('is accepted only with a genuine signature for this very order', async () => {
    const a = await start();
    const b = await start();
    const payA = razorpay.capture(a.rzpOrder);

    await confirm(a.guestToken, a.rzpOrder, payA, 'f'.repeat(64)).expect(401); // forged
    await confirm(a.guestToken, a.rzpOrder, payA, sign('some-other-secret', `${a.rzpOrder}|${payA}`)).expect(401);
    await pub().post(`/api/v1/public/orders/${a.guestToken}/confirm`).send({ razorpay_order_id: a.rzpOrder }).expect(401); // incomplete
    // A genuine signature for order A must not pay order B.
    await confirm(b.guestToken, a.rzpOrder, payA).expect(401);
    expect((await view(b.guestToken)).status).toBe('PLACED');
  });

  it('settles the payment, sends the order to the kitchen and stores the provider payment id', async () => {
    const { guestToken, rzpOrder } = await start();
    const paymentId = razorpay.capture(rzpOrder);
    expect((await view(guestToken)).kitchen.tickets).toBe(0);
    const res = (await confirm(guestToken, rzpOrder, paymentId).expect(200)).body;
    expect(res).toMatchObject({ status: 'CONFIRMED', payment: { state: 'PAID', checkout: null }, kitchen: { tickets: 1 } });
    const o = await saved(guestToken);
    expect(o.payments[0]).toMatchObject({ state: 'SUCCEEDED', verification: 'GATEWAY', provider: 'razorpay', reference: paymentId, amountMinor: 10_500 });
    expect(o.paidMinor).toBe(10_500);

    // The same confirmation again, and the webhook for the same payment, change nothing.
    await confirm(guestToken, rzpOrder, paymentId).expect(200);
    expect((await webhook(orderPaid(rzpOrder, paymentId), 'evt_after_confirm').expect(200)).body.status).toBe('already_final');
    expect((await saved(guestToken)).paidMinor).toBe(10_500);
    expect(await prisma.kitchenTicket.count({ where: { orderId: o.id } })).toBe(1);
  });
});

describe('webhooks', () => {
  it('rejects a webhook that is not signed with our secret', async () => {
    const { guestToken, rzpOrder } = await start();
    await webhook(orderPaid(rzpOrder, 'pay_x'), 'evt_forged', 'attacker-secret').expect(401);
    await pub().post('/api/v1/payments/webhooks/razorpay').send(orderPaid(rzpOrder, 'pay_x')).expect(401);
    await pub().post('/api/v1/payments/webhooks/dev').send({}).expect(404); // the simulator's endpoint is closed
    expect((await view(guestToken)).status).toBe('PLACED');
  });

  it('order.paid settles the order when the guest never returns to the page; a repeat is ignored', async () => {
    const { guestToken, rzpOrder } = await start();
    const paymentId = razorpay.capture(rzpOrder);
    expect((await webhook(orderPaid(rzpOrder, paymentId), 'evt_paid_1').expect(200)).body.status).toBe('processed');
    expect((await webhook(orderPaid(rzpOrder, paymentId), 'evt_paid_1').expect(200)).body.status).toBe('duplicate');
    expect(await view(guestToken)).toMatchObject({ status: 'CONFIRMED', payment: { state: 'PAID' } });
    expect((await saved(guestToken)).payments[0]!.reference).toBe(paymentId);
  });

  it('a failed attempt is not final: the guest can still pay the same request', async () => {
    const { guestToken, rzpOrder } = await start();
    const failed = { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_failed1', order_id: rzpOrder, amount: 10_500, status: 'failed' } } } };
    expect((await webhook(failed, 'evt_failed_1').expect(200)).body.status).toBe('ignored');
    expect(await view(guestToken)).toMatchObject({ status: 'PLACED', payment: { state: 'PENDING' } });
    const paymentId = razorpay.capture(rzpOrder);
    await confirm(guestToken, rzpOrder, paymentId).expect(200);
    expect((await view(guestToken)).status).toBe('CONFIRMED');
  });

  it('does not accept a confirmation for a different amount', async () => {
    const { guestToken, rzpOrder } = await start();
    await webhook(orderPaid(rzpOrder, 'pay_small', 100), 'evt_amount').expect(200);
    const o = await saved(guestToken);
    expect(o.paidMinor).toBe(0);
    expect(o.payments[0]).toMatchObject({ state: 'FAILED', failureReason: 'Amount does not match the payment request' });
    expect(o.status).toBe('PLACED');
  });
});

describe('when a confirmation never arrives', () => {
  const age = (guestToken: string, minutes: number) =>
    prisma.order.update({ where: { guestToken }, data: { createdAt: new Date(Date.now() - minutes * 60_000), payments: { updateMany: { where: {}, data: { createdAt: new Date(Date.now() - minutes * 60_000) } } } } });

  it('reconciliation asks Razorpay and settles what was really paid', async () => {
    const paid = await start();
    const unpaid = await start();
    razorpay.capture(paid.rzpOrder); // paid at Razorpay, but no webhook and no return to the page
    await age(paid.guestToken, 3);
    await age(unpaid.guestToken, 3);
    expect(await app.get(PaymentsService).reconcilePending()).toBe(1);
    expect(await view(paid.guestToken)).toMatchObject({ status: 'CONFIRMED', payment: { state: 'PAID' } });
    expect((await view(unpaid.guestToken)).payment.state).toBe('PENDING');
    expect(await app.get(PaymentsService).reconcilePending()).toBe(0); // nothing new the second time
  });

  it('survives Razorpay being down and tries again later', async () => {
    const { guestToken, rzpOrder } = await start();
    razorpay.capture(rzpOrder);
    await age(guestToken, 3);
    razorpay.down = true;
    await expect(app.get(PaymentsService).reconcilePending()).resolves.toBe(0);
    expect((await view(guestToken)).status).toBe('PLACED');
    razorpay.down = false;
    expect(await app.get(PaymentsService).reconcilePending()).toBe(1);
  });

  it('gives a guest who is mid-payment extra time, and flags money that arrives after an order expired', async () => {
    const { guestToken, rzpOrder } = await start();
    await age(guestToken, 16);
    await app.get(OrdersService).expireUnpaidGuestOrders();
    expect((await view(guestToken)).status).toBe('PLACED'); // still paying: not cancelled at 15 minutes
    await age(guestToken, 46);
    await app.get(OrdersService).expireUnpaidGuestOrders();
    expect((await view(guestToken)).status).toBe('CANCELLED');

    // The guest's bank completes the payment anyway. It must be recorded, never lost.
    const paymentId = razorpay.capture(rzpOrder);
    expect((await webhook(orderPaid(rzpOrder, paymentId), 'evt_late').expect(200)).body.status).toBe('processed');
    const o = await saved(guestToken);
    expect(o).toMatchObject({ status: 'CANCELLED', paidMinor: 10_500 });
    expect(o.payments[0]!.state).toBe('SUCCEEDED');
    expect(o.events.some((e) => e.type === 'ATTENTION' && /after this order was cancelled/.test(e.message))).toBe(true);
    expect(await prisma.kitchenTicket.count({ where: { orderId: o.id } })).toBe(0); // and it is not cooked
    // Staff refund it through Razorpay.
    await manager.post(`/payments/${o.payments[0]!.id}/refunds`, { amountMinor: 10_500, reason: 'Paid after the order expired' }, { 'Idempotency-Key': key('ref') }).expect(201);
  });
});

describe('refunds', () => {
  const paidOrder = async () => {
    const { guestToken, rzpOrder } = await start();
    const paymentId = razorpay.capture(rzpOrder);
    await confirm(guestToken, rzpOrder, paymentId).expect(200);
    return { o: await saved(guestToken), paymentId };
  };

  it('are sent to Razorpay against the captured payment', async () => {
    const { o, paymentId } = await paidOrder();
    await manager.post(`/payments/${o.payments[0]!.id}/refunds`, { amountMinor: 4_000, reason: 'Cold tea' }, { 'Idempotency-Key': key('ref') }).expect(201);
    expect(razorpay.requests.at(-1)).toMatchObject({ method: 'POST', path: `/payments/${paymentId}/refund`, body: { amount: 4_000 } });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).refundedMinor).toBe(4_000);
  });

  it('are not recorded if Razorpay refuses them, and its reason is not shown to the user', async () => {
    const { o } = await paidOrder();
    razorpay.refuseRefunds = true;
    const res = await manager.post(`/payments/${o.payments[0]!.id}/refunds`, { amountMinor: 4_000, reason: 'Cold tea' }, { 'Idempotency-Key': key('ref') }).expect(502);
    expect(res.body.error.code).toBe('GATEWAY_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('insufficient balance');
    expect(await prisma.refund.count({ where: { orderId: o.id } })).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).refundedMinor).toBe(0);
  });
});
