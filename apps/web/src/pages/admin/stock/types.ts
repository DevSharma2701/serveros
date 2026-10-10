/**
 * Shapes returned by the inventory endpoints (see apps/api/src/modules/inventory.module.ts).
 * Quantities and average costs are decimals serialised as strings: show them, do not do sums on them.
 */

export type Dimension = 'MASS' | 'VOLUME' | 'COUNT';

export interface Unit {
  id: string;
  code: string;
  name: string;
  dimension: Dimension;
  toBaseFactor: string;
}

export interface Ingredient {
  id: string;
  name: string;
  sku: string;
  baseUnitId: string;
  /** Weighted average cost of one base unit, in minor units (may have decimals). */
  costPerBaseMinor: string;
  lowStockThreshold: string;
  supplierId: string | null;
  isActive: boolean;
  supplier: { id: string; name: string } | null;
  /** Stock at the selected outlet, in the base unit. */
  quantity: string;
}

export interface StockRow {
  ingredientId: string;
  name: string;
  sku: string;
  /** Code of the base unit. */
  unit: string;
  quantity: string;
  lowStockThreshold: string;
  isLow: boolean;
  valueMinor: number;
  costPerBaseMinor: string;
}

export const MOVEMENT_TYPES = ['RECEIPT', 'SALE', 'SALE_REVERSAL', 'WASTAGE', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'COUNT_CORRECTION'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface Movement {
  id: string;
  ingredientId: string;
  ingredientName: string;
  type: MovementType;
  quantityDelta: string;
  balanceAfter: string;
  unitCostMinor: string;
  refType: string;
  refId: string;
  orderId: string | null;
  reason: string;
  createdAt: string;
}

export interface StockCountLine {
  id: string;
  ingredientId: string;
  countedQty: string;
  theoreticalQty: string | null;
  varianceQty: string | null;
}

export interface StockCount {
  id: string;
  status: 'DRAFT' | 'POSTED';
  note: string;
  createdAt: string;
  postedAt: string | null;
  _count?: { lines: number };
  lines?: StockCountLine[];
}

export interface RecipeLine {
  id: string;
  ingredientId: string;
  ingredientName: string;
  quantity: string;
  unitId: string;
  baseQuantity: string;
  costMinor: number;
}

export interface Recipe {
  id: string;
  productId: string;
  variantId: string | null;
  version: number;
  isActive: boolean;
  note: string;
  createdAt: string;
  product: { name: string; sku: string };
  variant: { name: string; priceMinor: number } | null;
  ingredients: RecipeLine[];
  costMinor: number;
}

export interface Supplier {
  id: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  gstin: string;
  address: string;
  isActive: boolean;
}

export type PurchaseOrderStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';

export interface PurchaseOrderItem {
  id: string;
  ingredientId: string;
  unitId: string;
  quantity: string;
  unitCostMinor: number;
  receivedQuantity: string;
}

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  note: string;
  expectedOn: string | null;
  createdAt: string;
  supplier: { id: string; name: string };
  items: PurchaseOrderItem[];
  receipts: Array<{ id: string; grnNumber: string; receivedAt: string }>;
}

export interface GoodsReceipt {
  id: string;
  purchaseOrderId: string | null;
  supplierId: string | null;
  grnNumber: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  invoiceTotalMinor: number | null;
  note: string;
  receivedAt: string;
  purchaseOrder: { poNumber: string } | null;
  items: Array<{ id: string; purchaseOrderItemId: string | null; ingredientId: string; unitId: string; quantity: string; baseQuantity: string; unitCostMinor: number }>;
}
