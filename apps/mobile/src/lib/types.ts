/** Shapes of the API responses the mobile app reads. The API is the source of truth for all of them. */
import type { OrderStatus, OrderType, PaymentMethod, PermissionKey } from '@serveos/shared';

export interface OutletRef {
  id: string;
  name: string;
  code: string;
  timezone: string;
  city: string;
  stateCode: string;
}

export interface Me {
  user: { id: string; name: string; email: string; role: { key: string; name: string; rank: number } };
  restaurant: { id: string; name: string; currency: string } | null;
  outlets: OutletRef[];
  permissions: PermissionKey[];
  outletPermissions: Record<string, PermissionKey[]>;
}

export interface Tokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// ── Reports ──
export interface DashboardSummary {
  orders: number;
  grossSalesMinor: number;
  discountsMinor: number;
  serviceChargeMinor: number;
  deliveryChargeMinor: number;
  netSalesMinor: number;
  taxesMinor: number;
  roundOffMinor: number;
  totalBilledMinor: number;
  averageOrderValueMinor: number;
  collectedMinor: number;
  refundsMinor: number;
  netCollectedMinor: number;
  cancelledOrders: number;
  openOrders: number;
  cashVarianceMinor: number;
}

export interface DashboardCashShift {
  id: string;
  openedByName: string;
  closedAt: string | null;
  expectedCashMinor: number | null;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  register: string;
  outlet: string;
}

export interface InventoryAlert {
  outletId: string;
  outlet: string;
  ingredientId: string;
  name: string;
  quantity: string;
  threshold: string;
  unit: string;
}

export interface Dashboard {
  range: { from: string; to: string };
  outlets: Array<{ id: string; name: string; timezone: string }>;
  definitions: Record<string, string>;
  summary: DashboardSummary;
  paymentsByMethod: Array<{ method: string; count: number; amountMinor: number; refundedMinor: number }>;
  salesByType: Array<{ type: string; orders: number; totalMinor: number }>;
  topProducts: Array<{ productId: string; name: string; quantity: number; netSalesMinor: number }>;
  categories: Array<{ name: string; quantity: number; netSalesMinor: number }>;
  hourly: Array<{ hour: number; orders: number; totalMinor: number }>;
  daily: Array<{ day: string; orders: number; totalMinor: number; netSalesMinor: number }>;
  outletComparison: Array<{ outletId: string; outlet: string; orders: number; netSalesMinor: number; totalBilledMinor: number; cancelledOrders: number }>;
  cashShifts: DashboardCashShift[];
  inventoryAlerts: InventoryAlert[];
}

// ── Orders ──
export type PaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

export interface OrderSummary {
  id: string;
  orderNumber: string;
  type: OrderType;
  status: OrderStatus;
  isHeld: boolean;
  tableLabel: string;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  paymentStatus: PaymentStatus;
  createdAt: string;
  placedAt: string | null;
  completedAt: string | null;
  guestCount: number;
  notes: string;
  customer: { id: string; name: string } | null;
  _count: { items: number };
}

export interface OrderItem {
  id: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPriceMinor: number;
  modifiersMinor: number;
  lineSubtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  notes: string;
  status: 'ACTIVE' | 'VOIDED';
  voidReason: string;
  modifiers: Array<{ id: string; groupName: string; optionName: string; priceMinor: number }>;
}

export interface Payment {
  id: string;
  method: PaymentMethod;
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  amountMinor: number;
  refundedMinor: number;
  reference: string;
  createdAt: string;
}

export interface OrderEvent {
  id: string;
  type: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  actorName: string;
  message: string;
  createdAt: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  type: OrderType;
  status: OrderStatus;
  isHeld: boolean;
  currency: string;
  tableLabel: string;
  guestCount: number;
  notes: string;
  deliveryName: string;
  deliveryPhone: string;
  deliveryAddress: string;
  customer: { id: string; name: string } | null;
  subtotalMinor: number;
  itemDiscountMinor: number;
  orderDiscountMinor: number;
  serviceChargeMinor: number;
  deliveryChargeMinor: number;
  taxMinor: number;
  roundOffMinor: number;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  paymentStatus: PaymentStatus;
  cancelReason: string;
  createdAt: string;
  placedAt: string | null;
  completedAt: string | null;
  items: OrderItem[];
  events?: OrderEvent[];
  payments?: Payment[];
  invoice?: { id: string; invoiceNumber: string; issuedAt: string } | null;
}

// ── Menu ──
export interface CatalogProduct {
  id: string;
  name: string;
  sku: string;
  categoryId: string;
  isVeg: boolean | null;
  isAvailable: boolean;
  variants: Array<{ id: string; name: string; priceMinor: number; isDefault: boolean }>;
}

export interface Catalog {
  categories: Array<{ id: string; name: string; parentId: string | null; sortOrder: number }>;
  products: CatalogProduct[];
}

// ── Inventory ──
export interface StockRow {
  ingredientId: string;
  name: string;
  sku: string;
  unit: string;
  /** Decimal string in the ingredient's base unit. */
  quantity: string;
  lowStockThreshold: string;
  isLow: boolean;
  valueMinor: number;
}

// ── Cash ──
export interface Shift {
  id: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  openedByName: string;
  closedAt: string | null;
  openingFloatMinor: number;
  expectedCashMinor: number | null;
  countedCashMinor: number | null;
  varianceMinor: number | null;
  closeNote: string;
  register: { name: string };
}

export interface ShiftDetail {
  shift: Shift;
  cash: { openingFloatMinor: number; salesMinor: number; refundsMinor: number; cashInMinor: number; cashOutMinor: number; pettyCashMinor: number; expectedCashMinor: number };
  byMethod: Array<{ method: string; count: number; collectedMinor: number; refundedMinor: number; netMinor: number }>;
  movements: Array<{ id: string; type: string; amountMinor: number; reason: string; createdAt: string }>;
}

// ── Staff ──
export interface AuditEvent {
  id: string;
  outletId: string | null;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Attendance {
  id: string;
  userId: string;
  clockInAt: string;
  clockOutAt: string | null;
  user: { id: string; name: string };
}

export interface Session {
  id: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}
