/**
 * Form helpers for back-office pages.
 *
 * People type rupees and percentages; the API (and the shared request schemas) speak minor
 * units and basis points. `payloadResolver` bridges the two: the form keeps what was typed
 * as text, `toPayload` converts it, and the shared schema validates the converted payload.
 * Errors come back on the same field paths, so they show up inline next to each control.
 */
import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';
import { parseAmount } from '@/lib/format';

/** Reports a problem found while converting typed text (path uses dots: "variants.0.priceMinor"). */
export type Report = (path: string, message: string) => void;

type Issue = z.core.$ZodIssue;

/** Zod's default messages are written for developers; these are for the person filling in the form. */
function friendly(issue: Issue): string {
  if (issue.code === 'too_small' && issue.origin === 'string') return issue.minimum <= 1 ? 'This is required' : issue.message.startsWith('Too small') ? `Use at least ${issue.minimum} characters` : issue.message;
  if (issue.code === 'too_big' && issue.origin === 'string') return `Use at most ${issue.maximum} characters`;
  if (issue.code === 'too_small' && issue.origin === 'array') return issue.message.startsWith('Too small') ? 'Add at least one' : issue.message;
  if (issue.code === 'too_small' && issue.message.startsWith('Too small')) return `Must be ${issue.minimum} or more`;
  if (issue.code === 'too_big' && issue.message.startsWith('Too big')) return `Must be ${issue.maximum} or less`;
  if (issue.code === 'invalid_format' && issue.format === 'uuid') return 'Choose one';
  if (issue.code === 'invalid_format' && issue.format === 'email') return 'Enter a valid email address';
  if (issue.code === 'invalid_format' && issue.message.startsWith('Invalid')) return 'This is not in the expected format';
  if (issue.code === 'invalid_type') return 'This is required';
  return issue.message;
}

function valueAt(source: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current = source;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function setError(target: Record<string, unknown>, path: string[], message: string): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (next && typeof next === 'object' && !('message' in next && 'type' in next)) node = next as Record<string, unknown>;
    else node = node[key] = {};
  }
  const last = path[path.length - 1]!;
  if (node[last] === undefined) node[last] = { type: 'validate', message };
}

export type Validation<T> = { ok: true; data: T } | { ok: false; errors: Record<string, unknown> };

/** Converts typed values to an API payload and validates it against a shared request schema. */
export function validatePayload<TForm, S extends z.ZodType>(schema: S, toPayload: (values: TForm, report: Report) => unknown, values: TForm): Validation<z.output<S>> {
  const reported: Array<[string, string]> = [];
  const payload = toPayload(values, (path, message) => reported.push([path, message]));
  const parsed = schema.safeParse(payload);
  if (parsed.success && reported.length === 0) return { ok: true, data: parsed.data };
  const errors: Record<string, unknown> = {};
  // Problems found while converting (for example "abc" typed as a price) explain more than the schema can.
  for (const [path, message] of reported) setError(errors, path.split('.'), message);
  for (const issue of parsed.success ? [] : parsed.error.issues) {
    const path = issue.path.map(String);
    // A message about a whole list ("add at least one") lives on `.root`, beside the per-row messages.
    if (Array.isArray(valueAt(values, issue.path))) path.push('root');
    setError(errors, path.length ? path : ['root'], friendly(issue));
  }
  return { ok: false, errors };
}

/** A react-hook-form resolver built on `validatePayload`. */
export function payloadResolver<TForm extends FieldValues, S extends z.ZodType>(schema: S, toPayload: (values: TForm, report: Report) => unknown): Resolver<TForm> {
  return (values) => {
    const result = validatePayload(schema, toPayload, values);
    return result.ok ? { values, errors: {} } : { values: {}, errors: result.errors as FieldErrors<TForm> };
  };
}

/** Reads a message out of a nested react-hook-form errors object without caring about its exact type. */
export function errorAt(errors: unknown, ...path: Array<string | number>): string | undefined {
  const found = valueAt(errors, path);
  if (found && typeof found === 'object' && 'message' in found && typeof found.message === 'string') return found.message;
  return undefined;
}

/** Typed rupees -> minor units. An empty optional field is null; anything unreadable is reported. */
export function toMinor(text: string | null | undefined, path: string, report: Report, options: { optional?: boolean } = {}): number | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    if (options.optional) return null;
    report(path, 'Enter an amount');
    return 0;
  }
  const minor = parseAmount(trimmed);
  if (minor == null) {
    report(path, 'Enter an amount like 120 or 120.50');
    return 0;
  }
  return minor;
}

/** Typed percentage ("2.5") -> basis points (250). */
export function toBps(text: string | null | undefined, path: string, report: Report): number {
  const trimmed = (text ?? '').trim().replace(/%$/, '');
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) {
    report(path, 'Enter a percentage like 5 or 2.5');
    return 0;
  }
  return Math.round(Number(trimmed) * 100);
}

/** Typed whole number; empty optional -> null. */
export function toInt(text: string | number | null | undefined, path: string, report: Report, options: { optional?: boolean } = {}): number | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    if (options.optional) return null;
    report(path, 'Enter a whole number');
    return 0;
  }
  if (!/^\d+$/.test(trimmed)) {
    report(path, 'Enter a whole number');
    return 0;
  }
  return Number(trimmed);
}

/** Minor units -> the text shown in an amount input ("120.00"). */
export const minorToText = (minor: number | null | undefined): string => (minor == null ? '' : (minor / 100).toFixed(2));

/** Basis points -> the text shown in a percentage input ("2.5"). */
export const bpsToText = (bps: number): string => String(bps / 100);

/** ISO timestamp -> value for <input type="datetime-local"> in the browser's time zone. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Value of a date or datetime-local input -> ISO timestamp (null when empty or unreadable). */
export function localInputToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value.length === 10 ? `${value}T00:00` : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
