import { createHash, createHmac, randomBytes } from 'node:crypto';
import { badRequest } from './errors';

export const randomToken = (bytes = 48): string => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const hmac = (secret: string, value: string): string => createHmac('sha256', secret).update(value).digest('hex');

export function paginate(q: { page: number; pageSize: number }): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function paged<T>(items: T[], total: number, q: { page: number; pageSize: number }) {
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** Calendar date parts of an instant as seen on the wall clock of `timeZone`. */
export function localParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Business day key, e.g. "261010", used to restart order numbering each day. */
export function businessDay(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${pad(p.year % 100)}${pad(p.month)}${pad(p.day)}`;
}

/** Indian financial year (April to March) key, e.g. "2627" for 1 Apr 2026 - 31 Mar 2027. */
export function financialYear(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const start = p.month >= 4 ? p.year : p.year - 1;
  return `${pad(start % 100)}${pad((start + 1) % 100)}`;
}

/** The UTC instant at which the calendar day `isoDate` (YYYY-MM-DD) starts in `timeZone`. */
export function startOfLocalDay(isoDate: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  // Offset of the zone at that moment = (wall clock read as UTC) - (actual instant).
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Half-open UTC range [gte, lt) covering local days `from`..`to` inclusive. */
export function localDayRange(from: string, to: string, timeZone: string): { gte: Date; lt: Date } {
  if (from > to) throw badRequest('INVALID_RANGE', 'The start date must not be after the end date');
  return { gte: startOfLocalDay(from, timeZone), lt: startOfLocalDay(addDays(to, 1), timeZone) };
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    throw badRequest('INVALID_TIMEZONE', `"${timeZone}" is not a valid IANA time zone`);
  }
}

export function csv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined): string => {
    let s = v == null ? '' : String(v);
    // Neutralise spreadsheet formula injection from user-entered text (plain numbers are left alone).
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
