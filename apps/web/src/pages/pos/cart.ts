/**
 * POS cart: plain data + a reducer, with no React or network in it, so it is easy to test.
 *
 * Totals shown from here are a PREVIEW calculated with the same pricing engine and the same
 * menu data the server uses. The amount actually charged always comes from the server's
 * order response.
 */
import { priceOrder, type CreateOrderInput, type OrderType, type PricingResult, type PricingTaxRule } from '@serveos/shared';
import type { Catalog, CatalogProduct } from '@/lib/types';

export interface CartModifier {
  id: string;
  groupName: string;
  name: string;
  priceMinor: number;
}

export interface CartDiscount {
  type: 'PERCENT' | 'FLAT';
  /** Basis points for PERCENT, minor units for FLAT. */
  value: number;
  reason: string;
}

export interface CartLine {
  lineId: string;
  productId: string;
  variantId: string;
  name: string;
  variantName: string;
  quantity: number;
  unitPriceMinor: number;
  modifiers: CartModifier[];
  notes: string;
  discount: CartDiscount | null;
}

export interface CartState {
  type: OrderType;
  tableId: string | null;
  tableName: string;
  customer: { id: string; name: string; loyaltyPoints: number } | null;
  guestCount: number;
  notes: string;
  deliveryName: string;
  deliveryPhone: string;
  deliveryAddress: string;
  lines: CartLine[];
  orderDiscount: CartDiscount | null;
  couponCode: string | null;
  /** Idempotency key for the next "create order" attempt; replaced only after it succeeds. */
  attemptKey: string;
  /** Set when the cart is an existing draft/held order being edited. */
  draftOrderId: string | null;
}

const newId = (): string => crypto.randomUUID();

export function emptyCart(type: OrderType = 'TAKEAWAY'): CartState {
  return {
    type, tableId: null, tableName: '', customer: null, guestCount: 1, notes: '', deliveryName: '', deliveryPhone: '', deliveryAddress: '',
    lines: [], orderDiscount: null, couponCode: null, attemptKey: `order-${newId()}`, draftOrderId: null,
  };
}

export type CartAction =
  | { kind: 'add'; line: Omit<CartLine, 'lineId' | 'discount'> }
  | { kind: 'setQuantity'; lineId: string; quantity: number }
  | { kind: 'remove'; lineId: string }
  | { kind: 'setLineDiscount'; lineId: string; discount: CartDiscount | null }
  | { kind: 'setType'; type: OrderType }
  | { kind: 'setTable'; tableId: string | null; tableName: string }
  | { kind: 'setCustomer'; customer: CartState['customer'] }
  | { kind: 'setOrderDiscount'; discount: CartDiscount | null }
  | { kind: 'setCoupon'; code: string | null }
  | { kind: 'patch'; fields: Partial<Pick<CartState, 'guestCount' | 'notes' | 'deliveryName' | 'deliveryPhone' | 'deliveryAddress'>> }
  | { kind: 'clearDiscounts' }
  | { kind: 'load'; cart: CartState }
  | { kind: 'reset'; type?: OrderType };

const sameSelection = (a: Omit<CartLine, 'lineId' | 'discount'>, b: CartLine): boolean =>
  a.productId === b.productId && a.variantId === b.variantId && a.notes === b.notes && !b.discount &&
  a.modifiers.map((m) => m.id).sort().join() === b.modifiers.map((m) => m.id).sort().join();

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.kind) {
    case 'add': {
      // Tapping the same item with the same choices again raises its quantity instead of adding a row.
      const existing = state.lines.find((l) => sameSelection(action.line, l));
      if (existing) return { ...state, lines: state.lines.map((l) => (l === existing ? { ...l, quantity: Math.min(999, l.quantity + action.line.quantity) } : l)) };
      return { ...state, lines: [...state.lines, { ...action.line, lineId: newId(), discount: null }] };
    }
    case 'setQuantity':
      if (action.quantity <= 0) return { ...state, lines: state.lines.filter((l) => l.lineId !== action.lineId) };
      return { ...state, lines: state.lines.map((l) => (l.lineId === action.lineId ? { ...l, quantity: Math.min(999, Math.floor(action.quantity)) } : l)) };
    case 'remove':
      return { ...state, lines: state.lines.filter((l) => l.lineId !== action.lineId) };
    case 'setLineDiscount':
      return { ...state, lines: state.lines.map((l) => (l.lineId === action.lineId ? { ...l, discount: action.discount } : l)) };
    case 'setType':
      // A table only makes sense for dine-in.
      return { ...state, type: action.type, ...(action.type === 'DINE_IN' ? {} : { tableId: null, tableName: '' }) };
    case 'setTable':
      return { ...state, tableId: action.tableId, tableName: action.tableName, type: action.tableId ? 'DINE_IN' : state.type };
    case 'setCustomer':
      return { ...state, customer: action.customer };
    case 'setOrderDiscount':
      return { ...state, orderDiscount: action.discount, couponCode: action.discount ? null : state.couponCode };
    case 'setCoupon':
      return { ...state, couponCode: action.code, orderDiscount: action.code ? null : state.orderDiscount };
    case 'patch':
      return { ...state, ...action.fields };
    case 'clearDiscounts':
      return { ...state, orderDiscount: null, couponCode: null, lines: state.lines.map((l) => ({ ...l, discount: null })) };
    case 'load':
      return action.cart;
    case 'reset':
      return emptyCart(action.type ?? state.type);
  }
}

export const lineUnitMinor = (line: CartLine): number => line.unitPriceMinor + line.modifiers.reduce((a, m) => a + m.priceMinor, 0);
export const cartCount = (cart: CartState): number => cart.lines.reduce((a, l) => a + l.quantity, 0);

function taxRulesFor(catalog: Catalog, product: CatalogProduct | undefined): PricingTaxRule[] {
  const category = catalog.taxCategories.find((t) => t.id === product?.taxCategoryId);
  // The preview assumes a sale within the outlet's state; the server decides the real place of supply.
  return (category?.rules ?? []).filter((r) => r.scope !== 'INTER_STATE').map((r) => ({ component: r.component, name: r.name, rateBps: r.rateBps }));
}

/** Estimated totals for the cart. A coupon cannot be previewed here: the server validates it. */
export function previewTotals(cart: CartState, catalog: Catalog): PricingResult {
  const s = catalog.settings;
  const local = (rules: Catalog['settings']['serviceChargeTaxRules']) => rules.filter((r) => r.scope !== 'INTER_STATE');
  return priceOrder({
    lines: cart.lines.map((l) => ({
      key: l.lineId,
      unitPriceMinor: l.unitPriceMinor,
      modifiersMinor: l.modifiers.reduce((a, m) => a + m.priceMinor, 0),
      quantity: l.quantity,
      discount: l.discount ? { type: l.discount.type, value: l.discount.value } : null,
      taxRules: taxRulesFor(catalog, catalog.products.find((p) => p.id === l.productId)),
    })),
    pricesIncludeTax: s.pricesIncludeTax,
    orderDiscount: cart.orderDiscount ? { type: cart.orderDiscount.type, value: cart.orderDiscount.value } : null,
    serviceChargeBps: cart.type === 'DINE_IN' ? s.serviceChargeBps : 0,
    serviceChargeTaxRules: local(s.serviceChargeTaxRules),
    deliveryChargeMinor: cart.type === 'DELIVERY' && cart.lines.length > 0 ? s.deliveryChargeMinor : 0,
    deliveryChargeTaxRules: local(s.deliveryChargeTaxRules),
    roundOffMode: s.roundOffMode,
  });
}

/** The request body for the API. Deliberately contains no prices or totals. */
export function toOrderPayload(cart: CartState, action: 'DRAFT' | 'HOLD' | 'PLACE'): CreateOrderInput {
  return {
    type: cart.type,
    tableId: cart.type === 'DINE_IN' ? cart.tableId : null,
    customerId: cart.customer?.id ?? null,
    guestCount: cart.guestCount,
    notes: cart.notes,
    deliveryName: cart.deliveryName,
    deliveryPhone: cart.deliveryPhone,
    deliveryAddress: cart.deliveryAddress,
    items: cart.lines.map((l) => ({
      clientLineId: l.lineId,
      productId: l.productId,
      variantId: l.variantId,
      quantity: l.quantity,
      modifierOptionIds: l.modifiers.map((m) => m.id),
      notes: l.notes,
      discount: l.discount,
    })),
    orderDiscount: cart.orderDiscount,
    couponCode: cart.couponCode,
    action,
  };
}

/** Why the cart cannot be sent yet, or null if it can. */
export function cartProblem(cart: CartState): string | null {
  if (cart.lines.length === 0) return 'Add at least one item';
  if (cart.type === 'DINE_IN' && !cart.tableId) return 'Choose a table';
  if (cart.type === 'DELIVERY' && (!cart.deliveryAddress.trim() || !cart.deliveryPhone.trim())) return 'Enter the delivery address and phone';
  return null;
}

/** Checks a modifier selection against a product's groups; returns the first problem or null. */
export function modifierProblem(catalog: Catalog, product: CatalogProduct, selectedIds: string[]): string | null {
  for (const groupId of product.modifierGroupIds) {
    const group = catalog.modifierGroups.find((g) => g.id === groupId);
    if (!group) continue;
    const count = group.options.filter((o) => selectedIds.includes(o.id)).length;
    if (count < group.minSelect) return `Choose ${group.minSelect === 1 ? 'one' : `at least ${group.minSelect}`} from ${group.name}`;
    if (count > group.maxSelect) return `Choose at most ${group.maxSelect} from ${group.name}`;
  }
  return null;
}

/** Finds products by name or SKU; every word typed must match. */
export function searchProducts(products: CatalogProduct[], query: string): CatalogProduct[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return products;
  return products.filter((p) => {
    const haystack = `${p.name} ${p.sku}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}
