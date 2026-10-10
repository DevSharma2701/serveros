import { customRangeSchema, presetRange } from '../lib/dates';
import { buildFeed } from '../lib/feed';
import { dayIn, money, quantity, signedMoney } from '../lib/format';
import { registerForPushNotifications } from '../lib/push';
import type { OrderSummary } from '../lib/types';

describe('dates in the outlet time zone', () => {
  // 20:00 UTC on 10 Oct is already 01:30 on 11 Oct in Bengaluru, and still 10 Oct in New York.
  const now = new Date('2026-10-10T20:00:00Z');

  it('computes "today" on the outlet wall clock, not the phone clock', () => {
    expect(dayIn('Asia/Kolkata', 0, now)).toBe('2026-10-11');
    expect(dayIn('America/New_York', 0, now)).toBe('2026-10-10');
    expect(dayIn('Asia/Kolkata', -1, now)).toBe('2026-10-10');
  });

  it('resolves presets to inclusive ranges', () => {
    expect(presetRange('today', 'Asia/Kolkata', now)).toMatchObject({ from: '2026-10-11', to: '2026-10-11' });
    expect(presetRange('last7', 'Asia/Kolkata', now)).toMatchObject({ from: '2026-10-05', to: '2026-10-11' });
    expect(presetRange('month', 'Asia/Kolkata', now)).toMatchObject({ from: '2026-10-01', to: '2026-10-11' });
  });

  it('validates a custom range', () => {
    expect(customRangeSchema.safeParse({ from: '2026-10-01', to: '2026-10-10' }).success).toBe(true);
    expect(customRangeSchema.safeParse({ from: '2026-10-10', to: '2026-10-01' }).success).toBe(false);
    expect(customRangeSchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
    expect(customRangeSchema.safeParse({ from: '10/10/2026', to: '2026-10-10' }).success).toBe(false);
  });
});

describe('formatting', () => {
  it('formats minor units as money', () => {
    expect(money(716100)).toBe('₹7,161.00');
    expect(signedMoney(-2000)).toBe('-₹20.00');
    expect(signedMoney(0)).toBe('₹0.00');
    expect(quantity('1500.000')).toBe('1,500');
  });
});

describe('in-app notification feed', () => {
  const now = Date.parse('2026-10-10T09:00:00Z');
  const order = (over: Partial<OrderSummary>): OrderSummary => ({
    id: 'o1', orderNumber: '0001', type: 'DINE_IN', status: 'PREPARING', isHeld: false, tableLabel: 'T4', totalMinor: 50000, paidMinor: 0, refundedMinor: 0, paymentStatus: 'UNPAID',
    createdAt: '2026-10-10T08:00:00Z', placedAt: '2026-10-10T08:00:00Z', completedAt: null, guestCount: 2, notes: '', customer: null, _count: { items: 2 }, ...over,
  });

  it('derives every item from API data and nothing else', () => {
    const feed = buildFeed({
      now,
      liveOrders: [order({ id: 'old' }), order({ id: 'fresh', placedAt: '2026-10-10T08:50:00Z' })],
      cancelledOrders: [order({ id: 'gone', orderNumber: '0009', status: 'CANCELLED' })],
      cashShifts: [
        { id: 's1', openedByName: 'Meera', closedAt: '2026-10-10T08:30:00Z', expectedCashMinor: 1000, countedCashMinor: 800, varianceMinor: -200, register: 'Counter 1', outlet: 'X' },
        { id: 's2', openedByName: 'Rohan', closedAt: '2026-10-10T08:30:00Z', expectedCashMinor: 1000, countedCashMinor: 1000, varianceMinor: 0, register: 'Counter 2', outlet: 'X' },
      ],
      inventoryAlerts: [{ outletId: 'x', outlet: 'X', ingredientId: 'i1', name: 'Paneer', quantity: '0', threshold: '2000', unit: 'g' }],
    });

    expect(feed.map((i) => i.id)).toEqual(['long-open-old', 'cancelled-gone', 'variance-s1', 'stock-x-i1']);
    expect(feed[0]!.title).toBe('Order 0001 open for 1 h 0 min');
    expect(feed[0]!.href).toBe('/orders/old');
    expect(feed[2]!.title).toBe('Cash short by ₹2.00');
    expect(feed[3]!.title).toBe('Paneer is out of stock');
  });

  it('is empty when there is nothing to report', () => {
    expect(buildFeed({ now })).toEqual([]);
  });
});

describe('push notifications scaffold', () => {
  it('does nothing while push is not configured', async () => {
    await expect(registerForPushNotifications()).resolves.toEqual({ status: 'disabled', reason: 'Push notifications are not configured for this build.' });
  });
});
