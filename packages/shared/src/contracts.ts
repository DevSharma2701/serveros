/**
 * Request contracts for the ServeOS API. The API validates every request body and query
 * against these schemas (unknown fields are stripped, which blocks mass assignment), and
 * the clients reuse them for form validation.
 */
import { z } from 'zod';
import { ALL_PERMISSIONS, type PermissionKey } from './access';
import { ORDER_STATUSES, ORDER_TYPES, PAYMENT_METHODS } from './orders';

const id = z.uuid();
const money = z.number().int().min(0).max(1_000_000_000);
const bps = z.number().int().min(0).max(10_000);
const text = (max = 200) => z.string().trim().max(max);
const name = text(120).min(1);
const reason = z.string().trim().min(3, 'Give a reason of at least 3 characters').max(300);
const qtyString = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,4})?$/, 'Enter a quantity with up to 4 decimals');
const positiveQty = qtyString.refine((v) => Number(v) > 0, 'Quantity must be more than zero');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// ── Auth ──
export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(128);
export const loginSchema = z.object({
  email: z.email().max(200).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(128),
  client: z.enum(['web', 'mobile']).default('web'),
});
export const refreshSchema = z.object({ refreshToken: z.string().max(500).optional() });
export const forgotPasswordSchema = z.object({ email: z.email().max(200).transform((v) => v.toLowerCase()) });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });

// ── Restaurant & outlets ──
export const updateRestaurantSchema = z
  .object({
    name,
    legalName: name,
    gstin: text(20).nullable(),
    addressLine1: text(),
    city: text(80),
    stateCode: text(4),
    postalCode: text(12),
    pricesIncludeTax: z.boolean(),
    serviceChargeBps: bps,
    serviceChargeTaxCategoryId: id.nullable(),
    deliveryChargeTaxCategoryId: id.nullable(),
    roundOffMode: z.enum(['NONE', 'NEAREST_UNIT']),
    receiptFooter: text(500),
    invoicePrefix: z.string().trim().regex(/^[A-Z0-9]{1,8}$/, 'Use 1-8 capital letters or digits'),
    discountApprovalThresholdBps: bps,
    cashVarianceApprovalThresholdMinor: money,
    allowPartialPayment: z.boolean(),
    inventoryPolicy: z.enum(['NONE', 'ON_CONFIRM', 'ON_COMPLETE']),
    allowNegativeStock: z.boolean(),
    loyaltyEnabled: z.boolean(),
    loyaltyEarnPointsPer100: z.number().int().min(0).max(1000),
    loyaltyPointValueMinor: z.number().int().min(1).max(100_000),
    loyaltyMinRedeemPoints: z.number().int().min(0).max(1_000_000),
  })
  .partial();

export const outletSchema = z.object({
  name,
  code: z.string().trim().regex(/^[A-Z0-9]{2,8}$/, 'Use 2-8 capital letters or digits'),
  addressLine1: text().default(''),
  city: text(80).default(''),
  stateCode: text(4).default(''),
  postalCode: text(12).default(''),
  phone: text(20).default(''),
  gstin: text(20).nullable().default(null),
  fssaiNumber: text(20).nullable().default(null),
  timezone: text(60).default('Asia/Kolkata'),
  serviceChargeEnabled: z.boolean().default(false),
  deliveryChargeMinor: money.default(0),
  isActive: z.boolean().default(true),
});
export const updateOutletSchema = outletSchema.partial();

export const createRestaurantSchema = z.object({
  name,
  legalName: name,
  ownerName: name,
  ownerEmail: z.email().transform((v) => v.toLowerCase()),
  outlet: outletSchema,
});

// ── Staff ──
const permissionKey = z.enum(ALL_PERMISSIONS as [PermissionKey, ...PermissionKey[]]);
export const inviteStaffSchema = z.object({
  name,
  email: z.email().max(200).transform((v) => v.toLowerCase()),
  phone: text(20).default(''),
  employeeCode: text(30).default(''),
  jobTitle: text(60).default(''),
  roleId: id,
  allOutlets: z.boolean().default(false),
  outletIds: z.array(id).max(200).default([]),
});
export const updateStaffSchema = z
  .object({
    name,
    phone: text(20),
    employeeCode: text(30),
    jobTitle: text(60),
    roleId: id,
    allOutlets: z.boolean(),
    outletIds: z.array(id).max(200),
    status: z.enum(['ACTIVE', 'DISABLED']),
  })
  .partial();
export const grantPermissionSchema = z.object({ permissionKey, outletId: id.nullable().default(null) });
export const scheduleSchema = z.object({ userId: id, startsAt: z.iso.datetime(), endsAt: z.iso.datetime(), note: text().default('') });

// ── Menu ──
export const categorySchema = z.object({
  name,
  parentId: id.nullable().default(null),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});
export const variantSchema = z.object({
  id: id.optional(),
  name,
  priceMinor: money,
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export const productSchema = z.object({
  name,
  sku: z.string().trim().min(1).max(40),
  categoryId: id,
  taxCategoryId: id.nullable().default(null),
  description: text(1000).default(''),
  imageUrl: z.string().max(500).nullable().default(null),
  isVeg: z.boolean().nullable().default(null),
  isActive: z.boolean().default(true),
  isFavorite: z.boolean().default(false),
  stationKey: z.string().trim().max(30).nullable().default(null),
  variants: z.array(variantSchema).min(1, 'Add at least one variant').max(20),
  modifierGroupIds: z.array(id).max(20).default([]),
});
export const updateProductSchema = productSchema.partial();
export const productAvailabilitySchema = z.object({
  isAvailable: z.boolean(),
  variantPrices: z.array(z.object({ variantId: id, priceMinor: money.nullable() })).max(20).optional(),
});
export const modifierGroupSchema = z
  .object({
    name,
    minSelect: z.number().int().min(0).max(20).default(0),
    maxSelect: z.number().int().min(1).max(20).default(1),
    isActive: z.boolean().default(true),
    options: z
      .array(z.object({ id: id.optional(), name, priceMinor: money.default(0), isActive: z.boolean().default(true) }))
      .min(1)
      .max(50),
  })
  .refine((g) => g.minSelect <= g.maxSelect, { message: 'Minimum cannot exceed maximum', path: ['minSelect'] });
export const taxCategorySchema = z.object({
  name,
  hsnSac: text(12).default(''),
  isActive: z.boolean().default(true),
  rules: z
    .array(
      z.object({
        component: z.enum(['CGST', 'SGST', 'IGST', 'CESS', 'VAT', 'OTHER']),
        name,
        rateBps: bps,
        scope: z.enum(['ANY', 'INTRA_STATE', 'INTER_STATE']).default('ANY'),
      }),
    )
    .max(10),
});
export const discountSchema = z.object({
  name,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/).nullable().default(null),
  type: z.enum(['PERCENT', 'FLAT']),
  value: z.number().int().min(1).max(1_000_000_000),
  maxDiscountMinor: money.nullable().default(null),
  minOrderMinor: money.default(0),
  usageLimit: z.number().int().min(1).nullable().default(null),
  validFrom: z.iso.datetime().nullable().default(null),
  validTo: z.iso.datetime().nullable().default(null),
  isActive: z.boolean().default(true),
});
export const productQuery = pageQuery.extend({ q: text(80).optional(), categoryId: id.optional(), active: bool.optional() });

// ── Floor ──
export const diningAreaSchema = z.object({ name, sortOrder: z.number().int().min(0).default(0), isActive: z.boolean().default(true) });
export const tableSchema = z.object({
  name: text(20).min(1),
  areaId: id,
  capacity: z.number().int().min(1).max(100).default(4),
  posX: z.number().int().min(0).max(5000).default(0),
  posY: z.number().int().min(0).max(5000).default(0),
  shape: z.enum(['square', 'round', 'rect']).default('square'),
  assignedWaiterId: id.nullable().default(null),
  isActive: z.boolean().default(true),
});
export const reservationSchema = z.object({
  tableId: id,
  guestName: name,
  guestPhone: text(20).default(''),
  partySize: z.number().int().min(1).max(100).default(2),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  note: text().default(''),
});
export const reservationStatusSchema = z.object({ status: z.enum(['BOOKED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']) });

// ── Orders ──
export const discountInputSchema = z
  .object({ type: z.enum(['PERCENT', 'FLAT']), value: z.number().int().min(1), reason })
  .refine((d) => d.type === 'FLAT' || d.value <= 10_000, { message: 'Percentage cannot exceed 100%', path: ['value'] });

export const orderItemInputSchema = z.object({
  clientLineId: z.string().min(1).max(60),
  productId: id,
  variantId: id,
  quantity: z.number().int().min(1).max(999),
  modifierOptionIds: z.array(id).max(40).default([]),
  notes: text(200).default(''),
  discount: discountInputSchema.nullable().default(null),
});

export const cartSchema = z.object({
  type: z.enum(ORDER_TYPES),
  tableId: id.nullable().default(null),
  customerId: id.nullable().default(null),
  guestCount: z.number().int().min(1).max(200).default(1),
  notes: text(300).default(''),
  deliveryName: text(120).default(''),
  deliveryPhone: text(20).default(''),
  deliveryAddress: text(400).default(''),
  /** GST state code of the place of supply when it differs from the outlet (inter-state). */
  placeOfSupplyStateCode: text(4).nullable().default(null),
  items: z.array(orderItemInputSchema).max(200),
  orderDiscount: discountInputSchema.nullable().default(null),
  couponCode: z.string().trim().toUpperCase().max(20).nullable().default(null),
});

export const createOrderSchema = cartSchema.extend({
  /** DRAFT saves it, HOLD parks it for later, PLACE confirms it and sends it to the kitchen. */
  action: z.enum(['DRAFT', 'HOLD', 'PLACE']).default('PLACE'),
  source: z.enum(['POS', 'POS_OFFLINE']).default('POS'),
  clientCreatedAt: z.iso.datetime().optional(),
  /** Total the operator saw. Sent by offline sync so the server can flag price conflicts. */
  expectedTotalMinor: money.optional(),
});
export const updateCartSchema = cartSchema;
export const addItemsSchema = z.object({ items: z.array(orderItemInputSchema).min(1).max(100) });
export const reasonSchema = z.object({ reason });
export const setDiscountSchema = z.object({
  orderDiscount: discountInputSchema.nullable().default(null),
  couponCode: z.string().trim().toUpperCase().max(20).nullable().default(null),
});
export const transferTableSchema = z.object({ tableId: id });
export const mergeOrderSchema = z.object({ sourceOrderId: id });
export const attachTableSchema = z.object({ tableId: id });
export const splitOrderSchema = z.object({
  items: z.array(z.object({ itemId: id, quantity: z.number().int().min(1).max(999) })).min(1).max(100),
});
export const assignWaiterSchema = z.object({ waiterId: id.nullable() });
export const orderQuery = pageQuery.extend({
  status: z.string().max(200).optional(), // comma separated OrderStatus values
  type: z.enum(ORDER_TYPES).optional(),
  q: text(60).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  held: bool.optional(),
  customerId: id.optional(),
});
export const orderStatusList = z.array(z.enum(ORDER_STATUSES));

// ── Payments ──
export const recordPaymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountMinor: money.min(1),
  /** Cash handed over; change is calculated by the server. */
  tenderedMinor: money.optional(),
  /** MANUAL: cashier confirms a payment taken on an external device. GATEWAY: start a provider payment. */
  mode: z.enum(['MANUAL', 'GATEWAY']).default('MANUAL'),
  reference: text(80).default(''),
});
export const refundSchema = z.object({ amountMinor: money.min(1), reason });
export const devSimulateSchema = z.object({ outcome: z.enum(['success', 'failure']) });

// ── Kitchen ──
export const ticketStatusSchema = z.object({ status: z.enum(['PENDING', 'PREPARING', 'READY']) });
export const ticketItemSchema = z.object({ isPrepared: z.boolean() });
export const ticketQuery = z.object({ stationId: id.optional(), scope: z.enum(['active', 'recent']).default('active') });
export const stationSchema = z.object({
  key: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/),
  name,
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

// ── Cash ──
export const registerSchema = z.object({ name, isActive: z.boolean().default(true) });
export const openShiftSchema = z.object({ registerId: id, openingFloatMinor: money });
export const cashMovementSchema = z.object({ type: z.enum(['CASH_IN', 'CASH_OUT', 'PETTY_CASH']), amountMinor: money.min(1), reason });
export const closeShiftSchema = z.object({ countedCashMinor: money, note: text(300).default('') });

// ── Inventory ──
export const ingredientSchema = z.object({
  name,
  sku: z.string().trim().min(1).max(40),
  baseUnitId: id,
  lowStockThreshold: qtyString.default('0'),
  supplierId: id.nullable().default(null),
  isActive: z.boolean().default(true),
});
export const updateIngredientSchema = ingredientSchema.omit({ baseUnitId: true }).partial();
export const stockAdjustmentSchema = z.object({
  ingredientId: id,
  type: z.enum(['WASTAGE', 'ADJUSTMENT']),
  /** ADJUSTMENT may add or remove stock; WASTAGE always removes. */
  direction: z.enum(['IN', 'OUT']).default('OUT'),
  quantity: positiveQty,
  unitId: id,
  reason,
});
const stockLine = z.object({ ingredientId: id, quantity: positiveQty, unitId: id });
export const stockTransferSchema = z.object({ toOutletId: id, note: text().default(''), lines: z.array(stockLine).min(1).max(200) });
export const stockCountSchema = z.object({
  note: text().default(''),
  lines: z.array(z.object({ ingredientId: id, countedQty: qtyString, unitId: id })).min(1).max(500),
});
export const recipeSchema = z.object({
  productId: id,
  variantId: id.nullable().default(null),
  note: text().default(''),
  ingredients: z.array(stockLine).min(1).max(60),
});
export const supplierSchema = z.object({
  name,
  contactName: text(120).default(''),
  phone: text(20).default(''),
  email: z.union([z.email(), z.literal('')]).default(''),
  gstin: text(20).default(''),
  address: text(400).default(''),
  isActive: z.boolean().default(true),
});
const purchaseLine = stockLine.extend({ unitCostMinor: money });
export const purchaseOrderSchema = z.object({
  supplierId: id,
  note: text().default(''),
  expectedOn: z.iso.datetime().nullable().default(null),
  items: z.array(purchaseLine).min(1).max(200),
});
export const goodsReceiptSchema = z.object({
  purchaseOrderId: id.nullable().default(null),
  supplierId: id.nullable().default(null),
  invoiceNumber: text(60).default(''),
  invoiceDate: z.iso.datetime().nullable().default(null),
  invoiceTotalMinor: money.nullable().default(null),
  note: text().default(''),
  items: z.array(purchaseLine.extend({ purchaseOrderItemId: id.nullable().default(null) })).min(1).max(200),
});
export const movementQuery = pageQuery.extend({ ingredientId: id.optional(), type: text(30).optional() });

// ── Customers ──
export const customerSchema = z.object({
  name,
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/[^\d+]/g, ''))
    .refine((v) => v === '' || /^\+?\d{7,15}$/.test(v), 'Enter a valid phone number')
    .default(''),
  email: z.union([z.email(), z.literal('')]).default(''),
  gstin: text(20).default(''),
  stateCode: text(4).default(''),
  notes: text(1000).optional(),
  marketingSms: z.boolean().default(false),
  marketingEmail: z.boolean().default(false),
  marketingWhatsapp: z.boolean().default(false),
});
export const updateCustomerSchema = customerSchema.partial();
export const customerQuery = pageQuery.extend({ q: text(60).optional() });
export const loyaltyAdjustSchema = z.object({ points: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0), reason });

// ── Reports ──
export const reportQuery = z.object({
  from: isoDate,
  to: isoDate,
  /** Comma separated outlet ids; defaults to every outlet the user may access. */
  outletIds: z.string().max(4000).optional(),
});
export const exportQuery = reportQuery.extend({ dataset: z.enum(['orders', 'items', 'payments']) });
export const auditQuery = pageQuery.extend({ action: text(60).optional(), entityType: text(60).optional() });

export type LoginInput = z.infer<typeof loginSchema>;
export type CartInput = z.input<typeof cartSchema>;
export type CreateOrderInput = z.input<typeof createOrderSchema>;
export type OrderItemInput = z.input<typeof orderItemInputSchema>;
export type RecordPaymentInput = z.input<typeof recordPaymentSchema>;
export type ProductInput = z.input<typeof productSchema>;
