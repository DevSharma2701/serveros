/** Shapes of API responses used by the web app. The API is the source of truth for all of them. */
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
  restaurant: {
    id: string;
    name: string;
    currency: string;
    pricesIncludeTax: boolean;
    roundOffMode: 'NONE' | 'NEAREST_UNIT';
    serviceChargeBps: number;
    discountApprovalThresholdBps: number;
    allowPartialPayment: boolean;
    loyaltyEnabled: boolean;
    loyaltyPointValueMinor: number;
    loyaltyMinRedeemPoints: number;
  } | null;
  outlets: OutletRef[];
  /** True when the user may act in every outlet of the restaurant. */
  allOutlets: boolean;
  permissions: PermissionKey[];
  outletPermissions: Record<string, PermissionKey[]>;
  paymentGateway: 'none' | 'dev' | 'razorpay';
}

export interface TaxRule {
  component: string;
  name: string;
  rateBps: number;
  scope: 'ANY' | 'INTRA_STATE' | 'INTER_STATE';
}

export interface CatalogProduct {
  id: string;
  name: string;
  sku: string;
  categoryId: string;
  description: string;
  imageUrl: string | null;
  isVeg: boolean | null;
  isFavorite: boolean;
  isAvailable: boolean;
  taxCategoryId: string | null;
  variants: Array<{ id: string; name: string; priceMinor: number; isDefault: boolean }>;
  modifierGroupIds: string[];
}

export interface CatalogModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: Array<{ id: string; name: string; priceMinor: number }>;
}

export interface Catalog {
  generatedAt: string;
  settings: {
    currency: string;
    pricesIncludeTax: boolean;
    roundOffMode: 'NONE' | 'NEAREST_UNIT';
    /** Applies to dine-in orders only; 0 when the outlet does not charge it. */
    serviceChargeBps: number;
    serviceChargeTaxRules: TaxRule[];
    /** Applies to delivery orders only. */
    deliveryChargeMinor: number;
    deliveryChargeTaxRules: TaxRule[];
    discountApprovalThresholdBps: number;
    outletStateCode: string;
  };
  categories: Array<{ id: string; name: string; parentId: string | null; sortOrder: number }>;
  products: CatalogProduct[];
  modifierGroups: CatalogModifierGroup[];
  taxCategories: Array<{ id: string; name: string; rules: TaxRule[] }>;
  stations: Array<{ id: string; key: string; name: string }>;
  popularProductIds: string[];
}

export interface OrderItem {
  id: string;
  productId: string;
  variantId: string;
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
  sentToKitchenAt: string | null;
  modifiers: Array<{ id: string; modifierOptionId: string; groupName: string; optionName: string; priceMinor: number }>;
}

export interface Payment {
  id: string;
  orderId: string;
  method: PaymentMethod;
  provider: string;
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  verification: 'NOT_REQUIRED' | 'MANUAL' | 'GATEWAY';
  amountMinor: number;
  tenderedMinor: number | null;
  changeMinor: number;
  refundedMinor: number;
  reference: string;
  failureReason: string;
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
  source: 'POS' | 'POS_OFFLINE' | 'QR';
  guestName: string;
  isHeld: boolean;
  currency: string;
  tableLabel: string;
  guestCount: number;
  notes: string;
  deliveryName: string;
  deliveryPhone: string;
  deliveryAddress: string;
  customerId: string | null;
  customer: { id: string; name: string; loyaltyPoints: number } | null;
  waiterId: string | null;
  discountCode: string | null;
  orderDiscountType: 'PERCENT' | 'FLAT' | null;
  orderDiscountValue: number;
  discountReason: string;
  subtotalMinor: number;
  itemDiscountMinor: number;
  orderDiscountMinor: number;
  serviceChargeMinor: number;
  deliveryChargeMinor: number;
  taxableMinor: number;
  taxMinor: number;
  roundOffMinor: number;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  dueMinor: number;
  paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
  cancelReason: string;
  createdAt: string;
  placedAt: string | null;
  completedAt: string | null;
  items: OrderItem[];
  taxLines: Array<{ id: string; name: string; rateBps: number; amountMinor: number }>;
  events: OrderEvent[];
  tables: Array<{ id: string; table: { id: string; name: string } }>;
  payments: Payment[];
  refunds: Array<{ id: string; paymentId: string; amountMinor: number; reason: string; creditNoteNumber: string; createdAt: string }>;
  invoice: { id: string; invoiceNumber: string; issuedAt: string } | null;
  replayed?: boolean;
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  type: OrderType;
  status: OrderStatus;
  isHeld: boolean;
  source: 'POS' | 'POS_OFFLINE' | 'QR';
  guestName: string;
  tableLabel: string;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  paymentStatus: Order['paymentStatus'];
  createdAt: string;
  completedAt: string | null;
  guestCount: number;
  notes: string;
  customer: { id: string; name: string } | null;
  _count: { items: number };
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface FloorTable {
  id: string;
  name: string;
  capacity: number;
  posX: number;
  posY: number;
  shape: string;
  isActive: boolean;
  areaId: string;
  assignedWaiterId: string | null;
  assignedWaiterName: string | null;
  status: 'AVAILABLE' | 'OCCUPIED' | 'RESERVED';
  /** Paid guest (QR) orders in progress on this table. */
  guestOrders: number;
  order: { id: string; orderNumber: string; status: OrderStatus; isHeld: boolean; totalMinor: number; paymentStatus: Order['paymentStatus']; createdAt: string; guestCount: number; itemCount: number; waiterName: string | null } | null;
  reservation: { id: string; guestName: string; partySize: number; startsAt: string; endsAt: string } | null;
}

export interface FloorArea {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  tables: FloorTable[];
}

export interface ShiftSummary {
  shift: { id: string; status: 'OPEN' | 'CLOSED'; openedAt: string; openedByName: string; openedById: string; closedAt: string | null; openingFloatMinor: number; expectedCashMinor: number | null; countedCashMinor: number | null; varianceMinor: number | null; closeNote: string; register: { name: string } };
  cash: { openingFloatMinor: number; salesMinor: number; refundsMinor: number; cashInMinor: number; cashOutMinor: number; pettyCashMinor: number; expectedCashMinor: number };
  byMethod: Array<{ method: string; count: number; collectedMinor: number; refundedMinor: number; netMinor: number }>;
  movements: Array<{ id: string; type: string; amountMinor: number; reason: string; createdAt: string }>;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string;
  loyaltyPoints: number;
  notes?: string;
}

export interface Receipt {
  orderId: string;
  isInvoice: boolean;
  invoiceNumber: string | null;
  text: string;
}
