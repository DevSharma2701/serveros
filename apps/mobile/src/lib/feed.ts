/**
 * The in-app notification feed. It is NOT push: every item is computed on the device from data
 * the API returned just now (today's report for the selected outlet and its open orders).
 */
import { ageLabel, minutesSince, money, quantity, signedMoney } from './format';
import type { DashboardCashShift, InventoryAlert, OrderSummary } from './types';
import type { Tone } from '../theme';

/** An order still open after this many minutes is flagged. */
export const LONG_OPEN_MINUTES = 30;

export type FeedKind = 'low-stock' | 'cash-variance' | 'cancelled-order' | 'long-open-order';

export interface FeedItem {
  id: string;
  kind: FeedKind;
  tone: Tone;
  title: string;
  body: string;
  /** When the underlying thing happened, if the API tells us. */
  at: string | null;
  /** In-app route to open for more detail. */
  href: string | null;
}

export interface FeedSources {
  inventoryAlerts?: InventoryAlert[];
  cashShifts?: DashboardCashShift[];
  cancelledOrders?: OrderSummary[];
  liveOrders?: OrderSummary[];
  currency?: string;
  now?: number;
}

export function buildFeed({ inventoryAlerts = [], cashShifts = [], cancelledOrders = [], liveOrders = [], currency = 'INR', now = Date.now() }: FeedSources): FeedItem[] {
  const items: FeedItem[] = [];

  for (const order of liveOrders) {
    const minutes = minutesSince(order.placedAt ?? order.createdAt, now);
    if (minutes < LONG_OPEN_MINUTES) continue;
    items.push({
      id: `long-open-${order.id}`,
      kind: 'long-open-order',
      tone: 'warn',
      title: `Order ${order.orderNumber} open for ${ageLabel(minutes)}`,
      body: `${order.status.toLowerCase()} · ${order.tableLabel ? `table ${order.tableLabel} · ` : ''}${money(order.totalMinor, currency)}`,
      at: order.placedAt ?? order.createdAt,
      href: `/orders/${order.id}`,
    });
  }

  for (const order of cancelledOrders) {
    if (!order.placedAt) continue; // abandoned drafts never reached the kitchen: not worth an alert
    items.push({
      id: `cancelled-${order.id}`,
      kind: 'cancelled-order',
      tone: 'bad',
      title: `Order ${order.orderNumber} was cancelled`,
      body: `${money(order.totalMinor, currency)}${order.customer ? ` · ${order.customer.name}` : ''}`,
      at: order.createdAt,
      href: `/orders/${order.id}`,
    });
  }

  for (const shift of cashShifts) {
    if (!shift.varianceMinor) continue;
    items.push({
      id: `variance-${shift.id}`,
      kind: 'cash-variance',
      tone: shift.varianceMinor < 0 ? 'bad' : 'warn',
      title: `Cash ${shift.varianceMinor < 0 ? 'short' : 'over'} by ${money(Math.abs(shift.varianceMinor), currency)}`,
      body: `${shift.register} · shift opened by ${shift.openedByName} · variance ${signedMoney(shift.varianceMinor, currency)}`,
      at: shift.closedAt,
      href: `/shifts/${shift.id}`,
    });
  }

  for (const alert of inventoryAlerts) {
    items.push({
      id: `stock-${alert.outletId}-${alert.ingredientId}`,
      kind: 'low-stock',
      tone: Number(alert.quantity) <= 0 ? 'bad' : 'warn',
      title: `${alert.name} is ${Number(alert.quantity) <= 0 ? 'out of stock' : 'running low'}`,
      body: `${quantity(alert.quantity)} ${alert.unit} left · alert level ${quantity(alert.threshold)} ${alert.unit}`,
      at: null,
      href: '/low-stock',
    });
  }

  return items;
}
