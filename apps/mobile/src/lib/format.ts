import { formatMoney } from '@serveos/shared';

/** Money arrives in integer minor units (paise). */
export const money = (minor: number | null | undefined, currency = 'INR'): string => formatMoney(minor ?? 0, currency);

/** Signed money for variances: "+₹20.00" / "-₹20.00". */
export const signedMoney = (minor: number, currency = 'INR'): string => `${minor > 0 ? '+' : minor < 0 ? '-' : ''}${money(Math.abs(minor), currency)}`;

const parts = (date: Date, timeZone: string | undefined, options: Intl.DateTimeFormatOptions): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).formatToParts(date)) out[part.type] = part.value;
  return out;
};

/** Calendar date (YYYY-MM-DD) on the wall clock of a time zone, optionally shifted by whole days. */
export function dayIn(timeZone: string | undefined, offsetDays = 0, now: Date = new Date()): string {
  const p = parts(now, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  // Shift by calendar days using a UTC date built from the local calendar date (no DST drift).
  const shifted = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

export function dateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  const p = parts(new Date(iso), timeZone, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

export function timeOnly(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  const p = parts(new Date(iso), timeZone, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${p.hour}:${p.minute}`;
}

/** "2026-10-10" -> "10 Oct". */
export function shortDay(day: string): string {
  const p = parts(new Date(`${day}T00:00:00Z`), 'UTC', { day: '2-digit', month: 'short' });
  return `${p.day} ${p.month}`;
}

export function minutesSince(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

export function ageLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export const titleCase = (value: string): string => value.toLowerCase().replace(/[_.]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Trims a decimal string from the API ("1500.000" -> "1,500"; "2.50" -> "2.5"). */
export function quantity(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
}

export const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;
