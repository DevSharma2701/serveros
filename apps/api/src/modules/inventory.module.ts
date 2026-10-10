import { Body, Controller, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InventoryMovementType, Prisma } from '@prisma/client';
import {
  goodsReceiptSchema,
  ingredientSchema,
  movementQuery,
  purchaseOrderSchema,
  recipeSchema,
  stockAdjustmentSchema,
  stockCountSchema,
  stockTransferSchema,
  supplierSchema,
  updateIngredientSchema,
  updateSupplierSchema,
} from '@serveos/shared';
import { randomUUID } from 'node:crypto';
import { createZodDto } from 'nestjs-zod';
import { Ctx, OutletScoped, RequirePermissions, type OutletContext, type RequestContext } from '../common/context';
import { badRequest, conflict, notFound } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { AuditService, SequenceService } from '../common/services';
import { businessDay, paged, paginate } from '../common/util';

class IngredientDto extends createZodDto(ingredientSchema) {}
class UpdateIngredientDto extends createZodDto(updateIngredientSchema) {}
class StockAdjustmentDto extends createZodDto(stockAdjustmentSchema) {}
class StockTransferDto extends createZodDto(stockTransferSchema) {}
class StockCountDto extends createZodDto(stockCountSchema) {}
class RecipeDto extends createZodDto(recipeSchema) {}
class SupplierDto extends createZodDto(supplierSchema) {}
class UpdateSupplierDto extends createZodDto(updateSupplierSchema) {}
class PurchaseOrderDto extends createZodDto(purchaseOrderSchema) {}
class GoodsReceiptDto extends createZodDto(goodsReceiptSchema) {}
class MovementQueryDto extends createZodDto(movementQuery) {}

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
type Unit = { id: string; dimension: string; toBaseFactor: Prisma.Decimal; code: string };

export interface MovementInput {
  restaurantId: string;
  outletId: string;
  ingredientId: string;
  /** Signed change in the ingredient's base unit. */
  delta: Prisma.Decimal;
  type: InventoryMovementType;
  refType: string;
  refId: string;
  orderId?: string | null;
  reason?: string;
  actorId?: string | null;
  unitCostMinor?: Prisma.Decimal;
  allowNegative: boolean;
}

export interface OrderLineForStock {
  id: string;
  productId: string;
  variantId: string;
  quantity: number;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sequences: SequenceService,
  ) {}

  // ── Core: every stock change goes through here ──

  /**
   * Changes stock and records the movement. The balance is updated by a single UPDATE that
   * also checks the result is not negative, so two simultaneous sales can never both take
   * the last unit: the database serialises them on the balance row.
   */
  async applyMovement(tx: Tx, m: MovementInput): Promise<Prisma.Decimal> {
    await tx.$executeRaw`
      INSERT INTO "InventoryBalance" ("outletId", "ingredientId", "quantity", "updatedAt")
      VALUES (${m.outletId}::uuid, ${m.ingredientId}::uuid, 0, now())
      ON CONFLICT DO NOTHING`;
    const rows = await tx.$queryRaw<Array<{ quantity: Prisma.Decimal }>>`
      UPDATE "InventoryBalance"
      SET "quantity" = "quantity" + ${m.delta.toFixed(4)}::numeric, "updatedAt" = now()
      WHERE "outletId" = ${m.outletId}::uuid AND "ingredientId" = ${m.ingredientId}::uuid
        AND (${m.allowNegative} OR "quantity" + ${m.delta.toFixed(4)}::numeric >= 0)
      RETURNING "quantity"`;
    if (rows.length === 0) {
      const [ingredient, balance] = await Promise.all([
        tx.ingredient.findUnique({ where: { id: m.ingredientId }, select: { name: true } }),
        tx.inventoryBalance.findUnique({ where: { outletId_ingredientId: { outletId: m.outletId, ingredientId: m.ingredientId } } }),
      ]);
      throw conflict('INSUFFICIENT_STOCK', `Not enough ${ingredient?.name ?? 'stock'} in stock`, {
        ingredientId: m.ingredientId,
        ingredient: ingredient?.name,
        available: balance?.quantity.toString() ?? '0',
        required: m.delta.abs().toString(),
      });
    }
    const balanceAfter = D(rows[0]!.quantity);
    await tx.inventoryMovement.create({
      data: {
        restaurantId: m.restaurantId,
        outletId: m.outletId,
        ingredientId: m.ingredientId,
        type: m.type,
        quantityDelta: m.delta,
        balanceAfter,
        unitCostMinor: m.unitCostMinor ?? D(0),
        refType: m.refType,
        refId: m.refId,
        orderId: m.orderId ?? null,
        reason: m.reason ?? '',
        createdById: m.actorId ?? null,
      },
    });
    return balanceAfter;
  }

  /** Ingredient quantities each order line uses, from the active recipe (variant recipe wins over the product default). */
  private async requirements(tx: Tx, restaurantId: string, lines: OrderLineForStock[]) {
    const recipes = await tx.recipe.findMany({
      where: { restaurantId, isActive: true, productId: { in: [...new Set(lines.map((l) => l.productId))] } },
      include: { ingredients: true },
    });
    const out: Array<{ lineId: string; ingredientId: string; quantity: Prisma.Decimal }> = [];
    for (const line of lines) {
      const recipe =
        recipes.find((r) => r.productId === line.productId && r.variantId === line.variantId) ??
        recipes.find((r) => r.productId === line.productId && r.variantId === null);
      if (!recipe) continue; // products without a recipe do not affect stock
      const perIngredient = new Map<string, Prisma.Decimal>();
      for (const ri of recipe.ingredients) {
        perIngredient.set(ri.ingredientId, (perIngredient.get(ri.ingredientId) ?? D(0)).plus(ri.baseQuantity.mul(line.quantity)));
      }
      for (const [ingredientId, quantity] of perIngredient) out.push({ lineId: line.id, ingredientId, quantity });
    }
    // A fixed lock order prevents deadlocks between orders that share ingredients.
    return out.sort((a, b) => a.ingredientId.localeCompare(b.ingredientId) || a.lineId.localeCompare(b.lineId));
  }

  /**
   * Deducts recipe ingredients for order lines. Each line is first claimed with a guarded
   * UPDATE, so a line can be deducted only once no matter how often this is called.
   */
  async consumeForOrderLines(tx: Tx, order: { id: string; restaurantId: string; outletId: string }, lines: OrderLineForStock[], actorId: string | null): Promise<void> {
    if (lines.length === 0) return;
    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "OrderItem" SET "stockDeductedAt" = now()
      WHERE "id" IN (${Prisma.join(lines.map((l) => Prisma.sql`${l.id}::uuid`))}) AND "stockDeductedAt" IS NULL AND "status" = 'ACTIVE'
      RETURNING "id"`;
    const ids = new Set(claimed.map((c) => c.id));
    const toDeduct = lines.filter((l) => ids.has(l.id));
    if (toDeduct.length === 0) return;
    const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: order.restaurantId }, select: { allowNegativeStock: true } });
    for (const need of await this.requirements(tx, order.restaurantId, toDeduct)) {
      await this.applyMovement(tx, {
        restaurantId: order.restaurantId,
        outletId: order.outletId,
        ingredientId: need.ingredientId,
        delta: need.quantity.neg(),
        type: 'SALE',
        refType: 'ORDER_ITEM',
        refId: need.lineId,
        orderId: order.id,
        actorId,
        allowNegative: restaurant.allowNegativeStock,
      });
    }
  }

  /** Puts ingredients back for lines that were deducted but never prepared. Also once-only per line. */
  async reverseForOrderLines(tx: Tx, order: { id: string; restaurantId: string; outletId: string }, lines: OrderLineForStock[], actorId: string | null, reason: string): Promise<void> {
    if (lines.length === 0) return;
    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "OrderItem" SET "stockReversedAt" = now()
      WHERE "id" IN (${Prisma.join(lines.map((l) => Prisma.sql`${l.id}::uuid`))}) AND "stockDeductedAt" IS NOT NULL AND "stockReversedAt" IS NULL
      RETURNING "id"`;
    const ids = new Set(claimed.map((c) => c.id));
    for (const need of await this.requirements(tx, order.restaurantId, lines.filter((l) => ids.has(l.id)))) {
      await this.applyMovement(tx, {
        restaurantId: order.restaurantId,
        outletId: order.outletId,
        ingredientId: need.ingredientId,
        delta: need.quantity,
        type: 'SALE_REVERSAL',
        refType: 'ORDER_ITEM',
        refId: need.lineId,
        orderId: order.id,
        reason,
        actorId,
        allowNegative: true,
      });
    }
  }

  // ── Units and conversions ──

  units(ctx: RequestContext) {
    return this.prisma.unitOfMeasure.findMany({ where: { restaurantId: ctx.restaurantId }, orderBy: [{ dimension: 'asc' }, { toBaseFactor: 'asc' }] });
  }

  private async loadUnits(restaurantId: string): Promise<Map<string, Unit>> {
    const units = await this.prisma.unitOfMeasure.findMany({ where: { restaurantId } });
    return new Map(units.map((u) => [u.id, u]));
  }

  /** Converts a quantity entered in `unit` to the ingredient's base unit, rounded to 4 decimals. */
  private toBase(quantity: string, unit: Unit | undefined, baseUnit: Unit | undefined, ingredientName: string): Prisma.Decimal {
    if (!unit || !baseUnit) throw notFound('Unit');
    if (unit.dimension !== baseUnit.dimension) {
      throw badRequest('UNIT_MISMATCH', `${ingredientName} is measured in ${baseUnit.code}; "${unit.code}" cannot be converted to it`);
    }
    return D(quantity).mul(unit.toBaseFactor).div(baseUnit.toBaseFactor).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  }

  private async loadIngredients(restaurantId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = await this.prisma.ingredient.findMany({ where: { restaurantId, id: { in: unique } } });
    if (rows.length !== unique.length) throw notFound('Ingredient');
    return new Map(rows.map((r) => [r.id, r]));
  }

  // ── Ingredients and stock ──

  async ingredients(ctx: RequestContext) {
    const rows = await this.prisma.ingredient.findMany({
      where: { restaurantId: ctx.restaurantId },
      orderBy: { name: 'asc' },
      include: { supplier: { select: { id: true, name: true } }, balances: ctx.outletId ? { where: { outletId: ctx.outletId } } : false },
    });
    return rows.map(({ balances, ...i }) => ({ ...i, quantity: balances?.[0]?.quantity ?? D(0) }));
  }

  async createIngredient(ctx: RequestContext, dto: IngredientDto) {
    const unit = await this.prisma.unitOfMeasure.findFirst({ where: { id: dto.baseUnitId, restaurantId: ctx.restaurantId } });
    if (!unit) throw notFound('Unit');
    if (dto.supplierId && !(await this.prisma.supplier.findFirst({ where: { id: dto.supplierId, restaurantId: ctx.restaurantId } }))) throw notFound('Supplier');
    return this.prisma.ingredient.create({ data: { ...dto, restaurantId: ctx.restaurantId } });
  }

  async updateIngredient(ctx: RequestContext, id: string, dto: UpdateIngredientDto) {
    if (!(await this.prisma.ingredient.findFirst({ where: { id, restaurantId: ctx.restaurantId } }))) throw notFound('Ingredient');
    if (dto.supplierId && !(await this.prisma.supplier.findFirst({ where: { id: dto.supplierId, restaurantId: ctx.restaurantId } }))) throw notFound('Supplier');
    return this.prisma.ingredient.update({ where: { id }, data: dto });
  }

  /** Theoretical stock on hand for the selected outlet, with low-stock flags and value at average cost. */
  async stock(ctx: OutletContext) {
    const [ingredients, units] = await Promise.all([
      this.prisma.ingredient.findMany({
        where: { restaurantId: ctx.restaurantId, isActive: true },
        orderBy: { name: 'asc' },
        include: { balances: { where: { outletId: ctx.outletId } } },
      }),
      this.loadUnits(ctx.restaurantId),
    ]);
    return ingredients.map((i) => {
      const quantity = i.balances[0]?.quantity ?? D(0);
      return {
        ingredientId: i.id,
        name: i.name,
        sku: i.sku,
        unit: units.get(i.baseUnitId)?.code ?? '',
        quantity,
        lowStockThreshold: i.lowStockThreshold,
        isLow: i.lowStockThreshold.gt(0) && quantity.lte(i.lowStockThreshold),
        valueMinor: quantity.mul(i.costPerBaseMinor).toDecimalPlaces(0).toNumber(),
        costPerBaseMinor: i.costPerBaseMinor,
      };
    });
  }

  async movements(ctx: OutletContext, q: MovementQueryDto) {
    const types = Object.values(InventoryMovementType) as string[];
    if (q.type && !types.includes(q.type)) throw badRequest('INVALID_TYPE', 'Unknown movement type');
    const where: Prisma.InventoryMovementWhereInput = {
      restaurantId: ctx.restaurantId,
      outletId: ctx.outletId,
      ...(q.ingredientId ? { ingredientId: q.ingredientId } : {}),
      ...(q.type ? { type: q.type as InventoryMovementType } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    const names = await this.prisma.ingredient.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ingredientId))] } }, select: { id: true, name: true } });
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return paged(rows.map((r) => ({ ...r, ingredientName: nameOf.get(r.ingredientId) ?? '' })), total, q);
  }

  async adjust(ctx: OutletContext, dto: StockAdjustmentDto) {
    const [ingredients, units, restaurant] = await Promise.all([
      this.loadIngredients(ctx.restaurantId, [dto.ingredientId]),
      this.loadUnits(ctx.restaurantId),
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } }),
    ]);
    const ingredient = ingredients.get(dto.ingredientId)!;
    const base = this.toBase(dto.quantity, units.get(dto.unitId), units.get(ingredient.baseUnitId), ingredient.name);
    const removing = dto.type === 'WASTAGE' || dto.direction === 'OUT';
    return this.prisma.tx(async (tx) => {
      const balanceAfter = await this.applyMovement(tx, {
        restaurantId: ctx.restaurantId,
        outletId: ctx.outletId,
        ingredientId: ingredient.id,
        delta: removing ? base.neg() : base,
        type: dto.type,
        refType: 'MANUAL',
        refId: randomUUID(),
        reason: dto.reason,
        actorId: ctx.userId,
        unitCostMinor: ingredient.costPerBaseMinor,
        allowNegative: restaurant.allowNegativeStock,
      });
      await this.audit.log(ctx, `inventory.${dto.type.toLowerCase()}`, 'Ingredient', ingredient.id, { quantity: dto.quantity, unitId: dto.unitId, reason: dto.reason }, tx);
      return { ingredientId: ingredient.id, balanceAfter };
    });
  }

  async transfer(ctx: OutletContext, dto: StockTransferDto) {
    if (dto.toOutletId === ctx.outletId) throw badRequest('SAME_OUTLET', 'Choose a different outlet to transfer to');
    const target = await this.prisma.outlet.findFirst({ where: { id: dto.toOutletId, restaurantId: ctx.restaurantId, isActive: true } });
    if (!target) throw notFound('Outlet');
    const [ingredients, units] = await Promise.all([this.loadIngredients(ctx.restaurantId, dto.lines.map((l) => l.ingredientId)), this.loadUnits(ctx.restaurantId)]);
    const transferId = randomUUID();
    const lines = dto.lines
      .map((l) => {
        const ingredient = ingredients.get(l.ingredientId)!;
        return { ingredient, base: this.toBase(l.quantity, units.get(l.unitId), units.get(ingredient.baseUnitId), ingredient.name) };
      })
      .sort((a, b) => a.ingredient.id.localeCompare(b.ingredient.id));
    await this.prisma.tx(async (tx) => {
      for (const { ingredient, base } of lines) {
        const common = { restaurantId: ctx.restaurantId, ingredientId: ingredient.id, refType: 'TRANSFER', refId: transferId, reason: dto.note, actorId: ctx.userId, unitCostMinor: ingredient.costPerBaseMinor };
        // Stock that is not there cannot be sent, whatever the negative-stock setting says.
        await this.applyMovement(tx, { ...common, outletId: ctx.outletId, delta: base.neg(), type: 'TRANSFER_OUT', allowNegative: false });
        await this.applyMovement(tx, { ...common, outletId: target.id, delta: base, type: 'TRANSFER_IN', allowNegative: true });
      }
      await this.audit.log(ctx, 'inventory.transfer', 'Outlet', target.id, { transferId, lines: lines.length }, tx);
    });
    return { transferId, toOutletId: target.id, lines: lines.length };
  }

  // ── Physical stock counts ──

  stockCounts(ctx: OutletContext) {
    return this.prisma.stockCount.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { _count: { select: { lines: true } } },
    });
  }

  async stockCount(ctx: OutletContext, id: string) {
    const count = await this.prisma.stockCount.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId }, include: { lines: true } });
    if (!count) throw notFound('Stock count');
    return count;
  }

  async createStockCount(ctx: OutletContext, dto: StockCountDto) {
    const [ingredients, units] = await Promise.all([this.loadIngredients(ctx.restaurantId, dto.lines.map((l) => l.ingredientId)), this.loadUnits(ctx.restaurantId)]);
    if (new Set(dto.lines.map((l) => l.ingredientId)).size !== dto.lines.length) throw badRequest('DUPLICATE_LINE', 'Each ingredient can appear only once in a count');
    return this.prisma.stockCount.create({
      data: {
        restaurantId: ctx.restaurantId,
        outletId: ctx.outletId,
        note: dto.note,
        createdById: ctx.userId,
        lines: {
          create: dto.lines.map((l) => {
            const ingredient = ingredients.get(l.ingredientId)!;
            return { ingredientId: l.ingredientId, countedQty: this.toBase(l.countedQty, units.get(l.unitId), units.get(ingredient.baseUnitId), ingredient.name) };
          }),
        },
      },
      include: { lines: true },
    });
  }

  /** Posting compares what was counted with theoretical stock and corrects stock to the counted figure. */
  async postStockCount(ctx: OutletContext, id: string) {
    return this.prisma.tx(async (tx) => {
      const claimed = await tx.stockCount.updateMany({
        where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId, status: 'DRAFT' },
        data: { status: 'POSTED', postedAt: new Date(), postedById: ctx.userId },
      });
      if (claimed.count === 0) throw conflict('COUNT_NOT_OPEN', 'This stock count was not found or is already posted');
      const lines = await tx.stockCountLine.findMany({ where: { stockCountId: id }, orderBy: { ingredientId: 'asc' } });
      for (const line of lines) {
        // Lock the balance row so sales cannot slip in between reading and correcting it.
        const rows = await tx.$queryRaw<Array<{ quantity: Prisma.Decimal }>>`
          SELECT "quantity" FROM "InventoryBalance"
          WHERE "outletId" = ${ctx.outletId}::uuid AND "ingredientId" = ${line.ingredientId}::uuid FOR UPDATE`;
        const theoretical = D(rows[0]?.quantity ?? 0);
        const variance = line.countedQty.minus(theoretical);
        await tx.stockCountLine.update({ where: { id: line.id }, data: { theoreticalQty: theoretical, varianceQty: variance } });
        if (!variance.isZero()) {
          await this.applyMovement(tx, {
            restaurantId: ctx.restaurantId,
            outletId: ctx.outletId,
            ingredientId: line.ingredientId,
            delta: variance,
            type: 'COUNT_CORRECTION',
            refType: 'COUNT',
            refId: id,
            reason: 'Physical stock count',
            actorId: ctx.userId,
            allowNegative: true,
          });
        }
      }
      await this.audit.log(ctx, 'inventory.count_posted', 'StockCount', id, { lines: lines.length }, tx);
      return tx.stockCount.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    });
  }

  // ── Recipes ──

  async recipes(ctx: RequestContext, productId?: string) {
    const [recipes, ingredients] = await Promise.all([
      this.prisma.recipe.findMany({
        where: { restaurantId: ctx.restaurantId, ...(productId ? { productId } : { isActive: true }) },
        orderBy: [{ productId: 'asc' }, { version: 'desc' }],
        include: { ingredients: true, product: { select: { name: true, sku: true } }, variant: { select: { name: true, priceMinor: true } } },
      }),
      this.prisma.ingredient.findMany({ where: { restaurantId: ctx.restaurantId }, select: { id: true, name: true, costPerBaseMinor: true } }),
    ]);
    const byId = new Map(ingredients.map((i) => [i.id, i]));
    return recipes.map((r) => {
      const lines = r.ingredients.map((ri) => {
        const costMinor = ri.baseQuantity.mul(byId.get(ri.ingredientId)?.costPerBaseMinor ?? 0);
        return { ...ri, ingredientName: byId.get(ri.ingredientId)?.name ?? '', costMinor: costMinor.toDecimalPlaces(2).toNumber() };
      });
      return { ...r, ingredients: lines, costMinor: Math.round(lines.reduce((a, l) => a + l.costMinor, 0)) };
    });
  }

  /** Saving a recipe never edits the old one: it is kept as history and a new version becomes active. */
  async saveRecipe(ctx: RequestContext, dto: RecipeDto) {
    const product = await this.prisma.product.findFirst({ where: { id: dto.productId, restaurantId: ctx.restaurantId }, include: { variants: true } });
    if (!product) throw notFound('Product');
    if (dto.variantId && !product.variants.some((v) => v.id === dto.variantId)) throw notFound('Variant');
    const [ingredients, units] = await Promise.all([this.loadIngredients(ctx.restaurantId, dto.ingredients.map((l) => l.ingredientId)), this.loadUnits(ctx.restaurantId)]);
    const lines = dto.ingredients.map((l) => {
      const ingredient = ingredients.get(l.ingredientId)!;
      return { ingredientId: l.ingredientId, unitId: l.unitId, quantity: D(l.quantity), baseQuantity: this.toBase(l.quantity, units.get(l.unitId), units.get(ingredient.baseUnitId), ingredient.name) };
    });
    return this.prisma.tx(async (tx) => {
      const previous = await tx.recipe.findFirst({ where: { productId: dto.productId, variantId: dto.variantId }, orderBy: { version: 'desc' } });
      await tx.recipe.updateMany({ where: { productId: dto.productId, variantId: dto.variantId, isActive: true }, data: { isActive: false } });
      const recipe = await tx.recipe.create({
        data: {
          restaurantId: ctx.restaurantId,
          productId: dto.productId,
          variantId: dto.variantId,
          version: (previous?.version ?? 0) + 1,
          note: dto.note,
          createdById: ctx.userId,
          ingredients: { create: lines },
        },
        include: { ingredients: true },
      });
      await this.audit.log(ctx, 'recipe.save', 'Recipe', recipe.id, { product: product.name, version: recipe.version }, tx);
      return recipe;
    });
  }

  // ── Suppliers and purchasing ──

  suppliers(ctx: RequestContext) {
    return this.prisma.supplier.findMany({ where: { restaurantId: ctx.restaurantId }, orderBy: { name: 'asc' } });
  }

  createSupplier(ctx: RequestContext, dto: SupplierDto) {
    return this.prisma.supplier.create({ data: { ...dto, restaurantId: ctx.restaurantId } });
  }

  async updateSupplier(ctx: RequestContext, id: string, dto: UpdateSupplierDto) {
    if (!(await this.prisma.supplier.findFirst({ where: { id, restaurantId: ctx.restaurantId } }))) throw notFound('Supplier');
    return this.prisma.supplier.update({ where: { id }, data: dto });
  }

  purchaseOrders(ctx: OutletContext) {
    return this.prisma.purchaseOrder.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { supplier: { select: { id: true, name: true } }, items: true, receipts: { select: { id: true, grnNumber: true, receivedAt: true } } },
    });
  }

  private async poFor(ctx: OutletContext, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId }, include: { items: true } });
    if (!po) throw notFound('Purchase order');
    return po;
  }

  async createPurchaseOrder(ctx: OutletContext, dto: PurchaseOrderDto) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: dto.supplierId, restaurantId: ctx.restaurantId, isActive: true } });
    if (!supplier) throw notFound('Supplier');
    const [ingredients, units, outlet] = await Promise.all([
      this.loadIngredients(ctx.restaurantId, dto.items.map((l) => l.ingredientId)),
      this.loadUnits(ctx.restaurantId),
      this.prisma.outlet.findUniqueOrThrow({ where: { id: ctx.outletId } }),
    ]);
    for (const l of dto.items) {
      const ingredient = ingredients.get(l.ingredientId)!;
      this.toBase(l.quantity, units.get(l.unitId), units.get(ingredient.baseUnitId), ingredient.name); // validates the unit
    }
    return this.prisma.tx(async (tx) => {
      const day = businessDay(new Date(), outlet.timezone);
      const seq = await this.sequences.next(tx, ctx.outletId, 'PO', day.slice(0, 4));
      return tx.purchaseOrder.create({
        data: {
          restaurantId: ctx.restaurantId,
          outletId: ctx.outletId,
          supplierId: supplier.id,
          poNumber: `PO-${day.slice(0, 4)}-${String(seq).padStart(4, '0')}`,
          note: dto.note,
          expectedOn: dto.expectedOn ? new Date(dto.expectedOn) : null,
          createdById: ctx.userId,
          items: { create: dto.items.map((l) => ({ ingredientId: l.ingredientId, unitId: l.unitId, quantity: D(l.quantity), unitCostMinor: l.unitCostMinor })) },
        },
        include: { items: true },
      });
    });
  }

  async setPurchaseOrderStatus(ctx: OutletContext, id: string, to: 'SENT' | 'CANCELLED') {
    const po = await this.poFor(ctx, id);
    const allowedFrom = to === 'SENT' ? ['DRAFT'] : ['DRAFT', 'SENT'];
    if (!allowedFrom.includes(po.status)) throw conflict('INVALID_STATE', `A ${po.status.toLowerCase().replace('_', ' ')} purchase order cannot be ${to.toLowerCase()}`);
    const updated = await this.prisma.purchaseOrder.update({ where: { id }, data: { status: to } });
    await this.audit.log(ctx, `purchasing.po_${to.toLowerCase()}`, 'PurchaseOrder', id, { poNumber: po.poNumber });
    return updated;
  }

  goodsReceipts(ctx: OutletContext) {
    return this.prisma.goodsReceipt.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId },
      orderBy: { receivedAt: 'desc' },
      take: 200,
      include: { items: true, purchaseOrder: { select: { poNumber: true } } },
    });
  }

  /** Receives goods (against a purchase order or directly), adds stock and updates average cost. */
  async receiveGoods(ctx: OutletContext, dto: GoodsReceiptDto) {
    const po = dto.purchaseOrderId ? await this.poFor(ctx, dto.purchaseOrderId) : null;
    if (po && !['SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) throw conflict('INVALID_STATE', 'Goods can only be received against a sent purchase order');
    const supplierId = po?.supplierId ?? dto.supplierId;
    if (supplierId && !(await this.prisma.supplier.findFirst({ where: { id: supplierId, restaurantId: ctx.restaurantId } }))) throw notFound('Supplier');
    const [ingredients, units, outlet] = await Promise.all([
      this.loadIngredients(ctx.restaurantId, dto.items.map((l) => l.ingredientId)),
      this.loadUnits(ctx.restaurantId),
      this.prisma.outlet.findUniqueOrThrow({ where: { id: ctx.outletId } }),
    ]);
    const lines = dto.items
      .map((l) => {
        const ingredient = ingredients.get(l.ingredientId)!;
        const poItem = l.purchaseOrderItemId ? po?.items.find((i) => i.id === l.purchaseOrderItemId) : undefined;
        if (l.purchaseOrderItemId && (!poItem || poItem.ingredientId !== l.ingredientId || poItem.unitId !== l.unitId)) throw notFound('Purchase order line');
        const base = this.toBase(l.quantity, units.get(l.unitId), units.get(ingredient.baseUnitId), ingredient.name);
        return { input: l, ingredient, base, costPerBase: D(l.unitCostMinor).mul(l.quantity).div(base) };
      })
      .sort((a, b) => a.ingredient.id.localeCompare(b.ingredient.id));

    return this.prisma.tx(async (tx) => {
      const day = businessDay(new Date(), outlet.timezone);
      const seq = await this.sequences.next(tx, ctx.outletId, 'GRN', day.slice(0, 4));
      const grn = await tx.goodsReceipt.create({
        data: {
          restaurantId: ctx.restaurantId,
          outletId: ctx.outletId,
          purchaseOrderId: po?.id ?? null,
          supplierId: supplierId ?? null,
          grnNumber: `GRN-${day.slice(0, 4)}-${String(seq).padStart(4, '0')}`,
          invoiceNumber: dto.invoiceNumber,
          invoiceDate: dto.invoiceDate ? new Date(dto.invoiceDate) : null,
          invoiceTotalMinor: dto.invoiceTotalMinor,
          note: dto.note,
          receivedById: ctx.userId,
          items: {
            create: lines.map((l) => ({
              purchaseOrderItemId: l.input.purchaseOrderItemId,
              ingredientId: l.ingredient.id,
              unitId: l.input.unitId,
              quantity: D(l.input.quantity),
              baseQuantity: l.base,
              unitCostMinor: l.input.unitCostMinor,
            })),
          },
        },
        include: { items: true },
      });
      for (const l of lines) {
        // Weighted average cost over stock held across the restaurant, read under lock.
        const locked = await tx.$queryRaw<Array<{ costPerBaseMinor: Prisma.Decimal }>>`
          SELECT "costPerBaseMinor" FROM "Ingredient" WHERE "id" = ${l.ingredient.id}::uuid FOR UPDATE`;
        const held = await tx.inventoryBalance.aggregate({ where: { ingredientId: l.ingredient.id }, _sum: { quantity: true } });
        const onHand = Prisma.Decimal.max(held._sum.quantity ?? 0, 0);
        const oldCost = D(locked[0]!.costPerBaseMinor);
        const newCost = onHand.isZero() ? l.costPerBase : onHand.mul(oldCost).plus(l.base.mul(l.costPerBase)).div(onHand.plus(l.base));
        await tx.ingredient.update({ where: { id: l.ingredient.id }, data: { costPerBaseMinor: newCost.toDecimalPlaces(6) } });
        await this.applyMovement(tx, {
          restaurantId: ctx.restaurantId,
          outletId: ctx.outletId,
          ingredientId: l.ingredient.id,
          delta: l.base,
          type: 'RECEIPT',
          refType: 'GRN',
          refId: grn.id,
          actorId: ctx.userId,
          unitCostMinor: l.costPerBase.toDecimalPlaces(6),
          allowNegative: true,
        });
        if (l.input.purchaseOrderItemId) {
          await tx.purchaseOrderItem.update({ where: { id: l.input.purchaseOrderItemId }, data: { receivedQuantity: { increment: D(l.input.quantity) } } });
        }
      }
      if (po) {
        const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
        const complete = items.every((i) => i.receivedQuantity.gte(i.quantity));
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED' } });
      }
      await this.audit.log(ctx, 'purchasing.goods_received', 'GoodsReceipt', grn.id, { grnNumber: grn.grnNumber, lines: lines.length, purchaseOrderId: po?.id ?? null }, tx);
      return grn;
    });
  }
}

@ApiTags('Inventory')
@ApiBearerAuth()
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('units')
  @RequirePermissions('inventory.view')
  units(@Ctx() ctx: RequestContext) {
    return this.inventory.units(ctx);
  }

  @Get('ingredients')
  @RequirePermissions('inventory.view')
  ingredients(@Ctx() ctx: RequestContext) {
    return this.inventory.ingredients(ctx);
  }

  @Post('ingredients')
  @RequirePermissions('inventory.manage')
  createIngredient(@Ctx() ctx: RequestContext, @Body() dto: IngredientDto) {
    return this.inventory.createIngredient(ctx, dto);
  }

  @Patch('ingredients/:id')
  @RequirePermissions('inventory.manage')
  updateIngredient(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIngredientDto) {
    return this.inventory.updateIngredient(ctx, id, dto);
  }

  @Get('inventory/stock')
  @OutletScoped()
  @RequirePermissions('inventory.view')
  stock(@Ctx() ctx: OutletContext) {
    return this.inventory.stock(ctx);
  }

  @Get('inventory/movements')
  @OutletScoped()
  @RequirePermissions('inventory.view')
  movements(@Ctx() ctx: OutletContext, @Query() q: MovementQueryDto) {
    return this.inventory.movements(ctx, q);
  }

  @Post('inventory/adjustments')
  @OutletScoped()
  @RequirePermissions('inventory.manage')
  adjust(@Ctx() ctx: OutletContext, @Body() dto: StockAdjustmentDto) {
    return this.inventory.adjust(ctx, dto);
  }

  @Post('inventory/transfers')
  @OutletScoped()
  @RequirePermissions('inventory.manage')
  transfer(@Ctx() ctx: OutletContext, @Body() dto: StockTransferDto) {
    return this.inventory.transfer(ctx, dto);
  }

  @Get('inventory/counts')
  @OutletScoped()
  @RequirePermissions('inventory.view')
  stockCounts(@Ctx() ctx: OutletContext) {
    return this.inventory.stockCounts(ctx);
  }

  @Get('inventory/counts/:id')
  @OutletScoped()
  @RequirePermissions('inventory.view')
  stockCount(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.stockCount(ctx, id);
  }

  @Post('inventory/counts')
  @OutletScoped()
  @RequirePermissions('inventory.manage')
  createStockCount(@Ctx() ctx: OutletContext, @Body() dto: StockCountDto) {
    return this.inventory.createStockCount(ctx, dto);
  }

  @Post('inventory/counts/:id/post')
  @HttpCode(200)
  @OutletScoped()
  @RequirePermissions('inventory.manage')
  postStockCount(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.postStockCount(ctx, id);
  }

  @Get('recipes')
  @RequirePermissions('inventory.view')
  recipes(@Ctx() ctx: RequestContext, @Query('productId', new ParseUUIDPipe({ optional: true })) productId?: string) {
    return this.inventory.recipes(ctx, productId);
  }

  @Put('recipes')
  @RequirePermissions('recipe.manage')
  saveRecipe(@Ctx() ctx: RequestContext, @Body() dto: RecipeDto) {
    return this.inventory.saveRecipe(ctx, dto);
  }

  @Get('suppliers')
  @RequirePermissions('inventory.view')
  suppliers(@Ctx() ctx: RequestContext) {
    return this.inventory.suppliers(ctx);
  }

  @Post('suppliers')
  @RequirePermissions('purchasing.manage')
  createSupplier(@Ctx() ctx: RequestContext, @Body() dto: SupplierDto) {
    return this.inventory.createSupplier(ctx, dto);
  }

  @Patch('suppliers/:id')
  @RequirePermissions('purchasing.manage')
  updateSupplier(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) {
    return this.inventory.updateSupplier(ctx, id, dto);
  }

  @Get('purchase-orders')
  @OutletScoped()
  @RequirePermissions('inventory.view')
  purchaseOrders(@Ctx() ctx: OutletContext) {
    return this.inventory.purchaseOrders(ctx);
  }

  @Post('purchase-orders')
  @OutletScoped()
  @RequirePermissions('purchasing.manage')
  createPurchaseOrder(@Ctx() ctx: OutletContext, @Body() dto: PurchaseOrderDto) {
    return this.inventory.createPurchaseOrder(ctx, dto);
  }

  @Post('purchase-orders/:id/send')
  @HttpCode(200)
  @OutletScoped()
  @RequirePermissions('purchasing.manage')
  sendPurchaseOrder(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.setPurchaseOrderStatus(ctx, id, 'SENT');
  }

  @Post('purchase-orders/:id/cancel')
  @HttpCode(200)
  @OutletScoped()
  @RequirePermissions('purchasing.manage')
  cancelPurchaseOrder(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.setPurchaseOrderStatus(ctx, id, 'CANCELLED');
  }

  @Get('goods-receipts')
  @OutletScoped()
  @RequirePermissions('inventory.view')
  goodsReceipts(@Ctx() ctx: OutletContext) {
    return this.inventory.goodsReceipts(ctx);
  }

  @Post('goods-receipts')
  @OutletScoped()
  @RequirePermissions('purchasing.manage')
  receiveGoods(@Ctx() ctx: OutletContext, @Body() dto: GoodsReceiptDto) {
    return this.inventory.receiveGoods(ctx, dto);
  }
}

@Module({ controllers: [InventoryController], providers: [InventoryService], exports: [InventoryService] })
export class InventoryModule {}
