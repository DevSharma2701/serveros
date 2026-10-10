import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../common/prisma.service';
import { addDays, csv, financialYear, localDayRange, localParts, startOfLocalDay } from '../common/util';
import { CustomersService } from '../modules/customers.module';
import { createTestApp, curryLine, key, loginAs, openShift, order, pay, seedTenant, teaLine, type Client, type Fixture } from './harness';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Fixture;
let owner: Client;
let manager: Client;
let cashier: Client;
let waiter: Client;

const today = (() => {
  const p = localParts(new Date(), 'Asia/Kolkata');
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
})();

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  f = await seedTenant(prisma, 'reports');
  owner = await loginAs(app, f.users.owner.email, f.outletId);
  manager = await loginAs(app, f.users.manager.email, f.outletId);
  cashier = await loginAs(app, f.users.cashier.email, f.outletId);
  waiter = await loginAs(app, f.users.waiter.email, f.outletId);
  await openShift(cashier, f.registerId, 100_000).expect(201);
  await openShift(manager, f.register2Id, 100_000).expect(201);
});
afterAll(() => app.close());

const complete = async (items: object[], method: 'CASH' | 'UPI', extra: object = {}) => {
  const placed = (await order(cashier, items, extra).expect(201)).body;
  const paid = (await pay(cashier, placed.id, [{ method, amountMinor: placed.totalMinor }]).expect(201)).body;
  await cashier.post(`/orders/${placed.id}/complete`).expect(200);
  return { id: placed.id as string, totalMinor: placed.totalMinor as number, paymentId: paid.payments[0].id as string };
};
const dashboard = async (query = `from=${today}&to=${today}`, c: Client = owner) => (await c.get(`/reports/dashboard?${query}`).expect(200)).body;

describe('date helpers respect the outlet time zone', () => {
  it('finds local midnight, including across daylight-saving changes', () => {
    expect(startOfLocalDay('2026-10-10', 'Asia/Kolkata').toISOString()).toBe('2026-10-09T18:30:00.000Z');
    expect(startOfLocalDay('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(startOfLocalDay('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z'); // after spring forward
    const range = localDayRange('2026-10-10', '2026-10-11', 'Asia/Kolkata');
    expect([range.gte.toISOString(), range.lt.toISOString()]).toEqual(['2026-10-09T18:30:00.000Z', '2026-10-11T18:30:00.000Z']);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(() => localDayRange('2026-10-11', '2026-10-10', 'Asia/Kolkata')).toThrow();
  });

  it('uses the Indian financial year for invoice series', () => {
    expect(financialYear(new Date('2026-03-31T12:00:00Z'), 'Asia/Kolkata')).toBe('2526');
    expect(financialYear(new Date('2026-03-31T19:00:00Z'), 'Asia/Kolkata')).toBe('2627'); // already 1 April in India
  });

  it('writes CSV safely', () => {
    expect(csv([['a', 'b'], ['x,y', 'say "hi"'], ['=SUM(A1)', -5]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n\'=SUM(A1),-5\r\n');
  });
});

describe('sales dashboard', () => {
  let refunded: Awaited<ReturnType<typeof complete>>;
  let lateNight: Awaited<ReturnType<typeof complete>>;

  beforeAll(async () => {
    // O1: 2 tea, 10% off      -> gross 200, discount 20, net 180, tax 9,  total 189  (cash)
    await complete([teaLine(f, 2)], 'CASH', { orderDiscount: { type: 'PERCENT', value: 1000, reason: 'Regular guest' } });
    // O2: curry full + butter -> gross 320,              net 320, tax 16, total 336  (UPI)
    lateNight = await complete([curryLine(f, 'full', [f.mods.mild, f.mods.butter])], 'UPI');
    // O3: placed then cancelled -> not a sale
    const cancelled = (await order(cashier, [teaLine(f)]).expect(201)).body;
    await manager.post(`/orders/${cancelled.id}/cancel`, { reason: 'guest left' }).expect(200);
    // O4: paid but still open -> money collected, not yet a sale
    const open = (await order(cashier, [teaLine(f)]).expect(201)).body;
    await pay(cashier, open.id, [{ method: 'UPI', amountMinor: 10_500 }]).expect(201);
    // O5: 1 tea, completed, then fully refunded -> still a sale; refund reported separately
    refunded = await complete([teaLine(f)], 'CASH');
    await manager.post(`/payments/${refunded.paymentId}/refunds`, { amountMinor: 10_500, reason: 'Complaint' }, { 'Idempotency-Key': key() }).expect(201);
  });

  it('calculates every headline figure from real orders, with documented definitions', async () => {
    const d = await dashboard();
    expect(d.summary).toMatchObject({
      orders: 3,
      grossSalesMinor: 62_000,
      discountsMinor: 2_000,
      netSalesMinor: 60_000,
      taxesMinor: 3_000,
      totalBilledMinor: 63_000,
      averageOrderValueMinor: 21_000,
      collectedMinor: 73_500,
      refundsMinor: 10_500,
      netCollectedMinor: 63_000,
      cancelledOrders: 1,
      openOrders: 1,
    });
    expect(d.summary.netSalesMinor + d.summary.taxesMinor + d.summary.roundOffMinor).toBe(d.summary.totalBilledMinor);
    expect(Object.keys(d.definitions)).toEqual(expect.arrayContaining(['grossSales', 'netSales', 'refunds', 'collected']));
  });

  it('breaks sales down by payment method, type, product, category and tax without double counting', async () => {
    const d = await dashboard();
    const method = (m: string) => d.paymentsByMethod.find((p: { method: string }) => p.method === m);
    expect(method('CASH')).toMatchObject({ amountMinor: 29_400, refundedMinor: 10_500, count: 2 });
    expect(method('UPI')).toMatchObject({ amountMinor: 44_100, refundedMinor: 0, count: 2 });
    expect(d.salesByType).toEqual([{ type: 'TAKEAWAY', orders: 3, totalMinor: 63_000 }]);
    expect(d.topProducts.map((p: { name: string; quantity: number; netSalesMinor: number }) => [p.name, p.quantity, p.netSalesMinor])).toEqual([['Tea', 3, 28_000], ['Curry', 1, 32_000]]);
    expect(d.categories).toEqual([{ name: 'Food', quantity: 4, netSalesMinor: 60_000 }]);
    expect(d.taxes.map((t: { name: string; amountMinor: number }) => [t.name, t.amountMinor]).sort()).toEqual([['CGST 2.5%', 1_500], ['SGST 2.5%', 1_500]]);
    expect(d.daily).toEqual([{ day: today, orders: 3, totalMinor: 63_000, netSalesMinor: 60_000 }]);
    expect(d.hourly.reduce((a: number, h: { orders: number }) => a + h.orders, 0)).toBe(3);
    expect(d.outletComparison).toEqual([
      { outletId: f.outletId, outlet: 'Main', orders: 3, netSalesMinor: 60_000, totalBilledMinor: 63_000, cancelledOrders: 1 },
      { outletId: f.outlet2Id, outlet: 'Second', orders: 0, netSalesMinor: 0, totalBilledMinor: 0, cancelledOrders: 0 },
    ]);
  });

  it('assigns an order to the right day in the outlet time zone', async () => {
    // 00:30 on the local calendar day is still "yesterday" in UTC.
    const justAfterMidnight = new Date(startOfLocalDay(today, 'Asia/Kolkata').getTime() + 30 * 60_000);
    await prisma.order.update({ where: { id: lateNight.id }, data: { completedAt: justAfterMidnight } });
    expect(justAfterMidnight.toISOString().slice(0, 10)).not.toBe(today);
    const d = await dashboard();
    expect(d.summary.orders).toBe(3);
    expect(d.hourly.find((h: { hour: number }) => h.hour === 0)).toMatchObject({ orders: 1, totalMinor: 33_600 });
    const yesterday = addDays(today, -1);
    expect((await dashboard(`from=${yesterday}&to=${yesterday}`)).summary.orders).toBe(0);

    // One minute before local midnight belongs to the previous day.
    await prisma.order.update({ where: { id: lateNight.id }, data: { completedAt: new Date(startOfLocalDay(today, 'Asia/Kolkata').getTime() - 60_000) } });
    expect((await dashboard()).summary.orders).toBe(2);
    expect((await dashboard(`from=${yesterday}&to=${yesterday}`)).summary).toMatchObject({ orders: 1, totalBilledMinor: 33_600 });
    expect((await dashboard(`from=${yesterday}&to=${today}`)).daily.map((x: { day: string }) => x.day)).toEqual([yesterday, today]);
    await prisma.order.update({ where: { id: lateNight.id }, data: { completedAt: new Date() } });
  });

  it('filters by outlet and reports cash variance from closed shifts', async () => {
    expect((await dashboard(`from=${today}&to=${today}&outletIds=${f.outlet2Id}`)).summary.orders).toBe(0);
    await owner.get(`/reports/dashboard?from=${today}&to=${today}&outletIds=nonsense`).expect(400);
    await owner.get('/reports/dashboard?from=10-10-2026&to=2026-10-10').expect(400);

    const shift = (await cashier.get('/shifts/current').expect(200)).body;
    await cashier.post(`/shifts/${shift.shift.id}/close`, { countedCashMinor: shift.cash.expectedCashMinor - 1_500 }).expect(200);
    const d = await dashboard();
    expect(d.summary.cashVarianceMinor).toBe(-1_500);
    expect(d.cashShifts[0]).toMatchObject({ varianceMinor: -1_500, register: 'Counter 1', outlet: 'Main' });
  });

  it('exports CSV only to those allowed, and logs the export', async () => {
    const stores = await loginAs(app, f.users.inventory.email, f.outletId);
    await stores.get(`/reports/dashboard?from=${today}&to=${today}`).expect(200); // may view
    await stores.get(`/reports/export.csv?from=${today}&to=${today}&dataset=orders`).expect(403); // may not export
    await cashier.get(`/reports/export.csv?from=${today}&to=${today}&dataset=orders`).expect(403);

    const orders = await owner.get(`/reports/export.csv?from=${today}&to=${today}&dataset=orders`).expect(200);
    expect(orders.headers['content-type']).toMatch(/text\/csv/);
    expect(orders.headers['content-disposition']).toMatch(/attachment; filename="serveos-orders-/);
    const lines = orders.text.trim().split('\r\n');
    expect(lines[0]).toBe('Outlet,Order,Invoice,Type,Status,Completed (local),Gross,Discounts,Service charge,Delivery charge,Net sales,Tax,Round off,Total,Paid,Refunded');
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.includes(',REFUNDED,') && l.endsWith('100.00,0.00,0.00,0.00,100.00,5.00,0.00,105.00,105.00,105.00'))).toBe(true);

    const items = await owner.get(`/reports/export.csv?from=${today}&to=${today}&dataset=items`).expect(200);
    expect(items.text.trim().split('\r\n')).toHaveLength(4);
    const payments = await owner.get(`/reports/export.csv?from=${today}&to=${today}&dataset=payments`).expect(200);
    expect(payments.text).toMatch(/REFUND,.*,-105\.00/);
    await owner.get(`/reports/export.csv?from=${today}&to=${today}&dataset=secrets`).expect(400);
    expect((await owner.get('/audit-events?action=report.export')).body.total).toBe(3);
  });
});

describe('customers and loyalty', () => {
  const points = async () => (await prisma.customer.findUniqueOrThrow({ where: { id: f.customerId } })).loyaltyPoints;

  it('shows contact details and notes only to roles allowed to see them', async () => {
    const asWaiter = (await waiter.get('/customers?q=asha').expect(200)).body.items[0];
    expect(asWaiter).toMatchObject({ name: 'Asha Rao', phone: '••••••3210', email: 'a•••@example.test' });
    expect(asWaiter.notes).toBeUndefined();
    const asCashier = (await cashier.get(`/customers/${f.customerId}`).expect(200)).body;
    expect(asCashier.phone).toBe('9876543210');
    expect(asCashier.notes).toBeUndefined();
    expect((await manager.get(`/customers/${f.customerId}`).expect(200)).body.notes).toBe('Allergic to nuts');
    expect((await cashier.get('/customers?q=3210').expect(200)).body.total).toBe(1); // search by phone digits
    await cashier.patch(`/customers/${f.customerId}`, { notes: 'VIP' }).expect(403);
    await waiter.post('/customers', { name: 'Walk In' }).expect(403);
  });

  it('prevents duplicate phone numbers and records consent changes', async () => {
    expect((await cashier.post('/customers', { name: 'Someone Else', phone: '98765 43210' }).expect(409)).body.error.code).toBe('CUSTOMER_EXISTS');
    await cashier.post('/customers', { name: 'Bad Phone', phone: 'abc' }).expect(400);
    const created = (await cashier.post('/customers', { name: 'Vikram', phone: '+91 90000 11111', marketingSms: true }).expect(201)).body;
    expect(created).toMatchObject({ phone: '+919000011111', marketingSms: true });
    expect(created.consentUpdatedAt).toBeTruthy();
    await cashier.patch(`/customers/${created.id}`, { name: 'Vikram S' }).expect(200);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: created.id } })).marketingSms).toBe(true); // untouched by a partial update
    await cashier.patch(`/customers/${created.id}`, { marketingSms: false }).expect(200);
    expect((await owner.get('/audit-events?action=customer.consent_change')).body.total).toBe(1);
  });

  it('awards points once per completed order, even if the event is processed again', async () => {
    const before = await points();
    const done = await complete([teaLine(f)], 'UPI', { customerId: f.customerId }); // 105.00 paid, 10 points per 100
    expect(await points()).toBe(before + 10);
    const customers = app.get(CustomersService);
    await prisma.tx((tx) => customers.accrueForOrder(tx, done.id, f.users.cashier.id)); // a retried completion event
    await prisma.tx((tx) => customers.accrueForOrder(tx, done.id, f.users.cashier.id));
    expect(await points()).toBe(before + 10);
    expect(await prisma.loyaltyLedgerEntry.count({ where: { orderId: done.id, type: 'EARN' } })).toBe(1);
    const detail = (await cashier.get(`/customers/${f.customerId}`).expect(200)).body;
    expect(detail.ledger[0]).toMatchObject({ type: 'EARN', points: 10, balanceAfter: before + 10 });
    expect(detail.orders.map((o: { id: string }) => o.id)).toContain(done.id);
  });

  it('redeems points as a tender, through the ledger, and never below zero', async () => {
    await manager.post(`/customers/${f.customerId}/loyalty/adjust`, { points: 40, reason: 'Goodwill credit' }).expect(201);
    await cashier.post(`/customers/${f.customerId}/loyalty/adjust`, { points: 500, reason: 'For my friend' }).expect(403);
    const start = await points();

    const placed = (await order(cashier, [teaLine(f)], { customerId: f.customerId }).expect(201)).body; // 105.00
    await pay(cashier, placed.id, [{ method: 'LOYALTY', amountMinor: 500 }, { method: 'UPI', amountMinor: 10_000 }]).expect(400); // 5 points: below the minimum of 10
    await pay(cashier, placed.id, [{ method: 'LOYALTY', amountMinor: 1_050 }, { method: 'UPI', amountMinor: 9_450 }]).expect(400); // not whole points
    expect((await pay(cashier, placed.id, [{ method: 'LOYALTY', amountMinor: (start + 1) * 100 }, { method: 'UPI', amountMinor: 10_500 - (start + 1) * 100 }]).expect(409)).body.error.code).toBe('INSUFFICIENT_POINTS');
    expect(await points()).toBe(start);
    expect(await prisma.payment.count({ where: { orderId: placed.id } })).toBe(0); // the whole split was rolled back

    await pay(cashier, placed.id, [{ method: 'LOYALTY', amountMinor: 2_000 }, { method: 'UPI', amountMinor: 8_500 }]).expect(201);
    expect(await points()).toBe(start - 20);
    await cashier.post(`/orders/${placed.id}/complete`).expect(200);
    expect(await points()).toBe(start - 20 + 8); // only the 85.00 paid in money earns points

    const anonymous = (await order(cashier, [teaLine(f)]).expect(201)).body;
    expect((await pay(cashier, anonymous.id, [{ method: 'LOYALTY', amountMinor: 1_000 }, { method: 'UPI', amountMinor: 9_500 }]).expect(400)).body.error.code).toBe('CUSTOMER_REQUIRED');
    expect((await manager.post(`/customers/${f.customerId}/loyalty/adjust`, { points: -99_999, reason: 'Clear balance' }).expect(409)).body.error.code).toBe('INSUFFICIENT_POINTS');
  });
});
