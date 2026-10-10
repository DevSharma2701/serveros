import type { PermissionKey } from './access';

export const ORDER_TYPES = ['DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = ['DRAFT', 'PLACED', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED', 'REFUNDED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses in which an order still occupies a table and can change. */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = ['DRAFT', 'PLACED', 'CONFIRMED', 'PREPARING', 'READY'];
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ['COMPLETED', 'CANCELLED', 'REFUNDED'];
/** Statuses in which the kitchen has (or had) the order. */
export const KITCHEN_ORDER_STATUSES: OrderStatus[] = ['CONFIRMED', 'PREPARING', 'READY'];

/**
 * Every allowed order status change and the permission it needs.
 * `null` means the change is made only by the system as a consequence of another action
 * (for example READY -> PREPARING when new items are added to a ready order).
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, Partial<Record<OrderStatus, PermissionKey | null>>> = {
  DRAFT: { PLACED: 'order.create', CANCELLED: 'order.create' },
  PLACED: { CONFIRMED: 'order.create', CANCELLED: 'order.cancel' },
  CONFIRMED: { PREPARING: 'kitchen.update', READY: 'kitchen.update', COMPLETED: 'order.complete', CANCELLED: 'order.cancel' },
  PREPARING: { READY: 'kitchen.update', CONFIRMED: 'kitchen.update', COMPLETED: 'order.complete', CANCELLED: 'order.cancel' },
  READY: { COMPLETED: 'order.complete', PREPARING: null, CANCELLED: 'order.cancel' },
  COMPLETED: { REFUNDED: 'payment.refund' },
  CANCELLED: {},
  REFUNDED: {},
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return to in ORDER_TRANSITIONS[from];
}

export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'WALLET', 'LOYALTY', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const KITCHEN_TICKET_STATUSES = ['PENDING', 'PREPARING', 'READY', 'CANCELLED'] as const;
export type KitchenTicketStatus = (typeof KITCHEN_TICKET_STATUSES)[number];

/** Socket.IO event names shared by the API, POS, KDS and mobile app. */
export const REALTIME_EVENTS = {
  orderChanged: 'order.changed',
  ticketChanged: 'kitchen.ticket.changed',
  menuChanged: 'menu.changed',
  floorChanged: 'floor.changed',
} as const;

export function formatMoney(minor: number, currency = 'INR', locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2 }).format(minor / 100);
}
