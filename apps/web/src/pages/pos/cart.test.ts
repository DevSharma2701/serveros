import { describe, expect, it } from 'vitest';
import { cartCount, cartProblem, cartReducer, emptyCart, modifierProblem, previewTotals, searchProducts, toOrderPayload, type CartLine, type CartState } from './cart';
import { catalog } from './fixtures';

const tea = (quantity = 1): Omit<CartLine, 'lineId' | 'discount'> => ({ productId: 'tea', variantId: 'tea-r', name: 'Masala Chai', variantName: 'Regular', quantity, unitPriceMinor: 10_000, modifiers: [], notes: '' });
const curry = (mods: Array<{ id: string; priceMinor: number }> = [{ id: 'mild', priceMinor: 0 }]): Omit<CartLine, 'lineId' | 'discount'> => ({
  productId: 'curry', variantId: 'curry-f', name: 'Butter Chicken', variantName: 'Full', quantity: 1, unitPriceMinor: 30_000, notes: '',
  modifiers: mods.map((m) => ({ ...m, name: m.id, groupName: 'g' })),
});
const run = (actions: Array<Parameters<typeof cartReducer>[1]>, start: CartState = emptyCart()) => actions.reduce(cartReducer, start);

describe('selecting products', () => {
  it('adds a line, and tapping the same item again raises the quantity', () => {
    const cart = run([{ kind: 'add', line: tea() }, { kind: 'add', line: tea() }, { kind: 'add', line: tea(3) }]);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]!.quantity).toBe(5);
    expect(cartCount(cart)).toBe(5);
  });

  it('keeps different choices on separate lines', () => {
    const cart = run([
      { kind: 'add', line: curry([{ id: 'mild', priceMinor: 0 }]) },
      { kind: 'add', line: curry([{ id: 'hot', priceMinor: 0 }]) },
      { kind: 'add', line: curry([{ id: 'mild', priceMinor: 0 }]) },
      { kind: 'add', line: { ...tea(), notes: 'less sugar' } },
      { kind: 'add', line: tea() },
    ]);
    expect(cart.lines.map((l) => l.quantity)).toEqual([2, 1, 1, 1]);
  });

  it('changes and removes quantities', () => {
    let cart = run([{ kind: 'add', line: tea() }, { kind: 'add', line: curry() }]);
    const [first, second] = cart.lines;
    cart = cartReducer(cart, { kind: 'setQuantity', lineId: first!.lineId, quantity: 4 });
    expect(cart.lines[0]!.quantity).toBe(4);
    cart = cartReducer(cart, { kind: 'setQuantity', lineId: first!.lineId, quantity: 0 });
    expect(cart.lines.map((l) => l.lineId)).toEqual([second!.lineId]);
    cart = cartReducer(cart, { kind: 'remove', lineId: second!.lineId });
    expect(cart.lines).toHaveLength(0);
  });

  it('searches by name or SKU', () => {
    expect(searchProducts(catalog.products, 'chai').map((p) => p.id)).toEqual(['tea']);
    expect(searchProducts(catalog.products, 'man-001').map((p) => p.id)).toEqual(['curry']);
    expect(searchProducts(catalog.products, 'butter').map((p) => p.id)).toEqual(['curry', 'naan']);
    expect(searchProducts(catalog.products, 'butter naan').map((p) => p.id)).toEqual(['naan']);
    expect(searchProducts(catalog.products, '   ')).toHaveLength(3);
  });
});

describe('modifier rules', () => {
  const product = catalog.products[1]!;
  it('requires the mandatory group and limits optional ones', () => {
    expect(modifierProblem(catalog, product, [])).toBe('Choose one from Spice level');
    expect(modifierProblem(catalog, product, ['mild', 'hot'])).toBe('Choose at most 1 from Spice level');
    expect(modifierProblem(catalog, product, ['mild', 'butter', 'cheese', 'egg'])).toBe('Choose at most 2 from Extras');
    expect(modifierProblem(catalog, product, ['hot', 'butter'])).toBeNull();
    expect(modifierProblem(catalog, catalog.products[0]!, [])).toBeNull();
  });
});

describe('cart totals (preview with the shared pricing engine)', () => {
  it('adds modifiers and tax', () => {
    const cart = run([{ kind: 'add', line: curry([{ id: 'hot', priceMinor: 0 }, { id: 'butter', priceMinor: 2_000 }, { id: 'cheese', priceMinor: 3_000 }]) }, { kind: 'add', line: tea(2) }]);
    const totals = previewTotals(cart, catalog);
    expect(totals).toMatchObject({ subtotalMinor: 55_000, taxMinor: 2_750, totalMinor: 57_750 });
    expect(totals.taxLines.map((t) => t.name)).toEqual(['CGST 2.5%', 'SGST 2.5%']); // IGST is not previewed
  });

  it('applies item and order discounts before tax', () => {
    let cart = run([{ kind: 'add', line: tea(2) }]);
    cart = cartReducer(cart, { kind: 'setOrderDiscount', discount: { type: 'PERCENT', value: 1000, reason: 'Regular' } });
    expect(previewTotals(cart, catalog)).toMatchObject({ orderDiscountMinor: 2_000, taxableMinor: 18_000, totalMinor: 18_900 });
    cart = cartReducer(cart, { kind: 'setLineDiscount', lineId: cart.lines[0]!.lineId, discount: { type: 'FLAT', value: 5_000, reason: 'Spilled' } });
    expect(previewTotals(cart, catalog)).toMatchObject({ itemDiscountMinor: 5_000, orderDiscountMinor: 1_500, taxableMinor: 13_500 });
  });

  it('charges service only on dine-in and delivery only on delivery', () => {
    const base = run([{ kind: 'add', line: tea(2) }]);
    expect(previewTotals(base, catalog)).toMatchObject({ serviceChargeMinor: 0, deliveryChargeMinor: 0 });
    expect(previewTotals(cartReducer(base, { kind: 'setTable', tableId: 't1', tableName: 'T1' }), catalog).serviceChargeMinor).toBe(2_000);
    expect(previewTotals(cartReducer(base, { kind: 'setType', type: 'DELIVERY' }), catalog).deliveryChargeMinor).toBe(4_000);
    expect(previewTotals(emptyCart('DELIVERY'), catalog).totalMinor).toBe(0);
  });

  it('a coupon and a manual discount replace each other', () => {
    let cart = cartReducer(emptyCart(), { kind: 'setOrderDiscount', discount: { type: 'FLAT', value: 100, reason: 'abc' } });
    cart = cartReducer(cart, { kind: 'setCoupon', code: 'WELCOME10' });
    expect(cart).toMatchObject({ couponCode: 'WELCOME10', orderDiscount: null });
    cart = cartReducer(cart, { kind: 'setOrderDiscount', discount: { type: 'FLAT', value: 100, reason: 'abc' } });
    expect(cart.couponCode).toBeNull();
  });
});

describe('checkout validation', () => {
  it('explains what is missing before an order can be sent', () => {
    expect(cartProblem(emptyCart())).toBe('Add at least one item');
    const withTea = run([{ kind: 'add', line: tea() }]);
    expect(cartProblem(withTea)).toBeNull();
    expect(cartProblem(cartReducer(withTea, { kind: 'setType', type: 'DINE_IN' }))).toBe('Choose a table');
    const delivery = cartReducer(withTea, { kind: 'setType', type: 'DELIVERY' });
    expect(cartProblem(delivery)).toBe('Enter the delivery address and phone');
    expect(cartProblem(cartReducer(delivery, { kind: 'patch', fields: { deliveryAddress: '1 Road', deliveryPhone: '9000000000' } }))).toBeNull();
  });

  it('switching away from dine-in releases the table', () => {
    const dineIn = cartReducer(emptyCart(), { kind: 'setTable', tableId: 't1', tableName: 'T1' });
    expect(dineIn).toMatchObject({ type: 'DINE_IN', tableId: 't1' });
    expect(cartReducer(dineIn, { kind: 'setType', type: 'TAKEAWAY' })).toMatchObject({ tableId: null, tableName: '' });
  });

  it('never sends prices or totals to the server', () => {
    const cart = run([{ kind: 'add', line: curry([{ id: 'hot', priceMinor: 0 }, { id: 'butter', priceMinor: 2_000 }]) }]);
    const payload = toOrderPayload(cart, 'PLACE');
    expect(payload.items[0]).toEqual({ clientLineId: cart.lines[0]!.lineId, productId: 'curry', variantId: 'curry-f', quantity: 1, modifierOptionIds: ['hot', 'butter'], notes: '', discount: null });
    expect(JSON.stringify(payload)).not.toMatch(/priceMinor|totalMinor|unitPrice/);
    expect(payload.action).toBe('PLACE');
  });

  it('keeps the same idempotency key until the cart is reset', () => {
    const cart = run([{ kind: 'add', line: tea() }, { kind: 'add', line: tea() }]);
    expect(cart.attemptKey).toBe(run([{ kind: 'setType', type: 'PICKUP' }], cart).attemptKey);
    expect(cartReducer(cart, { kind: 'reset' }).attemptKey).not.toBe(cart.attemptKey);
  });
});
