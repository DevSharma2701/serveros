import { describe, expect, it } from 'vitest';
import { allocate, priceOrder, type PricingTaxRule } from './pricing';

const gst5: PricingTaxRule[] = [
  { component: 'CGST', name: 'CGST 2.5%', rateBps: 250 },
  { component: 'SGST', name: 'SGST 2.5%', rateBps: 250 },
];
const gst18: PricingTaxRule[] = [
  { component: 'CGST', name: 'CGST 9%', rateBps: 900 },
  { component: 'SGST', name: 'SGST 9%', rateBps: 900 },
];
const line = (key: string, unitPriceMinor: number, quantity = 1, extra = {}) => ({
  key,
  unitPriceMinor,
  modifiersMinor: 0,
  quantity,
  taxRules: gst5,
  ...extra,
});

describe('allocate', () => {
  it('splits without losing or inventing a paisa', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1000, [3333, 3333, 3334]).reduce((a, b) => a + b)).toBe(1000);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(50, [0, 0])).toEqual([0, 0]);
  });
});

describe('priceOrder', () => {
  it('adds tax on top when prices exclude tax', () => {
    const r = priceOrder({ lines: [line('a', 20000, 2)], pricesIncludeTax: false });
    expect(r.subtotalMinor).toBe(40000);
    expect(r.taxMinor).toBe(2000);
    expect(r.totalMinor).toBe(42000);
    expect(r.taxLines).toEqual([
      { component: 'CGST', name: 'CGST 2.5%', rateBps: 250, taxableMinor: 40000, amountMinor: 1000 },
      { component: 'SGST', name: 'SGST 2.5%', rateBps: 250, taxableMinor: 40000, amountMinor: 1000 },
    ]);
  });

  it('extracts tax when prices include tax, keeping the total unchanged', () => {
    const r = priceOrder({ lines: [line('a', 10500)], pricesIncludeTax: true });
    expect(r.totalMinor).toBe(10500);
    expect(r.taxableMinor).toBe(10000);
    expect(r.taxMinor).toBe(500);
    expect(r.taxLines.map((t) => t.amountMinor)).toEqual([250, 250]);
  });

  it('includes modifiers in the line and applies item discounts before tax', () => {
    const r = priceOrder({
      lines: [line('a', 20000, 2, { modifiersMinor: 3000, discount: { type: 'PERCENT', value: 1000 } })],
      pricesIncludeTax: false,
    });
    expect(r.subtotalMinor).toBe(46000);
    expect(r.itemDiscountMinor).toBe(4600);
    expect(r.taxableMinor).toBe(41400);
    expect(r.taxMinor).toBe(2070);
  });

  it('shares an order discount across lines so the parts add up exactly', () => {
    const r = priceOrder({
      lines: [line('a', 3333), line('b', 3333), line('c', 3334)],
      pricesIncludeTax: false,
      orderDiscount: { type: 'FLAT', value: 1000 },
    });
    expect(r.orderDiscountMinor).toBe(1000);
    expect(r.lines.reduce((a, l) => a + l.orderDiscountShareMinor, 0)).toBe(1000);
    expect(r.taxableMinor).toBe(9000);
  });

  it('never discounts below zero and honours a discount cap', () => {
    const over = priceOrder({ lines: [line('a', 5000)], pricesIncludeTax: false, orderDiscount: { type: 'FLAT', value: 99999 } });
    expect(over.totalMinor).toBe(0);
    const capped = priceOrder({
      lines: [line('a', 100000)],
      pricesIncludeTax: false,
      orderDiscount: { type: 'PERCENT', value: 5000, maxDiscountMinor: 10000 },
    });
    expect(capped.orderDiscountMinor).toBe(10000);
  });

  it('uses each line own tax rules and reports them separately', () => {
    const r = priceOrder({ lines: [line('food', 10000), line('soda', 10000, 1, { taxRules: gst18 })], pricesIncludeTax: false });
    expect(r.taxMinor).toBe(500 + 1800);
    expect(r.taxLines).toHaveLength(4);
  });

  it('charges service on the discounted pre-tax value and taxes it', () => {
    const r = priceOrder({
      lines: [line('a', 100000)],
      pricesIncludeTax: false,
      orderDiscount: { type: 'PERCENT', value: 1000 },
      serviceChargeBps: 1000,
      serviceChargeTaxRules: gst5,
      deliveryChargeMinor: 4000,
    });
    expect(r.serviceChargeMinor).toBe(9000);
    expect(r.taxMinor).toBe(4500 + 450);
    expect(r.totalMinor).toBe(90000 + 9000 + 4000 + 4950);
  });

  it('rounds the grand total to a whole rupee and records the difference', () => {
    const r = priceOrder({ lines: [line('a', 9999)], pricesIncludeTax: false, roundOffMode: 'NEAREST_UNIT' });
    // 9999 + 250 + 250 = 10499 -> 10500
    expect(r.roundOffMinor).toBe(1);
    expect(r.totalMinor).toBe(10500);
    const down = priceOrder({ lines: [line('a', 9940)], pricesIncludeTax: false, roundOffMode: 'NEAREST_UNIT' });
    // 9940 + 249 + 249 = 10438 -> 10400
    expect(down.roundOffMinor).toBe(-38);
    expect(down.totalMinor).toBe(10400);
  });

  it('line totals plus charges always reconcile with the grand total', () => {
    const r = priceOrder({
      lines: [line('a', 1999, 3), line('b', 4550, 2, { discount: { type: 'FLAT', value: 333 } }), line('c', 777, 7, { taxRules: gst18 })],
      pricesIncludeTax: true,
      orderDiscount: { type: 'PERCENT', value: 750 },
    });
    expect(r.lines.reduce((a, l) => a + l.totalMinor, 0)).toBe(r.totalMinor);
    expect(r.taxableMinor + r.taxMinor).toBe(r.totalMinor);
    expect(r.taxLines.reduce((a, t) => a + t.amountMinor, 0)).toBe(r.taxMinor);
  });

  it('rejects fractional or negative amounts', () => {
    expect(() => priceOrder({ lines: [line('a', 10.5)], pricesIncludeTax: false })).toThrow();
    expect(() => priceOrder({ lines: [line('a', 100, -1)], pricesIncludeTax: false })).toThrow();
  });
});
