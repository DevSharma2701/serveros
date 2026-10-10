import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, type OrderStatus } from '@prisma/client';
import {
  ACTIVE_ORDER_STATUSES,
  addItemsSchema,
  assignWaiterSchema,
  attachTableSchema,
  cartSchema,
  createOrderSchema,
  KITCHEN_ORDER_STATUSES,
  mergeOrderSchema,
  ORDER_TRANSITIONS,
  orderQuery,
  orderStatusList,
  priceOrder,
  REALTIME_EVENTS,
  reasonSchema,
  setDiscountSchema,
  splitOrderSchema,
  transferTableSchema,
  type DiscountInput,
  type GuestOrderInput,
  type PermissionKey,
  type PricingResult,
  type PricingTaxRule,
} from '@serveos/shared';
import { createZodDto } from 'nestjs-zod';
import { assertCan, can, Ctx, OutletScoped, RequirePermissions, type OutletContext } from '../common/context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { RealtimeGateway } from '../common/realtime.gateway';
import { AuditService, SequenceService } from '../common/services';
import { businessDay, localDayRange, paged, paginate } from '../common/util';
import { BillingModule, BillingService, derivePaymentStatus } from './billing.module';
import { CustomersModule, CustomersService } from './customers.module';
import { InventoryModule, InventoryService } from './inventory.module';
import { KitchenModule, KitchenService } from './kitchen.module';

class CartDto extends createZodDto(cartSchema) {}
class CreateOrderDto extends createZodDto(createOrderSchema) {}
class AddItemsDto extends createZodDto(addItemsSchema) {}
class ReasonDto extends createZodDto(reasonSchema) {}
class SetDiscountDto extends createZodDto(setDiscountSchema) {}
class TransferTableDto extends createZodDto(transferTableSchema) {}
class AttachTableDto extends createZodDto(attachTableSchema) {}
class MergeOrderDto extends createZodDto(mergeOrderSchema) {}
class SplitOrderDto extends createZodDto(splitOrderSchema) {}
class AssignWaiterDto extends createZodDto(assignWaiterSchema) {}
class OrderQueryDto extends createZodDto(orderQuery) {}

type ItemInput = CartDto['items'][number];
type Db = Tx | PrismaService;

const orderInclude = {
  items: { orderBy: { createdAt: 'asc' }, include: { modifiers: true } },
  taxLines: true,
  events: { orderBy: { createdAt: 'asc' } },
  tables: { where: { isActive: true }, include: { table: { select: { id: true, name: true } } } },
  payments: { orderBy: { createdAt: 'asc' } },
  refunds: { orderBy: { createdAt: 'asc' } },
  invoice: { select: { id: true, invoiceNumber: true, issuedAt: true } },
  customer: { select: { id: true, name: true, loyaltyPoints: true } },
} satisfies Prisma.OrderInclude;

interface ChargeTaxRules {
  service: PricingTaxRule[];
  delivery: PricingTaxRule[];
}

interface ResolvedLine {
  input: ItemInput;
  productName: string;
  variantName: string;
  sku: string;
  categoryName: string;
  taxCategoryName: string;
  hsnSac: string;
  stationKey: string | null;
  unitPriceMinor: number;
  modifiersMinor: number;
  modifiers: Array<{ modifierOptionId: string; groupName: string; optionName: string; priceMinor: number }>;
  taxRules: PricingTaxRule[];
}

interface OrderRules {
  pricesIncludeTax: boolean;
  roundOffMode: 'NONE' | 'NEAREST_UNIT';
  serviceChargeBps: number;
  deliveryChargeMinor: number;
  chargeTaxRules: ChargeTaxRules;
  interState: boolean;
}

const isUniqueViolation = (e: unknown): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
/** How long a guest has to pay before an unpaid QR order is cancelled. */
export const GUEST_PAYMENT_WINDOW_MS = 15 * 60_000;
const GUEST_ACTOR = 'Guest (QR)';

/**
 * A context for work done on behalf of a guest or the system rather than a signed-in user.
 * It carries no permissions, and its user id is null (stored as "no staff member").
 */
function guestContext(restaurantId: string, outletId: string): OutletContext {
  return {
    userId: null as unknown as string, userName: GUEST_ACTOR, sessionId: '', restaurantId, isPlatformAdmin: false, roleKey: 'GUEST', roleRank: 0,
    permissions: new Set(), outletPermissions: new Map(), outletIds: [outletId], allOutlets: false, outletId, ip: '', correlationId: '',
  };
}

const pct = (bps: number): string => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
    private readonly realtime: RealtimeGateway,
    private readonly kitchen: KitchenService,
    private readonly inventory: InventoryService,
    private readonly customers: CustomersService,
    private readonly billing: BillingService,
  ) {}

  // ───────────── Helpers ─────────────

  private notify(outletId: string, orderId: string, also: Array<'ticket' | 'floor'> = []): void {
    this.realtime.emit(outletId, REALTIME_EVENTS.orderChanged, { orderId });
    if (also.includes('ticket')) this.realtime.emit(outletId, REALTIME_EVENTS.ticketChanged, { orderId });
    if (also.includes('floor')) this.realtime.emit(outletId, REALTIME_EVENTS.floorChanged, { orderId });
  }

  private event(tx: Tx, ctx: OutletContext, orderId: string, type: string, message: string, extra: { from?: OrderStatus; to?: OrderStatus; data?: Prisma.InputJsonObject } = {}) {
    return tx.orderEvent.create({
      data: { orderId, type, message, fromStatus: extra.from, toStatus: extra.to, data: extra.data ?? {}, actorId: ctx.userId, actorName: ctx.userName },
    });
  }

  /** Loads an order only if it belongs to the caller's restaurant and selected outlet. */
  private async find(db: Db, ctx: OutletContext, id: string) {
    const order = await db.order.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId }, include: { items: { include: { modifiers: true } } } });
    if (!order) throw notFound('Order');
    return order;
  }

  /** Row-locks the order so concurrent changes to the same bill are applied one after another. */
  private async lock(tx: Tx, ctx: OutletContext, id: string) {
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${id}::uuid AND "restaurantId" = ${ctx.restaurantId}::uuid FOR UPDATE`;
    return this.find(tx, ctx, id);
  }

  private assertTransition(ctx: OutletContext, from: OrderStatus, to: OrderStatus): void {
    const rules = ORDER_TRANSITIONS[from] as Partial<Record<OrderStatus, PermissionKey | null>>;
    if (!(to in rules)) throw conflict('INVALID_TRANSITION', `An order that is ${from.toLowerCase()} cannot become ${to.toLowerCase()}`);
    const permission = rules[to];
    if (permission) assertCan(ctx, permission);
  }

  detail(ctx: OutletContext, id: string, db: Db = this.prisma) {
    return db.order
      .findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId }, include: orderInclude })
      .then((order) => {
        if (!order) throw notFound('Order');
        const dueMinor = Math.max(0, order.totalMinor - (order.paidMinor - order.refundedMinor));
        return { ...order, dueMinor };
      });
  }

  // ───────────── Pricing ─────────────

  private async rulesFor(db: Db, ctx: OutletContext, type: CartDto['type'], placeOfSupplyStateCode: string | null): Promise<OrderRules & { timezone: string; currency: string }> {
    const [restaurant, outlet] = await Promise.all([
      db.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } }),
      db.outlet.findUniqueOrThrow({ where: { id: ctx.outletId } }),
    ]);
    const interState = !!placeOfSupplyStateCode && !!outlet.stateCode && placeOfSupplyStateCode !== outlet.stateCode;
    const chargeCategoryIds = [restaurant.serviceChargeTaxCategoryId, restaurant.deliveryChargeTaxCategoryId].filter(Boolean) as string[];
    const categories = await db.taxCategory.findMany({ where: { id: { in: chargeCategoryIds }, restaurantId: ctx.restaurantId }, include: { rules: true } });
    const rulesOf = (id: string | null) => this.applicableRules(categories.find((c) => c.id === id)?.rules ?? [], interState);
    return {
      pricesIncludeTax: restaurant.pricesIncludeTax,
      roundOffMode: restaurant.roundOffMode,
      // Service charge applies to dine-in only; delivery charge to delivery only.
      serviceChargeBps: type === 'DINE_IN' && outlet.serviceChargeEnabled ? restaurant.serviceChargeBps : 0,
      deliveryChargeMinor: type === 'DELIVERY' ? outlet.deliveryChargeMinor : 0,
      chargeTaxRules: { service: rulesOf(restaurant.serviceChargeTaxCategoryId), delivery: rulesOf(restaurant.deliveryChargeTaxCategoryId) },
      interState,
      timezone: outlet.timezone,
      currency: restaurant.currency,
    };
  }

  private applicableRules(rules: Array<{ component: string; name: string; rateBps: number; scope: string; isActive: boolean }>, interState: boolean): PricingTaxRule[] {
    return rules
      .filter((r) => r.isActive && (r.scope === 'ANY' || r.scope === (interState ? 'INTER_STATE' : 'INTRA_STATE')))
      .map((r) => ({ component: r.component, name: r.name, rateBps: r.rateBps }));
  }

  /**
   * Turns client line items into priced lines using only server data: the price comes from
   * the menu (with any outlet override), modifiers are checked against the product's groups,
   * and the tax rules come from the product's tax category. Nothing monetary is taken from the client.
   */
  private async resolveLines(db: Db, ctx: OutletContext, items: ItemInput[], interState: boolean): Promise<ResolvedLine[]> {
    if (new Set(items.map((i) => i.clientLineId)).size !== items.length) throw badRequest('DUPLICATE_LINE', 'Each line needs a unique clientLineId');
    const products = await db.product.findMany({
      where: { restaurantId: ctx.restaurantId, id: { in: [...new Set(items.map((i) => i.productId))] } },
      include: {
        category: true,
        taxCategory: { include: { rules: true } },
        variants: { include: { outletPrices: { where: { outletId: ctx.outletId } } } },
        modifierGroups: { include: { group: { include: { options: true } } } },
        outletSettings: { where: { outletId: ctx.outletId } },
      },
    });
    return items.map((input) => {
      const product = products.find((p) => p.id === input.productId);
      if (!product) throw notFound('Product');
      const unavailable = (why: string) => conflict('ITEM_UNAVAILABLE', `${product.name} ${why}`, { productId: product.id, name: product.name });
      if (!product.isActive || !product.category.isActive) throw unavailable('is no longer on the menu');
      if (product.outletSettings[0]?.isAvailable === false) throw unavailable('is marked unavailable');
      const variant = product.variants.find((v) => v.id === input.variantId);
      if (!variant || !variant.isActive) throw unavailable('is not sold in this size any more');

      const groups = product.modifierGroups.map((g) => g.group).filter((g) => g.isActive);
      const chosen = new Set(input.modifierOptionIds);
      if (chosen.size !== input.modifierOptionIds.length) throw badRequest('INVALID_MODIFIERS', `${product.name}: the same add-on was selected twice`);
      const modifiers: ResolvedLine['modifiers'] = [];
      for (const group of groups) {
        const picked = group.options.filter((o) => o.isActive && chosen.has(o.id));
        if (picked.length < group.minSelect) throw badRequest('INVALID_MODIFIERS', `${product.name}: choose at least ${group.minSelect} from "${group.name}"`);
        if (picked.length > group.maxSelect) throw badRequest('INVALID_MODIFIERS', `${product.name}: choose at most ${group.maxSelect} from "${group.name}"`);
        for (const o of picked) {
          modifiers.push({ modifierOptionId: o.id, groupName: group.name, optionName: o.name, priceMinor: o.priceMinor });
          chosen.delete(o.id);
        }
      }
      if (chosen.size > 0) throw badRequest('INVALID_MODIFIERS', `${product.name}: one of the selected add-ons is not available for this item`);

      return {
        input,
        productName: product.name,
        variantName: variant.name,
        sku: product.sku,
        categoryName: product.category.name,
        taxCategoryName: product.taxCategory?.name ?? '',
        hsnSac: product.taxCategory?.hsnSac ?? '',
        stationKey: product.stationKey,
        unitPriceMinor: variant.outletPrices[0]?.priceMinor ?? variant.priceMinor,
        modifiersMinor: modifiers.reduce((a, m) => a + m.priceMinor, 0),
        modifiers,
        taxRules: this.applicableRules(product.taxCategory?.isActive ? product.taxCategory.rules : [], interState),
      };
    });
  }

  private compute(lines: Array<{ key: string; unitPriceMinor: number; modifiersMinor: number; quantity: number; discount: DiscountInput | null; taxRules: PricingTaxRule[] }>, rules: OrderRules, orderDiscount: DiscountInput | null): PricingResult {
    return priceOrder({
      lines,
      pricesIncludeTax: rules.pricesIncludeTax,
      orderDiscount,
      serviceChargeBps: rules.serviceChargeBps,
      serviceChargeTaxRules: rules.chargeTaxRules.service,
      deliveryChargeMinor: rules.deliveryChargeMinor,
      deliveryChargeTaxRules: rules.chargeTaxRules.delivery,
      roundOffMode: rules.roundOffMode,
    });
  }

  /** Validates a coupon code and returns the discount it gives. Usage is claimed later, when the order is placed. */
  private async coupon(db: Db, ctx: OutletContext, code: string, baseMinor: number) {
    const discount = await db.discount.findFirst({ where: { restaurantId: ctx.restaurantId, code, isActive: true } });
    const now = new Date();
    if (!discount || (discount.validFrom && discount.validFrom > now) || (discount.validTo && discount.validTo < now)) {
      throw badRequest('INVALID_COUPON', 'This coupon code is not valid');
    }
    if (discount.usageLimit != null && discount.usedCount >= discount.usageLimit) throw badRequest('INVALID_COUPON', 'This coupon has been fully used');
    if (baseMinor < discount.minOrderMinor) throw badRequest('COUPON_MIN_ORDER', 'The order is below the minimum value for this coupon');
    return discount;
  }

  /**
   * Manual discounts need `discount.apply`; anything above the restaurant's threshold also
   * needs `discount.approve_high`. Checked against the amounts the server computed.
   */
  private async authorizeDiscounts(db: Db, ctx: OutletContext, pricing: PricingResult, manualOrderDiscount: boolean): Promise<void> {
    const itemDiscounted = pricing.lines.filter((l) => l.discountMinor > 0);
    const orderDiscounted = manualOrderDiscount && pricing.orderDiscountMinor > 0;
    if (itemDiscounted.length === 0 && !orderDiscounted) return;
    assertCan(ctx, 'discount.apply', 'You are not allowed to give discounts');
    const { discountApprovalThresholdBps: threshold } = await db.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId }, select: { discountApprovalThresholdBps: true } });
    const shares = itemDiscounted.map((l) => (l.discountMinor * 10_000) / l.lineSubtotalMinor);
    if (orderDiscounted) shares.push((pricing.orderDiscountMinor * 10_000) / Math.max(1, pricing.subtotalMinor - pricing.itemDiscountMinor));
    if (Math.max(...shares) > threshold && !can(ctx, 'discount.approve_high')) {
      throw forbidden(`Discounts above ${pct(threshold)} need a manager`);
    }
  }

  /** Prices a cart from scratch. Used for quotes, new orders and draft edits. */
  private async priceCart(db: Db, ctx: OutletContext, cart: CartDto) {
    const rules = await this.rulesFor(db, ctx, cart.type, cart.placeOfSupplyStateCode);
    const resolved = await this.resolveLines(db, ctx, cart.items, rules.interState);
    const lines = resolved.map((l) => ({
      key: l.input.clientLineId,
      unitPriceMinor: l.unitPriceMinor,
      modifiersMinor: l.modifiersMinor,
      quantity: l.input.quantity,
      discount: l.input.discount ? { type: l.input.discount.type, value: l.input.discount.value } : null,
      taxRules: l.taxRules,
    }));
    if (cart.couponCode && cart.orderDiscount) throw badRequest('DISCOUNT_CONFLICT', 'Use either a coupon or a manual discount, not both');
    let orderDiscount: DiscountInput | null = cart.orderDiscount ? { type: cart.orderDiscount.type, value: cart.orderDiscount.value } : null;
    let couponRow: Awaited<ReturnType<OrdersService['coupon']>> | null = null;
    if (cart.couponCode) {
      const base = this.compute(lines, rules, null);
      couponRow = await this.coupon(db, ctx, cart.couponCode, base.subtotalMinor - base.itemDiscountMinor);
      orderDiscount = { type: couponRow.type, value: couponRow.value, maxDiscountMinor: couponRow.maxDiscountMinor };
    }
    const pricing = this.compute(lines, rules, orderDiscount);
    await this.authorizeDiscounts(db, ctx, pricing, !!cart.orderDiscount);
    return { rules, resolved, pricing, orderDiscount, couponRow };
  }

  private itemRows(ctx: OutletContext, resolved: ResolvedLine[], pricing: PricingResult) {
    return resolved.map((l) => {
      const priced = pricing.lines.find((p) => p.key === l.input.clientLineId)!;
      return {
        clientLineId: l.input.clientLineId,
        productId: l.input.productId,
        variantId: l.input.variantId,
        productName: l.productName,
        variantName: l.variantName,
        sku: l.sku,
        categoryName: l.categoryName,
        taxCategoryName: l.taxCategoryName,
        hsnSac: l.hsnSac,
        stationKey: l.stationKey,
        quantity: l.input.quantity,
        unitPriceMinor: l.unitPriceMinor,
        modifiersMinor: l.modifiersMinor,
        discountType: l.input.discount?.type ?? null,
        discountValue: l.input.discount?.value ?? 0,
        discountReason: l.input.discount?.reason ?? '',
        notes: l.input.notes,
        lineSubtotalMinor: priced.lineSubtotalMinor,
        discountMinor: priced.discountMinor,
        orderDiscountShareMinor: priced.orderDiscountShareMinor,
        taxableMinor: priced.taxableMinor,
        taxMinor: priced.taxMinor,
        totalMinor: priced.totalMinor,
        taxBreakdown: priced.taxes as unknown as Prisma.InputJsonArray,
        addedById: ctx.userId,
        modifiers: { create: l.modifiers },
      };
    });
  }

  private totals(pricing: PricingResult) {
    return {
      subtotalMinor: pricing.subtotalMinor,
      itemDiscountMinor: pricing.itemDiscountMinor,
      orderDiscountMinor: pricing.orderDiscountMinor,
      serviceChargeMinor: pricing.serviceChargeMinor,
      deliveryChargeMinor: pricing.deliveryChargeMinor,
      taxableMinor: pricing.taxableMinor,
      taxMinor: pricing.taxMinor,
      roundOffMinor: pricing.roundOffMinor,
      totalMinor: pricing.totalMinor,
    };
  }

  private taxLineRows(pricing: PricingResult) {
    return pricing.taxLines.map((t) => ({ component: t.component as Prisma.OrderTaxLineCreateManyInput['component'], name: t.name, rateBps: t.rateBps, taxableMinor: t.taxableMinor, amountMinor: t.amountMinor }));
  }

  /**
   * Recalculates an existing order from the snapshots stored on its lines. Menu prices are
   * NOT re-read: items already on a bill keep the price and tax they were sold at.
   */
  private async reprice(tx: Tx, orderId: string): Promise<PricingResult> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { where: { status: 'ACTIVE' } }, discount: true } });
    const rules: OrderRules = {
      pricesIncludeTax: order.pricesIncludeTax,
      roundOffMode: order.roundOffMode,
      serviceChargeBps: order.serviceChargeBps,
      deliveryChargeMinor: order.items.length > 0 ? order.deliveryChargeMinor : 0,
      chargeTaxRules: order.chargeTaxRules as unknown as ChargeTaxRules,
      interState: order.interState,
    };
    const orderDiscount: DiscountInput | null = order.orderDiscountType
      ? { type: order.orderDiscountType, value: order.orderDiscountValue, maxDiscountMinor: order.discount?.maxDiscountMinor ?? null }
      : null;
    const pricing = this.compute(
      order.items.map((i) => ({
        key: i.id,
        unitPriceMinor: i.unitPriceMinor,
        modifiersMinor: i.modifiersMinor,
        quantity: i.quantity,
        discount: i.discountType ? { type: i.discountType, value: i.discountValue } : null,
        taxRules: (i.taxBreakdown as unknown as PricingTaxRule[]).map((t) => ({ component: t.component, name: t.name, rateBps: t.rateBps })),
      })),
      rules,
      orderDiscount,
    );
    if (order.paidMinor - order.refundedMinor > pricing.totalMinor) {
      throw conflict('OVERPAID', 'This change would make the bill smaller than what was already paid. Refund the payment first.');
    }
    for (const line of pricing.lines) {
      await tx.orderItem.update({
        where: { id: line.key },
        data: {
          lineSubtotalMinor: line.lineSubtotalMinor,
          discountMinor: line.discountMinor,
          orderDiscountShareMinor: line.orderDiscountShareMinor,
          taxableMinor: line.taxableMinor,
          taxMinor: line.taxMinor,
          totalMinor: line.totalMinor,
          taxBreakdown: line.taxes as unknown as Prisma.InputJsonArray,
        },
      });
    }
    await tx.orderTaxLine.deleteMany({ where: { orderId } });
    await tx.orderTaxLine.createMany({ data: this.taxLineRows(pricing).map((t) => ({ ...t, orderId })) });
    await tx.order.update({
      where: { id: orderId },
      data: { ...this.totals(pricing), paymentStatus: derivePaymentStatus(pricing.totalMinor, order.paidMinor, order.refundedMinor), version: { increment: 1 } },
    });
    return pricing;
  }

  // ───────────── Tables ─────────────

  private async occupy(tx: Tx, ctx: OutletContext, orderId: string, tableId: string): Promise<string> {
    const table = await tx.restaurantTable.findFirst({ where: { id: tableId, restaurantId: ctx.restaurantId, outletId: ctx.outletId, isActive: true } });
    if (!table) throw notFound('Table');
    const taken = await tx.orderTable.findFirst({ where: { tableId, isActive: true }, include: { order: { select: { orderNumber: true } } } });
    if (taken && taken.orderId !== orderId) throw conflict('TABLE_OCCUPIED', `Table ${table.name} already has an open order (${taken.order.orderNumber})`, { orderId: taken.orderId });
    if (!taken) await tx.orderTable.create({ data: { orderId, tableId } });
    return table.name;
  }

  private async refreshTableLabel(tx: Tx, orderId: string): Promise<string> {
    const rows = await tx.orderTable.findMany({ where: { orderId, isActive: true }, include: { table: { select: { name: true } } }, orderBy: { id: 'asc' } });
    const tableLabel = rows.map((r) => r.table.name).join(' + ');
    await tx.order.update({ where: { id: orderId }, data: { tableLabel } });
    await tx.kitchenTicket.updateMany({ where: { orderId }, data: { tableLabel } });
    return tableLabel;
  }

  private releaseTables(tx: Tx, orderId: string) {
    return tx.orderTable.updateMany({ where: { orderId, isActive: true }, data: { isActive: false } });
  }

  // ───────────── Create / edit ─────────────

  async quote(ctx: OutletContext, cart: CartDto) {
    const { pricing, resolved } = await this.priceCart(this.prisma, ctx, cart);
    return {
      ...pricing,
      lines: pricing.lines.map((l) => {
        const r = resolved.find((x) => x.input.clientLineId === l.key)!;
        return { ...l, productName: r.productName, variantName: r.variantName, unitPriceMinor: r.unitPriceMinor, modifiersMinor: r.modifiersMinor };
      }),
    };
  }

  private assertCartComplete(cart: CartDto, action: CreateOrderDto['action']): void {
    if (cart.type === 'DINE_IN' && !cart.tableId) throw badRequest('TABLE_REQUIRED', 'Choose a table for a dine-in order');
    if (cart.type !== 'DINE_IN' && cart.tableId) throw badRequest('TABLE_NOT_ALLOWED', 'Only dine-in orders can have a table');
    if (action !== 'PLACE') return;
    if (cart.items.length === 0) throw badRequest('EMPTY_ORDER', 'Add at least one item before placing the order');
    if (cart.type === 'DELIVERY' && (!cart.deliveryAddress || !cart.deliveryPhone)) throw badRequest('DELIVERY_DETAILS_REQUIRED', 'A delivery order needs an address and phone number');
  }

  private async assertCustomer(db: Db, ctx: OutletContext, customerId: string | null): Promise<void> {
    if (customerId && !(await db.customer.findFirst({ where: { id: customerId, restaurantId: ctx.restaurantId }, select: { id: true } }))) throw notFound('Customer');
  }

  private cartFields(cart: CartDto, priced: Awaited<ReturnType<OrdersService['priceCart']>>, ctx: OutletContext) {
    const { rules, pricing, couponRow } = priced;
    const manual = cart.orderDiscount;
    return {
      type: cart.type,
      customerId: cart.customerId,
      guestCount: cart.guestCount,
      notes: cart.notes,
      deliveryName: cart.deliveryName,
      deliveryPhone: cart.deliveryPhone,
      deliveryAddress: cart.deliveryAddress,
      pricesIncludeTax: rules.pricesIncludeTax,
      roundOffMode: rules.roundOffMode,
      chargeTaxRules: rules.chargeTaxRules as unknown as Prisma.InputJsonObject,
      interState: rules.interState,
      serviceChargeBps: rules.serviceChargeBps,
      discountId: couponRow?.id ?? null,
      discountCode: couponRow?.code ?? null,
      orderDiscountType: couponRow?.type ?? manual?.type ?? null,
      orderDiscountValue: couponRow?.value ?? manual?.value ?? 0,
      discountReason: couponRow ? `Coupon ${couponRow.code}` : (manual?.reason ?? ''),
      discountById: couponRow || manual ? ctx.userId : null,
      ...this.totals(pricing),
    };
  }

  /**
   * Creates an order. Safe to retry: a second request with the same Idempotency-Key returns
   * the order created by the first one instead of creating another.
   */
  async create(ctx: OutletContext, dto: CreateOrderDto, idempotencyKey: string | undefined) {
    if (idempotencyKey !== undefined && !/^[\w-]{8,100}$/.test(idempotencyKey)) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-100 letters, digits, "-" or "_"');
    const replay = async () => {
      if (!idempotencyKey) return null;
      const existing = await this.prisma.order.findUnique({ where: { restaurantId_idempotencyKey: { restaurantId: ctx.restaurantId, idempotencyKey } } });
      if (!existing) return null;
      if (existing.outletId !== ctx.outletId) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for another outlet');
      return { ...(await this.detail(ctx, existing.id)), replayed: true };
    };
    const earlier = await replay();
    if (earlier) return earlier;

    this.assertCartComplete(dto, dto.action);
    await this.assertCustomer(this.prisma, ctx, dto.customerId);
    if (dto.source === 'POS_OFFLINE' && dto.action !== 'PLACE') throw badRequest('INVALID_ACTION', 'Offline orders are synchronised as placed orders');

    try {
      const { order, fired } = await this.prisma.tx(async (tx) => {
        const priced = await this.priceCart(tx, ctx, dto);
        if (dto.expectedTotalMinor != null && dto.expectedTotalMinor !== priced.pricing.totalMinor) {
          // The operator quoted a different amount (prices, taxes or discounts changed since). Do not guess: ask.
          throw conflict('PRICE_CONFLICT', 'The total has changed since this order was captured', {
            expectedTotalMinor: dto.expectedTotalMinor,
            actualTotalMinor: priced.pricing.totalMinor,
          });
        }
        const day = businessDay(new Date(), priced.rules.timezone);
        const seq = await this.sequences.next(tx, ctx.outletId, 'ORDER', day);
        const created = await tx.order.create({
          data: {
            ...this.cartFields(dto, priced, ctx),
            restaurantId: ctx.restaurantId,
            outletId: ctx.outletId,
            orderNumber: `${day}-${String(seq).padStart(4, '0')}`,
            currency: priced.rules.currency,
            source: dto.source,
            isHeld: dto.action === 'HOLD',
            idempotencyKey: idempotencyKey ?? null,
            clientCreatedAt: dto.clientCreatedAt ? new Date(dto.clientCreatedAt) : null,
            createdById: ctx.userId,
            waiterId: ctx.roleKey === 'WAITER' ? ctx.userId : null,
            items: { create: this.itemRows(ctx, priced.resolved, priced.pricing) },
            taxLines: { create: this.taxLineRows(priced.pricing) },
          },
        });
        if (dto.tableId) {
          const tableLabel = await this.occupy(tx, ctx, created.id, dto.tableId);
          await tx.order.update({ where: { id: created.id }, data: { tableLabel } });
        }
        await this.event(tx, ctx, created.id, 'CREATED', dto.source === 'POS_OFFLINE' ? 'Order captured offline and synchronised' : 'Order created', { to: 'DRAFT' });
        const fired = dto.action === 'PLACE' ? await this.confirm(tx, ctx, created.id, priced.rules.timezone) : 0;
        return { order: created, fired };
      });
      this.notify(ctx.outletId, order.id, [...(fired ? (['ticket'] as const) : []), ...(dto.tableId ? (['floor'] as const) : [])]);
      return { ...(await this.detail(ctx, order.id)), replayed: false };
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Either the same request raced with itself, or two orders raced for one table.
        const raced = await replay();
        if (raced) return raced;
        if (dto.tableId) throw conflict('TABLE_OCCUPIED', 'This table was just taken by another order');
      }
      throw e;
    }
  }

  /** DRAFT -> PLACED -> CONFIRMED: claims the coupon, sends items to the kitchen and deducts stock if configured. */
  private async confirm(tx: Tx, ctx: OutletContext, orderId: string, timezone: string): Promise<number> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { where: { status: 'ACTIVE' }, include: { modifiers: true } }, restaurant: true } });
    this.assertTransition(ctx, order.status, 'PLACED');
    this.assertTransition(ctx, 'PLACED', 'CONFIRMED');
    if (order.discountId) {
      const claimed = await tx.$executeRaw`
        UPDATE "Discount" SET "usedCount" = "usedCount" + 1
        WHERE "id" = ${order.discountId}::uuid AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
      if (claimed === 0) throw conflict('INVALID_COUPON', 'This coupon has just been fully used');
    }
    await tx.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED', isHeld: false, placedAt: new Date(), version: { increment: 1 } } });
    await this.event(tx, ctx, orderId, 'STATUS_CHANGED', 'Order placed', { from: 'DRAFT', to: 'PLACED' });
    await this.event(tx, ctx, orderId, 'STATUS_CHANGED', 'Order confirmed and sent to kitchen', { from: 'PLACED', to: 'CONFIRMED' });
    const fired = await this.kitchen.fire(tx, { ...order, tableLabel: (await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { tableLabel: true } })).tableLabel }, order.items, timezone);
    if (order.restaurant.inventoryPolicy === 'ON_CONFIRM') await this.inventory.consumeForOrderLines(tx, order, order.items, ctx.userId);
    return fired;
  }

  /** Replaces the contents of a draft (or held) order, and optionally places it. */
  async updateDraft(ctx: OutletContext, id: string, dto: CreateOrderDto) {
    this.assertCartComplete(dto, dto.action);
    await this.assertCustomer(this.prisma, ctx, dto.customerId);
    const fired = await this.prisma.tx(async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (order.status !== 'DRAFT') throw conflict('NOT_A_DRAFT', 'Only draft orders can be edited this way. Add items to an open order instead.');
      const priced = await this.priceCart(tx, ctx, dto);
      // Draft lines are not financial records yet, so they are simply replaced.
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      await tx.orderTaxLine.deleteMany({ where: { orderId: id } });
      await tx.order.update({
        where: { id },
        data: {
          ...this.cartFields(dto, priced, ctx),
          isHeld: dto.action === 'HOLD',
          version: { increment: 1 },
          items: { create: this.itemRows(ctx, priced.resolved, priced.pricing) },
          taxLines: { create: this.taxLineRows(priced.pricing) },
        },
      });
      await tx.orderTable.deleteMany({ where: { orderId: id } });
      if (dto.tableId) await this.occupy(tx, ctx, id, dto.tableId);
      await this.refreshTableLabel(tx, id);
      return dto.action === 'PLACE' ? this.confirm(tx, ctx, id, priced.rules.timezone) : 0;
    });
    this.notify(ctx.outletId, id, fired ? ['ticket', 'floor'] : ['floor']);
    return this.detail(ctx, id);
  }

  /** Adds items to an order that is still open, at today's menu prices, and sends them to the kitchen. */
  async addItems(ctx: OutletContext, id: string, dto: AddItemsDto) {
    const fired = await this.prisma.tx(async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (!ACTIVE_ORDER_STATUSES.includes(order.status)) throw conflict('ORDER_CLOSED', 'Items cannot be added to a closed order');
      const known = new Set(order.items.map((i) => i.clientLineId));
      const fresh = dto.items.filter((i) => !known.has(i.clientLineId));
      if (fresh.length === 0) return 0; // a retry of a request that already succeeded
      const resolved = await this.resolveLines(tx, ctx, fresh, order.interState);
      const rules = await this.rulesFor(tx, ctx, order.type, null);
      // Price the new lines alone to fill in their columns; the whole order is repriced right after.
      const pricing = this.compute(
        resolved.map((l) => ({ key: l.input.clientLineId, unitPriceMinor: l.unitPriceMinor, modifiersMinor: l.modifiersMinor, quantity: l.input.quantity, discount: l.input.discount, taxRules: l.taxRules })),
        { ...rules, serviceChargeBps: 0, deliveryChargeMinor: 0, roundOffMode: 'NONE', pricesIncludeTax: order.pricesIncludeTax },
        null,
      );
      await this.authorizeDiscounts(tx, ctx, pricing, false);
      for (const row of this.itemRows(ctx, resolved, pricing)) await tx.orderItem.create({ data: { ...row, orderId: id } });
      await this.reprice(tx, id);
      await this.event(tx, ctx, id, 'ITEMS_ADDED', `${fresh.length} item(s) added`, { data: { items: resolved.map((l) => `${l.input.quantity} x ${l.productName}`) } });
      if (!KITCHEN_ORDER_STATUSES.includes(order.status)) return 0;

      const updated = await tx.order.findUniqueOrThrow({ where: { id }, include: { items: { where: { status: 'ACTIVE', sentToKitchenAt: null }, include: { modifiers: true } }, restaurant: true } });
      const count = await this.kitchen.fire(tx, updated, updated.items, rules.timezone);
      if (updated.restaurant.inventoryPolicy === 'ON_CONFIRM') await this.inventory.consumeForOrderLines(tx, updated, updated.items, ctx.userId);
      await this.kitchen.syncOrderStatus(tx, id, ctx);
      return count;
    });
    this.notify(ctx.outletId, id, fired ? ['ticket'] : []);
    return this.detail(ctx, id);
  }

  async voidItem(ctx: OutletContext, id: string, itemId: string, reason: string) {
    await this.prisma.tx(async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (!ACTIVE_ORDER_STATUSES.includes(order.status)) throw conflict('ORDER_CLOSED', 'Items on a closed order cannot be voided. Use a refund instead.');
      const item = order.items.find((i) => i.id === itemId);
      if (!item) throw notFound('Order item');
      if (item.status === 'VOIDED') return;
      // Removing something the kitchen has already been told to make is a controlled action.
      assertCan(ctx, item.sentToKitchenAt ? 'order.void_item' : 'order.update', 'Only a manager can void items already sent to the kitchen');
      const unstarted = await this.kitchen.unstartedItemIds(tx, [itemId]);
      await tx.orderItem.update({ where: { id: itemId }, data: { status: 'VOIDED', voidReason: reason, voidedById: ctx.userId, voidedAt: new Date() } });
      await this.kitchen.cancelItems(tx, [itemId]);
      // Stock goes back only if cooking had not started; otherwise the ingredients are gone.
      if (unstarted.has(itemId)) await this.inventory.reverseForOrderLines(tx, order, [item], ctx.userId, `Voided: ${reason}`);
      await this.reprice(tx, id);
      await this.kitchen.syncOrderStatus(tx, id, ctx);
      await this.event(tx, ctx, id, 'ITEM_VOIDED', `Voided ${item.quantity} x ${item.productName}: ${reason}`, { data: { itemId, amountMinor: item.totalMinor } });
      await this.audit.log(ctx, 'order.void_item', 'Order', id, { orderNumber: order.orderNumber, item: item.productName, quantity: item.quantity, amountMinor: item.totalMinor, reason }, tx);
    });
    this.notify(ctx.outletId, id, ['ticket']);
    return this.detail(ctx, id);
  }

  async setDiscount(ctx: OutletContext, id: string, dto: SetDiscountDto) {
    if (dto.couponCode && dto.orderDiscount) throw badRequest('DISCOUNT_CONFLICT', 'Use either a coupon or a manual discount, not both');
    await this.prisma.tx(async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (!ACTIVE_ORDER_STATUSES.includes(order.status)) throw conflict('ORDER_CLOSED', 'The discount on a closed order cannot change');
      const placed = order.status !== 'DRAFT';
      const base = order.subtotalMinor - order.itemDiscountMinor;
      const coupon = dto.couponCode ? await this.coupon(tx, ctx, dto.couponCode, base) : null;
      if (placed && order.discountId && order.discountId !== coupon?.id) {
        await tx.discount.updateMany({ where: { id: order.discountId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
      }
      if (placed && coupon && coupon.id !== order.discountId) {
        const claimed = await tx.$executeRaw`
          UPDATE "Discount" SET "usedCount" = "usedCount" + 1
          WHERE "id" = ${coupon.id}::uuid AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
        if (claimed === 0) throw conflict('INVALID_COUPON', 'This coupon has just been fully used');
      }
      const manual = dto.orderDiscount;
      await tx.order.update({
        where: { id },
        data: {
          discountId: coupon?.id ?? null,
          discountCode: coupon?.code ?? null,
          orderDiscountType: coupon?.type ?? manual?.type ?? null,
          orderDiscountValue: coupon?.value ?? manual?.value ?? 0,
          discountReason: coupon ? `Coupon ${coupon.code}` : (manual?.reason ?? ''),
          discountById: coupon || manual ? ctx.userId : null,
        },
      });
      const pricing = await this.reprice(tx, id);
      await this.authorizeDiscounts(tx, ctx, { ...pricing, lines: [] }, !!manual);
      await this.event(tx, ctx, id, 'DISCOUNT', coupon ? `Coupon ${coupon.code} applied` : manual ? `Discount applied: ${manual.reason}` : 'Discount removed', { data: { orderDiscountMinor: pricing.orderDiscountMinor } });
      await this.audit.log(ctx, 'order.discount', 'Order', id, { orderNumber: order.orderNumber, coupon: coupon?.code ?? null, type: manual?.type ?? null, value: manual?.value ?? null, reason: manual?.reason ?? '', amountMinor: pricing.orderDiscountMinor }, tx);
    });
    this.notify(ctx.outletId, id);
    return this.detail(ctx, id);
  }

  // ───────────── Lifecycle ─────────────

  async place(ctx: OutletContext, id: string) {
    await this.prisma.tx(async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (order.status !== 'DRAFT') throw conflict('INVALID_TRANSITION', 'This order has already been placed');
      if (order.items.filter((i) => i.status === 'ACTIVE').length === 0) throw badRequest('EMPTY_ORDER', 'Add at least one item before placing the order');
      if (order.type === 'DELIVERY' && (!order.deliveryAddress || !order.deliveryPhone)) throw badRequest('DELIVERY_DETAILS_REQUIRED', 'A delivery order needs an address and phone number');
      const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: ctx.outletId } });
      await this.confirm(tx, ctx, id, outlet.timezone);
    });
    this.notify(ctx.outletId, id, ['ticket', 'floor']);
    return this.detail(ctx, id);
  }

  /**
   * Completes an order. It must be fully paid. If the kitchen had not marked it ready
   * (for example an outlet that does not use the KDS), its tickets are closed automatically.
   */
  async complete(ctx: OutletContext, id: string) {
    await this.prisma.tx(async (tx) => {
      const order = await this.lock(tx, ctx, id);
      this.assertTransition(ctx, order.status, 'COMPLETED');
      const active = order.items.filter((i) => i.status === 'ACTIVE');
      if (active.length === 0) throw conflict('EMPTY_ORDER', 'An order with no items cannot be completed. Cancel it instead.');
      if (order.paidMinor - order.refundedMinor < order.totalMinor) throw conflict('PAYMENT_DUE', 'Collect the full payment before completing the order', { dueMinor: order.totalMinor - (order.paidMinor - order.refundedMinor) });
      if ((await tx.payment.count({ where: { orderId: id, state: 'PENDING' } })) > 0) throw conflict('PAYMENT_PENDING', 'A payment is still awaiting confirmation');

      await tx.order.update({ where: { id }, data: { status: 'COMPLETED', completedAt: new Date(), version: { increment: 1 } } });
      if (order.status !== 'READY') await this.kitchen.closeTickets(tx, id, 'READY');
      await this.releaseTables(tx, id);
      const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } });
      // consumeForOrderLines skips lines already deducted, so this is safe under either policy.
      if (restaurant.inventoryPolicy !== 'NONE') await this.inventory.consumeForOrderLines(tx, order, active, ctx.userId);
      await this.billing.ensureInvoice(tx, id);
      await this.customers.accrueForOrder(tx, id, ctx.userId);
      await this.event(tx, ctx, id, 'STATUS_CHANGED', order.status === 'READY' ? 'Order completed' : 'Order completed (kitchen tickets closed automatically)', { from: order.status, to: 'COMPLETED' });
    });
    this.notify(ctx.outletId, id, ['ticket', 'floor']);
    return this.detail(ctx, id);
  }

  /**
   * Cancels an open order. Money must be refunded first. Stock already deducted is put back
   * only for items the kitchen had not started preparing.
   */
  async cancel(ctx: OutletContext, id: string, reason: string) {
    await this.prisma.tx(async (tx) => {
      const order = await this.lock(tx, ctx, id);
      this.assertTransition(ctx, order.status, 'CANCELLED');
      if (order.paidMinor - order.refundedMinor > 0) throw conflict('REFUND_REQUIRED', 'Refund the payments on this order before cancelling it');
      if ((await tx.payment.count({ where: { orderId: id, state: 'PENDING' } })) > 0) throw conflict('PAYMENT_PENDING', 'Cancel the pending payment first');
      const active = order.items.filter((i) => i.status === 'ACTIVE');
      const unstarted = await this.kitchen.unstartedItemIds(tx, active.map((i) => i.id));
      await this.inventory.reverseForOrderLines(tx, order, active.filter((i) => unstarted.has(i.id)), ctx.userId, `Order cancelled: ${reason}`);
      await this.kitchen.closeTickets(tx, id, 'CANCELLED');
      if (order.status !== 'DRAFT' && order.discountId) {
        await tx.discount.updateMany({ where: { id: order.discountId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
      }
      await tx.order.update({
        where: { id },
        data: { status: 'CANCELLED', isHeld: false, cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: reason, version: { increment: 1 } },
      });
      await this.releaseTables(tx, id);
      await this.event(tx, ctx, id, 'STATUS_CHANGED', `Order cancelled: ${reason}`, { from: order.status, to: 'CANCELLED' });
      if (order.status !== 'DRAFT') await this.audit.log(ctx, 'order.cancel', 'Order', id, { orderNumber: order.orderNumber, totalMinor: order.totalMinor, fromStatus: order.status, reason }, tx);
    });
    this.notify(ctx.outletId, id, ['ticket', 'floor']);
    return this.detail(ctx, id);
  }

  // ───────────── Table operations ─────────────

  private assertOpenDineIn(order: { type: string; status: OrderStatus }): void {
    if (order.type !== 'DINE_IN') throw badRequest('NOT_DINE_IN', 'Only dine-in orders have tables');
    if (!ACTIVE_ORDER_STATUSES.includes(order.status)) throw conflict('ORDER_CLOSED', 'This order is closed');
  }

  private async tableOp(ctx: OutletContext, id: string, run: (tx: Tx, order: Awaited<ReturnType<OrdersService['lock']>>) => Promise<void>) {
    try {
      await this.prisma.tx(async (tx) => {
        const order = await this.lock(tx, ctx, id);
        this.assertOpenDineIn(order);
        await run(tx, order);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('TABLE_OCCUPIED', 'This table was just taken by another order');
      throw e;
    }
    this.notify(ctx.outletId, id, ['ticket', 'floor']);
    return this.detail(ctx, id);
  }

  transferTable(ctx: OutletContext, id: string, tableId: string) {
    return this.tableOp(ctx, id, async (tx, order) => {
      const from = order.tableLabel;
      await tx.orderTable.deleteMany({ where: { orderId: id } });
      await this.occupy(tx, ctx, id, tableId);
      const to = await this.refreshTableLabel(tx, id);
      await this.event(tx, ctx, id, 'TABLE', `Moved from ${from || 'no table'} to ${to}`);
      await this.audit.log(ctx, 'order.table_transfer', 'Order', id, { orderNumber: order.orderNumber, from, to }, tx);
    });
  }

  /** Joins another free table to this order (one party seated across several tables). */
  attachTable(ctx: OutletContext, id: string, tableId: string) {
    return this.tableOp(ctx, id, async (tx) => {
      await this.occupy(tx, ctx, id, tableId);
      const label = await this.refreshTableLabel(tx, id);
      await this.event(tx, ctx, id, 'TABLE', `Tables joined: ${label}`);
    });
  }

  /** Moves everything from another open, unpaid order onto this one and frees the other order. */
  mergeFrom(ctx: OutletContext, id: string, sourceOrderId: string) {
    if (sourceOrderId === id) throw badRequest('SAME_ORDER', 'Choose a different order to merge');
    return this.tableOp(ctx, id, async (tx, target) => {
      const source = await this.lock(tx, ctx, sourceOrderId);
      this.assertOpenDineIn(source);
      if (source.paidMinor > 0 || (await tx.payment.count({ where: { orderId: sourceOrderId, state: 'PENDING' } })) > 0) {
        throw conflict('SOURCE_HAS_PAYMENTS', 'An order with payments cannot be merged into another');
      }
      if (KITCHEN_ORDER_STATUSES.includes(source.status) !== KITCHEN_ORDER_STATUSES.includes(target.status)) {
        throw conflict('STATUS_MISMATCH', 'Place both orders before merging them');
      }
      // clientLineId is only unique within an order, so it is cleared on the moved lines.
      await tx.orderItem.updateMany({ where: { orderId: sourceOrderId }, data: { orderId: id, clientLineId: null } });
      await tx.kitchenTicket.updateMany({ where: { orderId: sourceOrderId }, data: { orderId: id, orderNumber: target.orderNumber } });
      await tx.orderTable.updateMany({ where: { orderId: sourceOrderId }, data: { orderId: id } });
      if (source.status !== 'DRAFT' && source.discountId) await tx.discount.updateMany({ where: { id: source.discountId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
      await tx.orderTaxLine.deleteMany({ where: { orderId: sourceOrderId } });
      await tx.order.update({
        where: { id: sourceOrderId },
        data: {
          status: 'CANCELLED', cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: `Merged into ${target.orderNumber}`, tableLabel: source.tableLabel,
          subtotalMinor: 0, itemDiscountMinor: 0, orderDiscountMinor: 0, serviceChargeMinor: 0, deliveryChargeMinor: 0, taxableMinor: 0, taxMinor: 0, roundOffMinor: 0, totalMinor: 0,
          guestCount: source.guestCount, version: { increment: 1 },
        },
      });
      await tx.order.update({ where: { id }, data: { guestCount: target.guestCount + source.guestCount } });
      await this.event(tx, ctx, sourceOrderId, 'STATUS_CHANGED', `Merged into ${target.orderNumber}`, { from: source.status, to: 'CANCELLED' });
      const label = await this.refreshTableLabel(tx, id);
      await this.reprice(tx, id);
      await this.kitchen.syncOrderStatus(tx, id, ctx);
      await this.event(tx, ctx, id, 'TABLE', `Merged order ${source.orderNumber} (${source.tableLabel}) into this order; tables: ${label}`);
      await this.audit.log(ctx, 'order.merge', 'Order', id, { target: target.orderNumber, source: source.orderNumber, movedMinor: source.totalMinor }, tx);
      this.realtime.emit(ctx.outletId, REALTIME_EVENTS.orderChanged, { orderId: sourceOrderId });
    });
  }

  /** Splits the bill: moves the chosen quantities to a new order that is paid separately. */
  async split(ctx: OutletContext, id: string, dto: SplitOrderDto) {
    const newId = await this.prisma.tx(async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (!KITCHEN_ORDER_STATUSES.includes(order.status)) throw conflict('INVALID_STATE', 'Only placed, open orders can be split');
      if (order.paidMinor > 0 || (await tx.payment.count({ where: { orderId: id, state: 'PENDING' } })) > 0) throw conflict('HAS_PAYMENTS', 'Split the bill before taking any payment');
      const active = order.items.filter((i) => i.status === 'ACTIVE');
      const moves = dto.items.map((m) => {
        const item = active.find((i) => i.id === m.itemId);
        if (!item) throw notFound('Order item');
        if (m.quantity > item.quantity) throw badRequest('INVALID_QUANTITY', `Only ${item.quantity} x ${item.productName} on this bill`);
        if (m.quantity < item.quantity && item.discountType === 'FLAT') throw badRequest('CANNOT_SPLIT_LINE', `${item.productName} has a fixed discount and must be moved whole`);
        return { item, quantity: m.quantity };
      });
      if (new Set(moves.map((m) => m.item.id)).size !== moves.length) throw badRequest('DUPLICATE_LINE', 'Each item can be listed only once');
      const remaining = active.reduce((a, i) => a + i.quantity, 0) - moves.reduce((a, m) => a + m.quantity, 0);
      if (remaining <= 0) throw badRequest('NOTHING_LEFT', 'Leave at least one item on the original bill');

      const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: ctx.outletId } });
      const day = businessDay(new Date(), outlet.timezone);
      const seq = await this.sequences.next(tx, ctx.outletId, 'ORDER', day);
      const created = await tx.order.create({
        data: {
          restaurantId: order.restaurantId, outletId: order.outletId, orderNumber: `${day}-${String(seq).padStart(4, '0')}`,
          type: order.type, status: order.status, currency: order.currency, customerId: null, tableLabel: order.tableLabel, splitFromOrderId: id,
          pricesIncludeTax: order.pricesIncludeTax, roundOffMode: order.roundOffMode, chargeTaxRules: order.chargeTaxRules as Prisma.InputJsonObject,
          interState: order.interState, serviceChargeBps: order.serviceChargeBps, createdById: ctx.userId, waiterId: order.waiterId, placedAt: order.placedAt,
        },
      });
      for (const { item, quantity } of moves) {
        if (quantity === item.quantity) {
          await tx.orderItem.update({ where: { id: item.id }, data: { orderId: created.id, clientLineId: null } });
          continue;
        }
        const { id: _id, orderId: _orderId, clientLineId: _clientLineId, createdAt: _createdAt, modifiers, taxBreakdown, ...copy } = item;
        await tx.orderItem.update({ where: { id: item.id }, data: { quantity: item.quantity - quantity } });
        await tx.orderItem.create({
          data: {
            ...copy, orderId: created.id, quantity, taxBreakdown: taxBreakdown as Prisma.InputJsonArray,
            modifiers: { create: modifiers.map((m) => ({ modifierOptionId: m.modifierOptionId, groupName: m.groupName, optionName: m.optionName, priceMinor: m.priceMinor })) },
          },
        });
      }
      await this.reprice(tx, id);
      await this.reprice(tx, created.id);
      await this.event(tx, ctx, id, 'SPLIT', `Bill split: ${moves.length} line(s) moved to ${created.orderNumber}`);
      await this.event(tx, ctx, created.id, 'CREATED', `Split from ${order.orderNumber}`, { to: order.status });
      await this.audit.log(ctx, 'order.split', 'Order', id, { from: order.orderNumber, to: created.orderNumber, lines: moves.length }, tx);
      return created.id;
    });
    this.notify(ctx.outletId, id, ['floor']);
    this.notify(ctx.outletId, newId);
    return { original: await this.detail(ctx, id), split: await this.detail(ctx, newId) };
  }

  async assignWaiter(ctx: OutletContext, id: string, waiterId: string | null) {
    const order = await this.find(this.prisma, ctx, id);
    if (!ACTIVE_ORDER_STATUSES.includes(order.status)) throw conflict('ORDER_CLOSED', 'This order is closed');
    let name = 'nobody';
    if (waiterId) {
      const waiter = await this.prisma.user.findFirst({
        where: { id: waiterId, restaurantId: ctx.restaurantId, status: 'ACTIVE', OR: [{ allOutlets: true }, { assignments: { some: { outletId: ctx.outletId } } }] },
      });
      if (!waiter) throw notFound('Staff member');
      name = waiter.name;
    }
    await this.prisma.tx(async (tx) => {
      await tx.order.update({ where: { id }, data: { waiterId } });
      await this.event(tx, ctx, id, 'WAITER', `Assigned to ${name}`);
    });
    this.notify(ctx.outletId, id, ['floor']);
    return this.detail(ctx, id);
  }

  // ───────────── Guest (QR) orders ─────────────

  /** Prices a guest's cart with the normal server rules; nothing is saved. */
  async guestQuote(scope: { restaurantId: string; outletId: string }, items: GuestOrderInput['items']) {
    const cart = cartSchema.parse({ type: 'DINE_IN', items }) as CartDto;
    const { pricing } = await this.priceCart(this.prisma, guestContext(scope.restaurantId, scope.outletId), cart);
    return pricing;
  }

  /**
   * Creates a guest's order from the table QR code. It is saved as PLACED and is NOT sent to
   * the kitchen: that happens only once it is paid (see releasePaidGuestOrder). It does not
   * lock the table, so several guests, and a waiter's own bill, can share one table.
   */
  async createGuestOrder(
    scope: { restaurantId: string; outletId: string; tableId: string; tableName: string },
    dto: { items: GuestOrderInput['items']; guestName: string; notes: string },
    idempotencyKey: string,
    guestToken: string,
  ) {
    const ctx = guestContext(scope.restaurantId, scope.outletId);
    const byKey = { restaurantId_idempotencyKey: { restaurantId: scope.restaurantId, idempotencyKey } };
    const existing = await this.prisma.order.findUnique({ where: byKey });
    if (existing) return existing;
    const cart = cartSchema.parse({ type: 'DINE_IN', items: dto.items, notes: dto.notes }) as CartDto;
    try {
      const order = await this.prisma.tx(async (tx) => {
        const priced = await this.priceCart(tx, ctx, cart);
        const day = businessDay(new Date(), priced.rules.timezone);
        const seq = await this.sequences.next(tx, scope.outletId, 'ORDER', day);
        const created = await tx.order.create({
          data: {
            ...this.cartFields(cart, priced, ctx),
            restaurantId: scope.restaurantId,
            outletId: scope.outletId,
            orderNumber: day + '-' + String(seq).padStart(4, '0'),
            currency: priced.rules.currency,
            source: 'QR',
            status: 'PLACED',
            placedAt: new Date(),
            idempotencyKey,
            guestTableId: scope.tableId,
            guestToken,
            guestName: dto.guestName,
            tableLabel: scope.tableName,
            createdById: null,
            items: { create: this.itemRows(ctx, priced.resolved, priced.pricing) },
            taxLines: { create: this.taxLineRows(priced.pricing) },
          },
        });
        await this.event(tx, ctx, created.id, 'CREATED', 'Ordered by a guest from the table QR code; waiting for payment', { to: 'PLACED' });
        return created;
      });
      this.notify(scope.outletId, order.id);
      return order;
    } catch (e) {
      if (isUniqueViolation(e)) {
        const raced = await this.prisma.order.findUnique({ where: byKey });
        if (raced) return raced;
      }
      throw e;
    }
  }

  /** PLACED -> CONFIRMED for a fully paid guest order: sends it to the kitchen and deducts stock. */
  private async confirmGuestOrder(tx: Tx, orderId: string, actor: OutletContext): Promise<boolean> {
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { where: { status: 'ACTIVE' }, include: { modifiers: true } }, restaurant: true, outlet: true },
    });
    if (order.source !== 'QR' || order.status !== 'PLACED') return false;
    if (order.paidMinor - order.refundedMinor < order.totalMinor) return false;
    await tx.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED', version: { increment: 1 } } });
    await this.event(tx, actor, orderId, 'STATUS_CHANGED', 'Paid; sent to the kitchen', { from: 'PLACED', to: 'CONFIRMED' });
    await this.kitchen.fire(tx, order, order.items, order.outlet.timezone);
    if (order.restaurant.inventoryPolicy === 'ON_CONFIRM') await this.inventory.consumeForOrderLines(tx, order, order.items, actor.userId);
    return true;
  }

  /**
   * Called after a payment succeeds. If that payment completes a guest order, the order goes
   * to the kitchen. If the kitchen cannot take it (for example stock ran out meanwhile), the
   * money is not lost track of: the order stays PLACED and paid, flagged for staff to resolve.
   */
  async releasePaidGuestOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { source: true, status: true, restaurantId: true, outletId: true } });
    if (!order || order.source !== 'QR' || order.status !== 'PLACED') return;
    const ctx = guestContext(order.restaurantId, order.outletId);
    try {
      const sent = await this.prisma.tx((tx) => this.confirmGuestOrder(tx, orderId, ctx));
      if (sent) this.notify(order.outletId, orderId, ['ticket', 'floor']);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      await this.prisma.orderEvent.create({
        data: { orderId, type: 'ATTENTION', actorName: 'System', message: 'Paid, but could not be sent to the kitchen: ' + e.message + '. Staff must send it or refund it.' },
      });
      this.notify(order.outletId, orderId);
    }
  }

  /** Staff retry for a paid guest order that could not be released automatically. */
  async acceptGuestOrder(ctx: OutletContext, id: string) {
    const order = await this.find(this.prisma, ctx, id);
    if (order.source !== 'QR' || order.status !== 'PLACED') throw conflict('INVALID_TRANSITION', 'Only a guest order waiting to be sent can be accepted');
    if (order.paidMinor - order.refundedMinor < order.totalMinor) throw conflict('PAYMENT_DUE', 'This guest order has not been paid yet');
    await this.prisma.tx((tx) => this.confirmGuestOrder(tx, id, ctx));
    this.notify(ctx.outletId, id, ['ticket', 'floor']);
    return this.detail(ctx, id);
  }

  /** Cancels guest orders that were never paid, so abandoned carts do not pile up. */
  async expireUnpaidGuestOrders(olderThanMs = GUEST_PAYMENT_WINDOW_MS): Promise<number> {
    const stale = await this.prisma.order.findMany({
      where: {
        source: 'QR',
        status: 'PLACED',
        paidMinor: 0,
        createdAt: { lt: new Date(Date.now() - olderThanMs) },
        // Someone in the middle of paying gets extra time: cancelling under them risks taking money for a dead order.
        OR: [{ payments: { none: { state: 'PENDING' } } }, { createdAt: { lt: new Date(Date.now() - olderThanMs * 3) } }],
      },
      select: { id: true, outletId: true },
      take: 200,
    });
    let cancelled = 0;
    for (const { id, outletId } of stale) {
      const done = await this.prisma.tx(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${id}::uuid FOR UPDATE`;
        // Re-check under the lock: a payment may have arrived in the meantime.
        const moved = await tx.order.updateMany({
          where: { id, status: 'PLACED', paidMinor: 0 },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Payment was not completed in time', version: { increment: 1 } },
        });
        if (moved.count === 0) return false;
        await tx.payment.updateMany({ where: { orderId: id, state: 'PENDING' }, data: { state: 'CANCELLED', failureReason: 'Order expired' } });
        await tx.orderEvent.create({
          data: { orderId: id, type: 'STATUS_CHANGED', fromStatus: 'PLACED', toStatus: 'CANCELLED', actorName: 'System', message: 'Cancelled automatically: payment was not completed in time' },
        });
        return true;
      });
      if (done) {
        cancelled += 1;
        this.notify(outletId, id);
      }
    }
    return cancelled;
  }

  // ───────────── Queries ─────────────

  async list(ctx: OutletContext, q: OrderQueryDto) {
    const statuses = q.status ? orderStatusList.safeParse(q.status.split(',')) : null;
    if (statuses && !statuses.success) throw badRequest('INVALID_STATUS', 'Unknown order status');
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: ctx.outletId }, select: { timezone: true } });
    const range = q.from || q.to ? localDayRange(q.from ?? q.to!, q.to ?? q.from!, outlet.timezone) : null;
    const where: Prisma.OrderWhereInput = {
      restaurantId: ctx.restaurantId,
      outletId: ctx.outletId,
      ...(statuses ? { status: { in: statuses.data } } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.held != null ? { isHeld: q.held } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(range ? { createdAt: range } : {}),
      ...(q.q ? { OR: [{ orderNumber: { contains: q.q } }, { tableLabel: { contains: q.q, mode: 'insensitive' } }, { customer: { name: { contains: q.q, mode: 'insensitive' } } }, { deliveryName: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...paginate(q),
        select: {
          id: true, orderNumber: true, type: true, status: true, isHeld: true, source: true, tableLabel: true, totalMinor: true, paidMinor: true, refundedMinor: true,
          paymentStatus: true, createdAt: true, placedAt: true, completedAt: true, waiterId: true, guestCount: true, notes: true, guestName: true,
          customer: { select: { id: true, name: true } },
          _count: { select: { items: { where: { status: 'ACTIVE' } } } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return paged(items, total, q);
  }
}

@ApiTags('Orders')
@ApiBearerAuth()
@OutletScoped()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('quote')
  @HttpCode(200)
  @RequirePermissions('order.create')
  @ApiOperation({ summary: 'Price a cart with the authoritative server rules without saving anything' })
  quote(@Ctx() ctx: OutletContext, @Body() dto: CartDto) {
    return this.orders.quote(ctx, dto);
  }

  @Post()
  @RequirePermissions('order.create')
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Unique key per order attempt; retries with the same key return the same order' })
  create(@Ctx() ctx: OutletContext, @Body() dto: CreateOrderDto, @Headers('idempotency-key') key?: string) {
    return this.orders.create(ctx, dto, key);
  }

  @Get()
  @RequirePermissions('order.view')
  list(@Ctx() ctx: OutletContext, @Query() q: OrderQueryDto) {
    return this.orders.list(ctx, q);
  }

  @Get(':id')
  @RequirePermissions('order.view')
  detail(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.detail(ctx, id);
  }

  @Put(':id')
  @RequirePermissions('order.create')
  @ApiOperation({ summary: 'Replace the contents of a draft or held order' })
  update(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateOrderDto) {
    return this.orders.updateDraft(ctx, id, dto);
  }

  @Post(':id/place')
  @HttpCode(200)
  @RequirePermissions('order.create')
  place(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.place(ctx, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermissions('order.create')
  @ApiOperation({ summary: 'Send a paid guest (QR) order to the kitchen when it could not be released automatically' })
  accept(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.acceptGuestOrder(ctx, id);
  }

  @Post(':id/items')
  @HttpCode(200)
  @RequirePermissions('order.update')
  addItems(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddItemsDto) {
    return this.orders.addItems(ctx, id, dto);
  }

  @Post(':id/items/:itemId/void')
  @HttpCode(200)
  @RequirePermissions('order.view')
  voidItem(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: ReasonDto) {
    return this.orders.voidItem(ctx, id, itemId, dto.reason);
  }

  @Post(':id/discount')
  @HttpCode(200)
  @RequirePermissions('order.update')
  setDiscount(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetDiscountDto) {
    return this.orders.setDiscount(ctx, id, dto);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions('order.complete')
  complete(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.complete(ctx, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('order.view')
  cancel(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.orders.cancel(ctx, id, dto.reason);
  }

  @Post(':id/transfer-table')
  @HttpCode(200)
  @RequirePermissions('table.transfer')
  transfer(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferTableDto) {
    return this.orders.transferTable(ctx, id, dto.tableId);
  }

  @Post(':id/attach-table')
  @HttpCode(200)
  @RequirePermissions('table.transfer')
  attach(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachTableDto) {
    return this.orders.attachTable(ctx, id, dto.tableId);
  }

  @Post(':id/merge')
  @HttpCode(200)
  @RequirePermissions('table.transfer')
  merge(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeOrderDto) {
    return this.orders.mergeFrom(ctx, id, dto.sourceOrderId);
  }

  @Post(':id/split')
  @HttpCode(200)
  @RequirePermissions('table.transfer')
  split(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SplitOrderDto) {
    return this.orders.split(ctx, id, dto);
  }

  @Post(':id/waiter')
  @HttpCode(200)
  @RequirePermissions('order.update')
  assignWaiter(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignWaiterDto) {
    return this.orders.assignWaiter(ctx, id, dto.waiterId);
  }
}

@Module({
  imports: [KitchenModule, InventoryModule, CustomersModule, BillingModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
