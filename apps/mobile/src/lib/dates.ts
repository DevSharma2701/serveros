import { z } from 'zod';
import { dayIn } from './format';

export type RangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'month' | 'custom';

export interface DateRange {
  preset: RangePreset;
  /** Inclusive calendar days (YYYY-MM-DD) in the outlet's time zone. */
  from: string;
  to: string;
}

export const PRESETS: Array<{ key: Exclude<RangePreset, 'custom'>; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
];

/** Resolves a preset to concrete days on the wall clock of the outlet's time zone. */
export function presetRange(preset: Exclude<RangePreset, 'custom'>, timeZone: string | undefined, now: Date = new Date()): DateRange {
  const today = dayIn(timeZone, 0, now);
  switch (preset) {
    case 'today':
      return { preset, from: today, to: today };
    case 'yesterday': {
      const y = dayIn(timeZone, -1, now);
      return { preset, from: y, to: y };
    }
    case 'last7':
      return { preset, from: dayIn(timeZone, -6, now), to: today };
    case 'last30':
      return { preset, from: dayIn(timeZone, -29, now), to: today };
    case 'month':
      return { preset, from: `${today.slice(0, 8)}01`, to: today };
  }
}

const isRealDay = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const day = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isRealDay, 'That date does not exist');

const daysBetween = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

export const customRangeSchema = z
  .object({ from: day, to: day })
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'End date must not be before the start date' })
  .refine((v) => daysBetween(v.from, v.to) <= 366, { path: ['to'], message: 'Choose a range of one year or less' });

export type CustomRangeInput = z.infer<typeof customRangeSchema>;
