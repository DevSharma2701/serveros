import { todayIn } from '@/lib/format';

export type RangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';

export const RANGE_PRESETS: Array<{ value: RangePreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom' },
];

export interface DateRange {
  from: string;
  to: string;
}

/** Calendar dates (YYYY-MM-DD, both inclusive) for a preset, on the wall clock of the outlet's time zone. */
export function presetRange(preset: Exclude<RangePreset, 'custom'>, timeZone: string): DateRange {
  switch (preset) {
    case 'today':
      return { from: todayIn(timeZone), to: todayIn(timeZone) };
    case 'yesterday':
      return { from: todayIn(timeZone, -1), to: todayIn(timeZone, -1) };
    case 'last7':
      return { from: todayIn(timeZone, -6), to: todayIn(timeZone) };
    case 'last30':
      return { from: todayIn(timeZone, -29), to: todayIn(timeZone) };
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why a custom range cannot be requested, or null when it is fine. */
export function rangeProblem(range: DateRange): string | null {
  if (!ISO_DATE.test(range.from) || !ISO_DATE.test(range.to)) return 'Choose both a start and an end date.';
  if (range.from > range.to) return 'The start date must be on or before the end date.';
  return null;
}

/** Every calendar day from `from` to `to`, inclusive. Capped so a huge range cannot freeze the page. */
export function daysBetween(from: string, to: string, cap = 400): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end && days.length < cap) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** "04 Oct" for a YYYY-MM-DD day (no time zone shift: the day is already a local calendar date). */
export function shortDay(day: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short' }).format(new Date(`${day}T00:00:00Z`));
}

/** "2 pm" style label for an hour of the day (0-23). */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'am' : 'pm'}`;
}
