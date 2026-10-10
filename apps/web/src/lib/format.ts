import { formatMoney } from '@serveos/shared';

export const money = (minor: number | null | undefined, currency = 'INR'): string => formatMoney(minor ?? 0, currency);

/** "1,234.50" without the currency symbol, for dense tables and inputs. */
export const amount = (minor: number): string => (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Parses what a person typed ("1,250.5") into minor units; null if it is not a valid amount. */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export const percent = (bps: number): string => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

export function dateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function timeOnly(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** Today's calendar date (YYYY-MM-DD) on the wall clock of a time zone. */
export function todayIn(timeZone: string, offsetDays = 0): string {
  const shifted = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

export function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
}

export const titleCase = (value: string): string => value.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
