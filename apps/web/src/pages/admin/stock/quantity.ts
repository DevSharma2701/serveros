/**
 * Helpers for stock quantities. The API sends them as decimal strings with up to 4 decimals.
 * Nothing here uses floating point for arithmetic: differences are worked out on scaled integers.
 */

const SCALE = 4;

/** "12.5000" -> "12.5", "3.0000" -> "3". Display only. */
export function qty(value: string | number | null | undefined): string {
  if (value == null || value === '') return '';
  const text = String(value);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** A change with an explicit sign: "+2.5" / "-0.75" / "0". */
export function signedQty(value: string | null | undefined): string {
  const text = qty(value);
  if (!text) return '';
  if (text.startsWith('-')) return `−${text.slice(1)}`;
  return isZero(text) ? '0' : `+${text}`;
}

export const isZero = (value: string | null | undefined): boolean => !value || /^-?0*(\.0*)?$/.test(value);
export const isNegative = (value: string | null | undefined): boolean => !!value && value.startsWith('-') && !isZero(value);

function toScaled(value: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?\d*$/.exec(value.trim());
  if (!match) return null;
  const scaled = BigInt(match[2]!) * 10n ** BigInt(SCALE) + BigInt((match[3] ?? '').padEnd(SCALE, '0'));
  return match[1] ? -scaled : scaled;
}

function fromScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(SCALE + 1, '0');
  return qty(`${negative ? '-' : ''}${digits.slice(0, -SCALE)}.${digits.slice(-SCALE)}`);
}

/** a − b on decimal strings, never below zero (what is still to be received on a purchase order line). */
export function remainingQty(a: string, b: string): string {
  const left = toScaled(a);
  const right = toScaled(b);
  if (left == null || right == null) return '';
  const diff = left - right;
  return fromScaled(diff > 0n ? diff : 0n);
}

/** Matches the API's quantity format: digits with up to 4 decimals. */
export const isQty = (text: string): boolean => /^\d{1,10}(\.\d{1,4})?$/.test(text.trim());

/** Approximate line value for display in lists (quantity × unit cost). The API holds the exact figures. */
export const lineValueMinor = (quantity: string, unitCostMinor: number): number => Math.round(Number(quantity) * unitCostMinor);
