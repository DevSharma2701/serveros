import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../common/prisma.service';
import { createTestApp, curryLine, key, loginAs, openShift, order, pay, seedTenant, teaLine, type Client, type Fixture } from './harness';

let app: NestExpressApplication;
let prisma: PrismaService;
let f: Fixture;
let owner: Client;
let manager: Client;
let cashier: Client;
let waiter: Client;

beforeAll(async () => {
  ({ app, prisma } = await createTestApp());
  f = await seedTenant(prisma, 'orders');
  owner = await loginAs(app, f.users.owner.email, f.outletId);
  manager = await loginAs(app, f.users.manager.email, f.outletId);
  cashier = await loginAs(app, f.users.cashier.email, f.outletId);
  waiter = await loginAs(app, f.users.waiter.email, f.outletId);
  await openShift(cashier, f.registerId).expect(201);
});
afterAll(() => app.close());

describe('pricing is decided by the server', () => {
  it('prices variants and modifiers from the menu and adds tax', async () => {
    const res = await order(cashier, [curryLine(f, 'full', [f.mods.hot, f.mods.butter, f.mods.cheese]), teaLine(f, 2)]).expect(201);
    // Curry 300 + butter 20 + cheese 30 = 350; tea 2 x 100 = 200; subtotal 550; GST 5% = 27.50
    expect(res.body).toMatchObject({ subtotalMinor: 55_000, taxableMinor: 55_000, taxMinor: 2_750, totalMinor: 57_750, status: 'CONFIRMED', dueMinor: 57_750 });
    expect(res.body.orderNumber).toMatch(/^\d{6}-\d{4}$/);
    const curry = res.body.items.find((i: { productName: string }) => i.productName === 'Curry');
    expect(curry).toMatchObject({ variantName: 'Full', unitPriceMinor: 30_000, modifiersMinor: 5_000, lineSubtotalMinor: 35_000, taxMinor: 1_750 });
    expect(curry.modifiers.map((m: { optionName: string }) => m.optionName).sort()).toEqual(['Butter', 'Cheese', 'Hot']);
    expect(res.body.taxLines.map((t: { name: string; amountMinor: number }) => [t.name, t.amountMinor]).sort()).toEqual([['CGST 2.5%', 1_375], ['SGST 2.5%', 1_375]]);
  });

  it('ignores prices and totals sent by the client', async () => {
    const line = { ...teaLine(f), unitPriceMinor: 1, priceMinor: 1, totalMinor: 1 };
    const res = await cashier.post('/orders', { type: 'TAKEAWAY', items: [line], totalMinor: 1, taxMinor: 0 }, { 'Idempotency-Key': key() }).expect(201);
    expect(res.body.totalMinor).toBe(10_500);
    const quote = await cashier.post('/orders/quote', { type: 'TAKEAWAY', items: [line] }).expect(200);
    expect(quote.body.totalMinor).toBe(10_500);
  });

  it('enforces modifier rules', async () => {
    const bad = async (mods: string[], message: RegExp) => {
      const res = await order(cashier, [curryLine(f, 'full', mods)]).expect(400);
      expect(res.body.error.code).toBe('INVALID_MODIFIERS');
      expect(res.body.error.message).toMatch(message);
    };
    await bad([], /at least 1 from "Spice"/);
    await bad([f.mods.mild, f.mods.hot], /at most 1 from "Spice"/);
    await bad([f.mods.mild, f.mods.butter, f.mods.cheese, f.mods.egg], /at most 2 from "Extras"/);
    await order(cashier, [teaLine(f, 1, { modifierOptionIds: [f.mods.butter] })]).expect(400); // tea has no modifier groups
    await order(cashier, [curryLine(f, 'full'), { ...curryLine(f), variantId: f.tea.variantId }]).expect(409); // variant of another product
    await order(cashier, [teaLine(f, 0)]).expect(400);
    await order(cashier, []).expect(400);
  });

  it('refuses unavailable items and uses outlet-specific prices', async () => {
    await owner.put(`/menu/products/${f.tea.id}/availability`, { isAvailable: false }).expect(200);
    const res = await order(cashier, [teaLine(f)]).expect(409);
    expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
    await owner.put(`/menu/products/${f.tea.id}/availability`, { isAvailable: true, variantPrices: [{ variantId: f.tea.variantId, priceMinor: 12_000 }] }).expect(200);
    expect((await order(cashier, [teaLine(f)]).expect(201)).body.subtotalMinor).toBe(12_000);
    await owner.put(`/menu/products/${f.tea.id}/availability`, { isAvailable: true, variantPrices: [{ variantId: f.tea.variantId, priceMinor: null }] }).expect(200);
    expect((await order(cashier, [teaLine(f)]).expect(201)).body.subtotalMinor).toBe(10_000);
  });

  it('keeps the price on an existing bill when the menu changes later', async () => {
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    const product = await owner.get(`/menu/products/${f.tea.id}`).expect(200);
    await owner.patch(`/menu/products/${f.tea.id}`, { name: 'Chai', variants: [{ id: product.body.variants[0].id, name: 'Regular', priceMinor: 15_000, isDefault: true }] }).expect(200);
    const again = await cashier.post(`/orders/${placed.body.id}/items`, { items: [teaLine(f)] }).expect(200);
    const [first, second] = again.body.items;
    expect(first).toMatchObject({ productName: 'Tea', unitPriceMinor: 10_000 }); // unchanged snapshot
    expect(second).toMatchObject({ productName: 'Chai', unitPriceMinor: 15_000 }); // new item at the new price
    expect(again.body.subtotalMinor).toBe(25_000);
    await owner.patch(`/menu/products/${f.tea.id}`, { name: 'Tea', variants: [{ id: product.body.variants[0].id, name: 'Regular', priceMinor: 10_000, isDefault: true }] }).expect(200);
  });

  it('uses IGST for an inter-state place of supply', async () => {
    const res = await order(cashier, [teaLine(f)], { placeOfSupplyStateCode: '27' }).expect(201);
    expect(res.body.taxLines).toHaveLength(1);
    expect(res.body.taxLines[0]).toMatchObject({ component: 'IGST', amountMinor: 500 });
  });
});

describe('duplicate requests', () => {
  it('returns the same order when a request is retried with the same key', async () => {
    const k = key('retry');
    const first = await order(cashier, [teaLine(f)], {}, k).expect(201);
    const second = await order(cashier, [teaLine(f, 5)], {}, k).expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.replayed).toBe(true);
    expect(second.body.totalMinor).toBe(first.body.totalMinor);
  });

  it('creates exactly one order when the same request arrives many times at once', async () => {
    const k = key('burst');
    const before = await prisma.order.count();
    const line = teaLine(f);
    const results = await Promise.all(Array.from({ length: 8 }, () => order(cashier, [line], {}, k)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.order.count()).toBe(before + 1);
    expect(await prisma.kitchenTicket.count({ where: { orderId: results[0]!.body.id } })).toBe(1);
  });

  it('gives every order its own number even under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => order(cashier, [teaLine(f)])));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.orderNumber)).size).toBe(10);
  });

  it('does not add the same items twice when "add items" is retried', async () => {
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    const extra = teaLine(f);
    await cashier.post(`/orders/${placed.body.id}/items`, { items: [extra] }).expect(200);
    const retried = await cashier.post(`/orders/${placed.body.id}/items`, { items: [extra] }).expect(200);
    expect(retried.body.items).toHaveLength(2);
    expect(retried.body.totalMinor).toBe(21_000);
  });
});

describe('discounts and coupons', () => {
  it('lets a cashier discount up to the threshold but not beyond it', async () => {
    const ok = await order(cashier, [teaLine(f, 2)], { orderDiscount: { type: 'PERCENT', value: 1000, reason: 'Regular guest' } }).expect(201);
    expect(ok.body).toMatchObject({ orderDiscountMinor: 2_000, taxableMinor: 18_000, taxMinor: 900, totalMinor: 18_900 });

    const tooMuch = { orderDiscount: { type: 'PERCENT', value: 3000, reason: 'Friend of the house' } };
    expect((await order(cashier, [teaLine(f, 2)], tooMuch).expect(403)).body.error.message).toMatch(/above 15% need a manager/);
    await order(cashier, [teaLine(f, 2)], { orderDiscount: { type: 'FLAT', value: 5_000, reason: 'Flat off' } }).expect(403); // 25%
    await order(cashier, [teaLine(f, 1, { discount: { type: 'PERCENT', value: 5000, reason: 'Spilled' } })]).expect(403);
    await order(manager, [teaLine(f, 2)], tooMuch).expect(201);
  });

  it('requires a reason and the discount permission', async () => {
    await order(cashier, [teaLine(f)], { orderDiscount: { type: 'PERCENT', value: 500 } }).expect(400);
    await order(cashier, [teaLine(f)], { orderDiscount: { type: 'PERCENT', value: 20_000, reason: 'too much' } }).expect(400);
    await order(waiter, [teaLine(f)], { orderDiscount: { type: 'PERCENT', value: 500, reason: 'Nice guest' } }).expect(403);
  });

  it('applies a coupon within its rules and counts its use once', async () => {
    await owner.post('/discounts', { name: 'Ten off', code: 'TEN', type: 'PERCENT', value: 1000, maxDiscountMinor: 1_500, minOrderMinor: 20_000, usageLimit: 2 }).expect(201);
    expect((await order(waiter, [teaLine(f)], { couponCode: 'TEN' }).expect(400)).body.error.code).toBe('COUPON_MIN_ORDER');
    await order(waiter, [teaLine(f, 2)], { couponCode: 'NOPE' }).expect(400);
    await order(waiter, [teaLine(f, 2)], { couponCode: 'TEN', orderDiscount: { type: 'FLAT', value: 100, reason: 'both' } }).expect(400);

    const first = await order(waiter, [teaLine(f, 3)], { couponCode: 'ten' }).expect(201); // waiter may use a coupon; 10% of 300 capped at 15
    expect(first.body).toMatchObject({ orderDiscountMinor: 1_500, discountCode: 'TEN' });
    const draft = await order(waiter, [teaLine(f, 2)], { couponCode: 'TEN', action: 'DRAFT' }).expect(201);
    expect((await prisma.discount.findFirstOrThrow({ where: { code: 'TEN' } })).usedCount).toBe(1); // drafts do not consume a use

    await manager.post(`/orders/${first.body.id}/cancel`, { reason: 'changed mind' }).expect(200);
    expect((await prisma.discount.findFirstOrThrow({ where: { code: 'TEN' } })).usedCount).toBe(0); // cancelling gives it back

    await order(waiter, [teaLine(f, 2)], { couponCode: 'TEN' }).expect(201);
    await waiter.post(`/orders/${draft.body.id}/place`).expect(200);
    expect((await order(waiter, [teaLine(f, 2)], { couponCode: 'TEN' }).expect(400)).body.error.message).toMatch(/fully used/);
  });

  it('changes the discount on an open order and audits it', async () => {
    const placed = await order(cashier, [teaLine(f, 2)]).expect(201);
    const discounted = await cashier.post(`/orders/${placed.body.id}/discount`, { orderDiscount: { type: 'FLAT', value: 1_000, reason: 'Late service' } }).expect(200);
    expect(discounted.body).toMatchObject({ orderDiscountMinor: 1_000, totalMinor: 19_950 });
    await cashier.post(`/orders/${placed.body.id}/discount`, { orderDiscount: { type: 'PERCENT', value: 9_000, reason: 'Trying it on' } }).expect(403);
    expect((await cashier.get(`/orders/${placed.body.id}`)).body.orderDiscountMinor).toBe(1_000); // rolled back
    const removed = await cashier.post(`/orders/${placed.body.id}/discount`, {}).expect(200);
    expect(removed.body.totalMinor).toBe(21_000);
    const audit = await owner.get('/audit-events?action=order.discount').expect(200);
    expect(audit.body.total).toBeGreaterThanOrEqual(2);
  });

  it('flags a changed total instead of silently accepting it (offline sync conflict)', async () => {
    const res = await order(cashier, [teaLine(f)], { source: 'POS_OFFLINE', expectedTotalMinor: 9_999 }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'PRICE_CONFLICT', details: { expectedTotalMinor: 9_999, actualTotalMinor: 10_500 } });
    const ok = await order(cashier, [teaLine(f)], { source: 'POS_OFFLINE', expectedTotalMinor: 10_500, clientCreatedAt: new Date().toISOString() }).expect(201);
    expect(ok.body.source).toBe('POS_OFFLINE');
  });
});

describe('order lifecycle', () => {
  it('saves drafts, holds and resumes them, then places them', async () => {
    const draft = await order(cashier, [teaLine(f)], { action: 'HOLD', notes: 'Back in 5' }).expect(201);
    expect(draft.body).toMatchObject({ status: 'DRAFT', isHeld: true });
    expect(await prisma.kitchenTicket.count({ where: { orderId: draft.body.id } })).toBe(0);
    const held = await cashier.get('/orders?status=DRAFT&held=true').expect(200);
    expect(held.body.items.map((o: { id: string }) => o.id)).toContain(draft.body.id);

    const edited = await cashier.put(`/orders/${draft.body.id}`, { type: 'TAKEAWAY', items: [teaLine(f, 3)], action: 'DRAFT' }).expect(200);
    expect(edited.body).toMatchObject({ status: 'DRAFT', isHeld: false, totalMinor: 31_500 });
    const placed = await cashier.post(`/orders/${draft.body.id}/place`).expect(200);
    expect(placed.body.status).toBe('CONFIRMED');
    await cashier.post(`/orders/${draft.body.id}/place`).expect(409);
    await cashier.put(`/orders/${draft.body.id}`, { type: 'TAKEAWAY', items: [teaLine(f)], action: 'DRAFT' }).expect(409);
  });

  it('requires type-specific details', async () => {
    expect((await order(cashier, [teaLine(f)], { type: 'DINE_IN' }).expect(400)).body.error.code).toBe('TABLE_REQUIRED');
    expect((await order(cashier, [teaLine(f)], { type: 'DELIVERY' }).expect(400)).body.error.code).toBe('DELIVERY_DETAILS_REQUIRED');
    await order(cashier, [teaLine(f)], { type: 'PICKUP' }).expect(201);
    await order(cashier, [teaLine(f)], { type: 'TAKEAWAY', tableId: f.tables[0] }).expect(400);
  });

  it('runs the full flow with an auditable history: place, pay, prepare, ready, complete', async () => {
    const kitchen = await loginAs(app, f.users.kitchen.email, f.outletId);
    const placed = await order(cashier, [teaLine(f)], { customerId: f.customerId }).expect(201);
    const id = placed.body.id;

    expect((await cashier.post(`/orders/${id}/complete`).expect(409)).body.error.code).toBe('PAYMENT_DUE');
    await pay(cashier, id, [{ method: 'CASH', amountMinor: 10_500, tenderedMinor: 20_000 }]).expect(201);

    const [ticket] = (await kitchen.get('/kitchen/tickets').expect(200)).body.filter((t: { orderId: string }) => t.orderId === id);
    await kitchen.patch(`/kitchen/tickets/${ticket.id}`, { status: 'PREPARING' }).expect(200);
    expect((await cashier.get(`/orders/${id}`)).body.status).toBe('PREPARING');
    await kitchen.patch(`/kitchen/tickets/${ticket.id}`, { status: 'READY' }).expect(200);
    expect((await cashier.get(`/orders/${id}`)).body.status).toBe('READY');

    await kitchen.post(`/orders/${id}/complete`).expect(403);
    const done = await cashier.post(`/orders/${id}/complete`).expect(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID', dueMinor: 0 });
    expect(done.body.invoice.invoiceNumber).toMatch(/^MAIN\/\d{4}\/\d{5}$/);
    expect(done.body.completedAt).toBeTruthy();

    const history = done.body.events.map((e: { type: string; fromStatus: string | null; toStatus: string | null }) => [e.type, e.fromStatus, e.toStatus]);
    expect(history).toEqual([
      ['CREATED', null, 'DRAFT'],
      ['STATUS_CHANGED', 'DRAFT', 'PLACED'],
      ['STATUS_CHANGED', 'PLACED', 'CONFIRMED'],
      ['PAYMENT', null, null],
      ['INVOICE_ISSUED', null, null],
      ['STATUS_CHANGED', 'CONFIRMED', 'PREPARING'],
      ['STATUS_CHANGED', 'PREPARING', 'READY'],
      ['STATUS_CHANGED', 'READY', 'COMPLETED'],
    ]);
    expect(done.body.events.every((e: { actorName: string; type: string }) => e.type === 'INVOICE_ISSUED' || e.actorName !== '')).toBe(true);

    // A completed order is final.
    await cashier.post(`/orders/${id}/complete`).expect(409);
    await manager.post(`/orders/${id}/cancel`, { reason: 'too late' }).expect(409);
    await cashier.post(`/orders/${id}/items`, { items: [teaLine(f)] }).expect(409);
    await cashier.post(`/orders/${id}/discount`, { orderDiscount: { type: 'FLAT', value: 100, reason: 'after the fact' } }).expect(409);
    await pay(cashier, id, [{ method: 'CASH', amountMinor: 100 }]).expect(409);
  });

  it('cancelling needs permission and a reason, and is recorded', async () => {
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    await cashier.post(`/orders/${placed.body.id}/cancel`, { reason: 'guest walked out' }).expect(403);
    await manager.post(`/orders/${placed.body.id}/cancel`, {}).expect(400);
    await manager.post(`/orders/${placed.body.id}/cancel`, { reason: 'x' }).expect(400);
    const cancelled = await manager.post(`/orders/${placed.body.id}/cancel`, { reason: 'guest walked out' }).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'guest walked out', cancelledById: f.users.manager.id });
    expect((await prisma.kitchenTicket.findFirstOrThrow({ where: { orderId: placed.body.id } })).status).toBe('CANCELLED');
    expect((await owner.get('/audit-events?action=order.cancel')).body.items[0].metadata.reason).toBe('guest walked out');
    await manager.post(`/orders/${placed.body.id}/cancel`, { reason: 'again please' }).expect(409);

    // A cashier may discard their own unsent draft.
    const draft = await order(cashier, [teaLine(f)], { action: 'DRAFT' }).expect(201);
    await cashier.post(`/orders/${draft.body.id}/cancel`, { reason: 'not needed' }).expect(200);
  });

  it('a paid order must be refunded before it can be cancelled', async () => {
    const placed = await order(cashier, [teaLine(f)]).expect(201);
    await pay(cashier, placed.body.id, [{ method: 'UPI', amountMinor: 10_500, reference: 'UPI123' }]).expect(201);
    expect((await manager.post(`/orders/${placed.body.id}/cancel`, { reason: 'kitchen closed' }).expect(409)).body.error.code).toBe('REFUND_REQUIRED');
  });

  it('voiding a sent item needs a manager, keeps the row and reprices the bill', async () => {
    const placed = await order(cashier, [teaLine(f), curryLine(f, 'half')]).expect(201);
    const tea = placed.body.items.find((i: { productName: string }) => i.productName === 'Tea');
    await cashier.post(`/orders/${placed.body.id}/items/${tea.id}/void`, { reason: 'wrong item' }).expect(403);
    const voided = await manager.post(`/orders/${placed.body.id}/items/${tea.id}/void`, { reason: 'wrong item' }).expect(200);
    expect(voided.body.totalMinor).toBe(21_000);
    expect(voided.body.items.find((i: { id: string }) => i.id === tea.id)).toMatchObject({ status: 'VOIDED', voidReason: 'wrong item', voidedById: f.users.manager.id });
    expect(await prisma.orderItem.count({ where: { orderId: placed.body.id } })).toBe(2); // nothing deleted
    expect((await owner.get('/audit-events?action=order.void_item')).body.total).toBeGreaterThanOrEqual(1);
  });

  it('searches and filters orders', async () => {
    const placed = await order(cashier, [teaLine(f)], { type: 'DELIVERY', deliveryName: 'Zubin Uniquename', deliveryPhone: '9000000000', deliveryAddress: '1 Road' }).expect(201);
    const byName = await cashier.get('/orders?q=Uniquename').expect(200);
    expect(byName.body.items.map((o: { id: string }) => o.id)).toEqual([placed.body.id]);
    const byNumber = await cashier.get(`/orders?q=${placed.body.orderNumber}`).expect(200);
    expect(byNumber.body.total).toBe(1);
    const byType = await cashier.get('/orders?type=DELIVERY&status=CONFIRMED,PREPARING').expect(200);
    expect(byType.body.items.every((o: { type: string }) => o.type === 'DELIVERY')).toBe(true);
    await cashier.get('/orders?status=NOT_A_STATUS').expect(400);
    expect((await cashier.get('/orders?pageSize=2&page=1').expect(200)).body.items).toHaveLength(2);
  });
});

describe('dine-in tables', () => {
  const dineIn = (c: Client, table: number, items = [teaLine(f)]) => order(c, items, { type: 'DINE_IN', tableId: f.tables[table], guestCount: 2 });
  const statusOf = async (table: number): Promise<{ status: string; order: { id: string } | null }> => {
    const plan = await waiter.get('/floor').expect(200);
    return plan.body[0].tables.find((t: { id: string }) => t.id === f.tables[table]);
  };
  const free = async () => {
    for (const o of await prisma.order.findMany({ where: { outletId: f.outletId, type: 'DINE_IN', status: { in: ['DRAFT', 'CONFIRMED', 'PREPARING', 'READY'] } } })) {
      await manager.post(`/orders/${o.id}/cancel`, { reason: 'test cleanup' }).expect(200);
    }
  };
  afterEach(free);

  it('derives table status from the open order and frees it when the order closes', async () => {
    expect((await statusOf(0)).status).toBe('AVAILABLE');
    const placed = await dineIn(waiter, 0).expect(201);
    expect(placed.body.tableLabel).toBe('T1');
    expect(placed.body.waiterId).toBe(f.users.waiter.id);
    expect(await statusOf(0)).toMatchObject({ status: 'OCCUPIED', order: { id: placed.body.id } });
    await manager.post(`/orders/${placed.body.id}/cancel`, { reason: 'guests left' }).expect(200);
    expect((await statusOf(0)).status).toBe('AVAILABLE');
  });

  it('never lets two open orders hold the same table', async () => {
    const first = await dineIn(waiter, 0).expect(201);
    const clash = await dineIn(cashier, 0).expect(409);
    expect(clash.body.error).toMatchObject({ code: 'TABLE_OCCUPIED', details: { orderId: first.body.id } });
    await manager.post(`/orders/${first.body.id}/cancel`, { reason: 'cleanup' }).expect(200);

    const race = await Promise.all(Array.from({ length: 6 }, () => dineIn(waiter, 1)));
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    expect(race.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await prisma.orderTable.count({ where: { tableId: f.tables[1], isActive: true } })).toBe(1);
  });

  it('transfers, joins and merges tables', async () => {
    const one = await dineIn(waiter, 0).expect(201);
    const two = await dineIn(waiter, 1, [curryLine(f, 'half')]).expect(201);
    expect((await waiter.post(`/orders/${one.body.id}/transfer-table`, { tableId: f.tables[1] }).expect(409)).body.error.code).toBe('TABLE_OCCUPIED');
    const moved = await waiter.post(`/orders/${one.body.id}/transfer-table`, { tableId: f.tables[2] }).expect(200);
    expect(moved.body.tableLabel).toBe('T3');
    expect((await statusOf(0)).status).toBe('AVAILABLE');
    expect((await prisma.kitchenTicket.findFirstOrThrow({ where: { orderId: one.body.id } })).tableLabel).toBe('T3');

    const joined = await waiter.post(`/orders/${one.body.id}/attach-table`, { tableId: f.tables[0] }).expect(200);
    expect(joined.body.tableLabel).toBe('T3 + T1');

    const merged = await waiter.post(`/orders/${one.body.id}/merge`, { sourceOrderId: two.body.id }).expect(200);
    expect(merged.body.items).toHaveLength(2);
    expect(merged.body.totalMinor).toBe(10_500 + 21_000);
    expect(merged.body.guestCount).toBe(4);
    expect(merged.body.tableLabel.split(' + ').sort()).toEqual(['T1', 'T2', 'T3']);
    const source = await waiter.get(`/orders/${two.body.id}`).expect(200);
    expect(source.body).toMatchObject({ status: 'CANCELLED', totalMinor: 0, cancelReason: `Merged into ${one.body.orderNumber}` });
    expect(await prisma.kitchenTicket.count({ where: { orderId: one.body.id } })).toBe(2);

    const kitchenUser = await loginAs(app, f.users.kitchen.email, f.outletId);
    await kitchenUser.post(`/orders/${one.body.id}/transfer-table`, { tableId: f.tables[1] }).expect(403);
  });

  it('splits a bill into two orders whose totals add up', async () => {
    const placed = await dineIn(waiter, 0, [teaLine(f, 3), curryLine(f, 'full')]).expect(201);
    const tea = placed.body.items.find((i: { productName: string }) => i.productName === 'Tea');
    const curry = placed.body.items.find((i: { productName: string }) => i.productName === 'Curry');
    await waiter.post(`/orders/${placed.body.id}/split`, { items: [{ itemId: tea.id, quantity: 3 }, { itemId: curry.id, quantity: 1 }] }).expect(400); // nothing left
    await waiter.post(`/orders/${placed.body.id}/split`, { items: [{ itemId: tea.id, quantity: 4 }] }).expect(400);

    const res = await waiter.post(`/orders/${placed.body.id}/split`, { items: [{ itemId: tea.id, quantity: 1 }, { itemId: curry.id, quantity: 1 }] }).expect(200);
    expect(res.body.original.items.map((i: { quantity: number }) => i.quantity)).toEqual([2]);
    expect(res.body.original.totalMinor).toBe(21_000);
    expect(res.body.split.totalMinor).toBe(10_500 + 31_500);
    expect(res.body.original.totalMinor + res.body.split.totalMinor).toBe(placed.body.totalMinor);
    expect(res.body.split).toMatchObject({ splitFromOrderId: placed.body.id, tableLabel: 'T1', status: 'CONFIRMED' });

    // Each half is paid and closed on its own; the table frees when the original closes.
    await pay(cashier, res.body.split.id, [{ method: 'CASH', amountMinor: res.body.split.totalMinor }]).expect(201);
    await cashier.post(`/orders/${res.body.split.id}/complete`).expect(200);
    expect((await statusOf(0)).status).toBe('OCCUPIED');
    await pay(cashier, placed.body.id, [{ method: 'CASH', amountMinor: 21_000 }]).expect(201);
    await waiter.post(`/orders/${placed.body.id}/split`, { items: [{ itemId: tea.id, quantity: 1 }] }).expect(409); // already paid
    await cashier.post(`/orders/${placed.body.id}/complete`).expect(200);
    expect((await statusOf(0)).status).toBe('AVAILABLE');
  });

  it('shows a table as reserved and rejects overlapping bookings', async () => {
    const start = new Date(Date.now() + 20 * 60_000);
    const booking = { tableId: f.tables[2], guestName: 'Kapoor', partySize: 2, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 90 * 60_000).toISOString() };
    await waiter.post('/reservations', booking).expect(403);
    const made = await cashier.post('/reservations', booking).expect(201);
    expect((await statusOf(2)).status).toBe('RESERVED');
    expect((await cashier.post('/reservations', { ...booking, guestName: 'Other' }).expect(409)).body.error.code).toBe('TABLE_ALREADY_RESERVED');
    await cashier.post('/reservations', { ...booking, partySize: 40 }).expect(400);
    await cashier.patch(`/reservations/${made.body.id}`, { status: 'CANCELLED' }).expect(200);
    expect((await statusOf(2)).status).toBe('AVAILABLE');
  });
});
