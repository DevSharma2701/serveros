/**
 * ServeOS pricing engine.
 *
 * A pure function over integers (minor currency units and basis points). The API uses it
 * to produce the authoritative totals; the POS uses the same code only to preview a cart.
 *
 * Order of calculation
 *  1. line subtotal   = (unit price + modifiers) x quantity
 *  2. item discount   = percent of the line, or a flat amount capped at the line
 *  3. order discount  = percent or flat amount of what is left, shared across lines pro rata
 *  4. tax             = per line, per tax rule, on the discounted amount
 *                       (extracted from the amount when prices include tax)
 *  5. service charge  = percent of the pre-tax, post-discount food value; taxed by its own rules
 *  6. delivery charge = flat amount; taxed by its own rules
 *  7. round-off       = optional rounding of the grand total to a whole currency unit
 */

export type DiscountInput = { type: 'PERCENT' | 'FLAT'; value: number; maxDiscountMinor?: number | null };
export type PricingTaxRule = { component: string; name: string; rateBps: number };

export interface PricingLineInput {
  key: string;
  unitPriceMinor: number;
  modifiersMinor: number;
  quantity: number;
  discount?: DiscountInput | null;
  taxRules: PricingTaxRule[];
}

export interface PricingInput {
  lines: PricingLineInput[];
  pricesIncludeTax: boolean;
  orderDiscount?: DiscountInput | null;
  serviceChargeBps?: number;
  serviceChargeTaxRules?: PricingTaxRule[];
  deliveryChargeMinor?: number;
  deliveryChargeTaxRules?: PricingTaxRule[];
  roundOffMode?: 'NONE' | 'NEAREST_UNIT';
  /** Minor units in one major unit (100 paise in a rupee). */
  minorPerUnit?: number;
}

export interface PricedTax extends PricingTaxRule {
  taxableMinor: number;
  amountMinor: number;
}

export interface PricedLine {
  key: string;
  lineSubtotalMinor: number;
  discountMinor: number;
  orderDiscountShareMinor: number;
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
  taxes: PricedTax[];
}

export interface PricingResult {
  lines: PricedLine[];
  taxLines: PricedTax[];
  subtotalMinor: number;
  itemDiscountMinor: number;
  orderDiscountMinor: number;
  serviceChargeMinor: number;
  deliveryChargeMinor: number;
  taxableMinor: number;
  taxMinor: number;
  roundOffMinor: number;
  totalMinor: number;
}

/** Round half up for non-negative values; all inputs here are non-negative integers. */
function divRound(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function assertInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

/**
 * Splits `total` across `weights` so the parts are integers that add up exactly to `total`.
 * Uses the largest-remainder method, so no minor unit is lost or invented.
 */
export function allocate(total: number, weights: number[]): number[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || weightSum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / weightSum);
  const parts = exact.map((x) => Math.floor(x));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let n = 0; remainder > 0; n++, remainder--) {
    const slot = order[n % order.length]!;
    parts[slot.i]! += 1;
  }
  return parts;
}

export function discountAmount(baseMinor: number, discount: DiscountInput | null | undefined): number {
  if (!discount || discount.value <= 0 || baseMinor <= 0) return 0;
  let amount = discount.type === 'PERCENT' ? divRound(baseMinor * Math.min(discount.value, 10000), 10000) : discount.value;
  if (discount.maxDiscountMinor != null) amount = Math.min(amount, discount.maxDiscountMinor);
  return Math.min(amount, baseMinor);
}

function taxOn(amountMinor: number, rules: PricingTaxRule[], inclusive: boolean): { taxableMinor: number; taxes: PricedTax[] } {
  const rateSum = rules.reduce((a, r) => a + r.rateBps, 0);
  if (rateSum === 0 || amountMinor === 0) {
    return { taxableMinor: amountMinor, taxes: rules.map((r) => ({ ...r, taxableMinor: amountMinor, amountMinor: 0 })) };
  }
  if (inclusive) {
    const taxableMinor = divRound(amountMinor * 10000, 10000 + rateSum);
    const parts = allocate(amountMinor - taxableMinor, rules.map((r) => r.rateBps));
    return { taxableMinor, taxes: rules.map((r, i) => ({ ...r, taxableMinor, amountMinor: parts[i]! })) };
  }
  return {
    taxableMinor: amountMinor,
    taxes: rules.map((r) => ({ ...r, taxableMinor: amountMinor, amountMinor: divRound(amountMinor * r.rateBps, 10000) })),
  };
}

export function priceOrder(input: PricingInput): PricingResult {
  const minorPerUnit = input.minorPerUnit ?? 100;
  const taxTotals = new Map<string, PricedTax>();
  const addTax = (t: PricedTax) => {
    if (t.amountMinor === 0 && t.rateBps === 0) return;
    const k = `${t.component}|${t.name}|${t.rateBps}`;
    const cur = taxTotals.get(k);
    if (cur) {
      cur.taxableMinor += t.taxableMinor;
      cur.amountMinor += t.amountMinor;
    } else taxTotals.set(k, { ...t });
  };

  const base = input.lines.map((l) => {
    assertInt(l.unitPriceMinor, 'unitPriceMinor');
    assertInt(l.modifiersMinor, 'modifiersMinor');
    assertInt(l.quantity, 'quantity');
    const lineSubtotalMinor = (l.unitPriceMinor + l.modifiersMinor) * l.quantity;
    const discountMinor = discountAmount(lineSubtotalMinor, l.discount);
    return { line: l, lineSubtotalMinor, discountMinor, afterItem: lineSubtotalMinor - discountMinor };
  });

  const afterItemTotal = base.reduce((a, b) => a + b.afterItem, 0);
  const orderDiscountMinor = discountAmount(afterItemTotal, input.orderDiscount);
  const shares = allocate(orderDiscountMinor, base.map((b) => b.afterItem));

  const lines: PricedLine[] = base.map((b, i) => {
    const share = shares[i]!;
    const { taxableMinor, taxes } = taxOn(b.afterItem - share, b.line.taxRules, input.pricesIncludeTax);
    taxes.forEach(addTax);
    const taxMinor = taxes.reduce((a, t) => a + t.amountMinor, 0);
    return {
      key: b.line.key,
      lineSubtotalMinor: b.lineSubtotalMinor,
      discountMinor: b.discountMinor,
      orderDiscountShareMinor: share,
      taxableMinor,
      taxMinor,
      totalMinor: taxableMinor + taxMinor,
      taxes,
    };
  });

  const foodTaxable = lines.reduce((a, l) => a + l.taxableMinor, 0);
  const serviceChargeMinor = input.serviceChargeBps ? divRound(foodTaxable * input.serviceChargeBps, 10000) : 0;
  const deliveryChargeMinor = input.deliveryChargeMinor ?? 0;
  assertInt(deliveryChargeMinor, 'deliveryChargeMinor');

  // Charges are always entered exclusive of tax.
  const serviceTax = taxOn(serviceChargeMinor, serviceChargeMinor ? (input.serviceChargeTaxRules ?? []) : [], false);
  const deliveryTax = taxOn(deliveryChargeMinor, deliveryChargeMinor ? (input.deliveryChargeTaxRules ?? []) : [], false);
  [...serviceTax.taxes, ...deliveryTax.taxes].forEach(addTax);

  const taxLines = [...taxTotals.values()];
  const taxMinor = taxLines.reduce((a, t) => a + t.amountMinor, 0);
  const taxableMinor = foodTaxable + serviceChargeMinor + deliveryChargeMinor;
  const beforeRound = taxableMinor + taxMinor;
  const roundOffMinor = input.roundOffMode === 'NEAREST_UNIT' ? divRound(beforeRound, minorPerUnit) * minorPerUnit - beforeRound : 0;

  return {
    lines,
    taxLines,
    subtotalMinor: base.reduce((a, b) => a + b.lineSubtotalMinor, 0),
    itemDiscountMinor: base.reduce((a, b) => a + b.discountMinor, 0),
    orderDiscountMinor,
    serviceChargeMinor,
    deliveryChargeMinor,
    taxableMinor,
    taxMinor,
    roundOffMinor,
    totalMinor: beforeRound + roundOffMinor,
  };
}
