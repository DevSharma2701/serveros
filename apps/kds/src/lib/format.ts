import type { OrderType } from '@serveos/shared';
import type { Ticket } from './types';

export const ORDER_TYPE_LABEL: Record<OrderType, string> = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', PICKUP: 'Pickup', DELIVERY: 'Delivery' };

/** mm:ss; minutes keep counting past 99 rather than rolling into hours, which reads faster. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export const formatClock = (at: number | string): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Notes are free text typed at the POS; this only decides how loudly to show them. */
export const isAllergyNote = (note: string): boolean => /allerg|anaphyla|intoleran|co?eliac|gluten|\bnuts?\b|peanut|lactose|shellfish/i.test(note);

export type Urgency = 'ok' | 'late' | 'overdue';

export function urgency(ageMs: number, warnMinutes: number, overdueMinutes: number): Urgency {
  const minutes = ageMs / 60_000;
  return minutes >= overdueMinutes ? 'overdue' : minutes >= warnMinutes ? 'late' : 'ok';
}

export const byOldestFired = (a: Ticket, b: Ticket): number => a.firedAt.localeCompare(b.firedAt);
export const byNewestReady = (a: Ticket, b: Ticket): number => (b.readyAt ?? '').localeCompare(a.readyAt ?? '');
