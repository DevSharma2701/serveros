import type { OrderStatus } from '@serveos/shared';
import { titleCase } from '../lib/format';
import type { PaymentStatus } from '../lib/types';
import type { Tone } from '../theme';
import { Badge } from './ui';

const STATUS_TONE: Record<OrderStatus, Tone> = {
  DRAFT: 'neutral',
  PLACED: 'info',
  CONFIRMED: 'info',
  PREPARING: 'warn',
  READY: 'ok',
  COMPLETED: 'neutral',
  CANCELLED: 'bad',
  REFUNDED: 'bad',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge label={titleCase(status)} tone={STATUS_TONE[status] ?? 'neutral'} />;
}

const PAYMENT_TONE: Record<PaymentStatus, Tone> = { UNPAID: 'warn', PARTIALLY_PAID: 'warn', PAID: 'ok', PARTIALLY_REFUNDED: 'bad', REFUNDED: 'bad' };

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <Badge label={titleCase(status)} tone={PAYMENT_TONE[status] ?? 'neutral'} />;
}

export const orderTypeLabel = (type: string): string => titleCase(type);
