import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import {
  categorySchema,
  discountSchema,
  modifierGroupSchema,
  productAvailabilitySchema,
  productQuery,
  productSchema,
  REALTIME_EVENTS,
  taxCategorySchema,
  updateCategorySchema,
  updateDiscountSchema,
  updateProductSchema,
} from '@serveos/shared';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createZodDto } from 'nestjs-zod';
import { assertCan, Ctx, OutletScoped, Public, RequirePermissions, type OutletContext, type RequestContext } from '../common/context';
import { badRequest, conflict, notFound } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { RealtimeGateway } from '../common/realtime.gateway';
import { AuditService } from '../common/services';
import { paged, paginate } from '../common/util';
import { env } from '../config/env';

class CategoryDto extends createZodDto(categorySchema) {}
class UpdateCategoryDto extends createZodDto(updateCategorySchema) {}
class ProductDto extends createZodDto(productSchema) {}
class UpdateProductDto extends createZodDto(updateProductSchema) {}
class ProductQueryDto extends createZodDto(productQuery) {}
class AvailabilityDto extends createZodDto(productAvailabilitySchema) {}
class ModifierGroupDto extends createZodDto(modifierGroupSchema) {}
class TaxCategoryDto extends createZodDto(taxCategorySchema) {}
class DiscountDto extends createZodDto(discountSchema) {}
class UpdateDiscountDto extends createZodDto(updateDiscountSchema) {}

/** The parts of an uploaded file this module uses (held in memory by the upload interceptor). */
interface UploadedImage {
  buffer: Buffer;
  size: number;
}

export const UPLOAD_DIR = resolve(process.cwd(), 'uploads');
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Detects the real file type from its first bytes; the client-supplied name and MIME type are not trusted. */
function sniffImage(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const productInclude = {
  variants: { orderBy: { sortOrder: 'asc' } },
  modifierGroups: { orderBy: { sortOrder: 'asc' }, select: { modifierGroupId: true } },
  category: { select: { id: true, name: true } },
} satisfies Prisma.ProductInclude;

@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Tells every POS in the restaurant to refresh its cached menu. */
  private async notify(restaurantId: string): Promise<void> {
    const outlets = await this.prisma.outlet.findMany({ where: { restaurantId }, select: { id: true } });
    outlets.forEach((o) => this.realtime.emit(o.id, REALTIME_EVENTS.menuChanged));
  }

  private async owned<T>(row: Promise<T | null>, what: string): Promise<T> {
    const found = await row;
    if (!found) throw notFound(what);
    return found;
  }

  // ── Catalogue for the POS ──

  async catalog(ctx: OutletContext) {
    const { restaurantId, outletId } = ctx;
    const [restaurant, outlet, categories, products, modifierGroups, taxCategories, stations, popular] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } }),
      this.prisma.outlet.findUniqueOrThrow({ where: { id: outletId } }),
      this.prisma.category.findMany({ where: { restaurantId, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.product.findMany({
        where: { restaurantId, isActive: true, category: { isActive: true } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          variants: { where: { isActive: true }, orderBy: { sortOrder: 'asc' }, include: { outletPrices: { where: { outletId } } } },
          modifierGroups: { orderBy: { sortOrder: 'asc' }, where: { group: { isActive: true } }, select: { modifierGroupId: true } },
          outletSettings: { where: { outletId } },
        },
      }),
      this.prisma.modifierGroup.findMany({
        where: { restaurantId, isActive: true },
        include: { options: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
      }),
      this.prisma.taxCategory.findMany({ where: { restaurantId, isActive: true }, include: { rules: { where: { isActive: true } } } }),
      this.prisma.kitchenStation.findMany({ where: { outletId, isActive: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.orderItem.groupBy({
        by: ['productId'],
        where: { status: 'ACTIVE', order: { outletId, status: 'COMPLETED', completedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 12,
      }),
    ]);
    const rules = (id: string | null) =>
      taxCategories.find((t) => t.id === id)?.rules.map((r) => ({ component: r.component, name: r.name, rateBps: r.rateBps, scope: r.scope })) ?? [];

    return {
      generatedAt: new Date().toISOString(),
      settings: {
        currency: restaurant.currency,
        pricesIncludeTax: restaurant.pricesIncludeTax,
        roundOffMode: restaurant.roundOffMode,
        serviceChargeBps: outlet.serviceChargeEnabled ? restaurant.serviceChargeBps : 0,
        serviceChargeTaxRules: rules(restaurant.serviceChargeTaxCategoryId),
        deliveryChargeMinor: outlet.deliveryChargeMinor,
        deliveryChargeTaxRules: rules(restaurant.deliveryChargeTaxCategoryId),
        discountApprovalThresholdBps: restaurant.discountApprovalThresholdBps,
        outletStateCode: outlet.stateCode,
      },
      categories: categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId, sortOrder: c.sortOrder })),
      products: products
        .filter((p) => p.variants.length > 0)
        .map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          categoryId: p.categoryId,
          description: p.description,
          imageUrl: p.imageUrl,
          isVeg: p.isVeg,
          isFavorite: p.isFavorite,
          isAvailable: p.outletSettings[0]?.isAvailable ?? true,
          taxCategoryId: p.taxCategoryId,
          variants: p.variants.map((v) => ({
            id: v.id,
            name: v.name,
            priceMinor: v.outletPrices[0]?.priceMinor ?? v.priceMinor,
            isDefault: v.isDefault,
          })),
          modifierGroupIds: p.modifierGroups.map((g) => g.modifierGroupId),
        })),
      modifierGroups: modifierGroups.map((g) => ({
        id: g.id,
        name: g.name,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        options: g.options.map((o) => ({ id: o.id, name: o.name, priceMinor: o.priceMinor })),
      })),
      taxCategories: taxCategories.map((t) => ({ id: t.id, name: t.name, rules: rules(t.id) })),
      stations: stations.map((s) => ({ id: s.id, key: s.key, name: s.name })),
      popularProductIds: popular.map((p) => p.productId),
    };
  }

  // ── Categories ──

  categories(ctx: RequestContext) {
    return this.prisma.category.findMany({
      where: { restaurantId: ctx.restaurantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
  }

  private async assertParent(ctx: RequestContext, parentId: string | null | undefined, selfId?: string): Promise<void> {
    if (!parentId) return;
    if (parentId === selfId) throw badRequest('INVALID_PARENT', 'A category cannot be its own parent');
    const parent = await this.owned(this.prisma.category.findFirst({ where: { id: parentId, restaurantId: ctx.restaurantId } }), 'Parent category');
    if (parent.parentId) throw badRequest('INVALID_PARENT', 'Categories can be nested one level deep only');
  }

  async createCategory(ctx: RequestContext, dto: CategoryDto) {
    await this.assertParent(ctx, dto.parentId);
    const created = await this.prisma.category.create({ data: { ...dto, restaurantId: ctx.restaurantId } });
    await this.notify(ctx.restaurantId);
    return created;
  }

  async updateCategory(ctx: RequestContext, id: string, dto: UpdateCategoryDto) {
    await this.owned(this.prisma.category.findFirst({ where: { id, restaurantId: ctx.restaurantId } }), 'Category');
    await this.assertParent(ctx, dto.parentId, id);
    const updated = await this.prisma.category.update({ where: { id }, data: dto });
    await this.notify(ctx.restaurantId);
    return updated;
  }

  // ── Products ──

  async products(ctx: RequestContext, q: ProductQueryDto) {
    const where: Prisma.ProductWhereInput = {
      restaurantId: ctx.restaurantId,
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.active != null ? { isActive: q.active } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { sku: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: productInclude, ...paginate(q) }),
      this.prisma.product.count({ where }),
    ]);
    return paged(items, total, q);
  }

  async product(ctx: RequestContext, id: string) {
    const product = await this.owned(
      this.prisma.product.findFirst({
        where: { id, restaurantId: ctx.restaurantId },
        include: { ...productInclude, outletSettings: true, variants: { orderBy: { sortOrder: 'asc' }, include: { outletPrices: true } } },
      }),
      'Product',
    );
    return product;
  }

  private async assertProductRefs(ctx: RequestContext, dto: UpdateProductDto): Promise<void> {
    const { restaurantId } = ctx;
    if (dto.categoryId) await this.owned(this.prisma.category.findFirst({ where: { id: dto.categoryId, restaurantId } }), 'Category');
    if (dto.taxCategoryId) await this.owned(this.prisma.taxCategory.findFirst({ where: { id: dto.taxCategoryId, restaurantId } }), 'Tax category');
    if (dto.modifierGroupIds?.length) {
      const unique = [...new Set(dto.modifierGroupIds)];
      const count = await this.prisma.modifierGroup.count({ where: { id: { in: unique }, restaurantId } });
      if (count !== unique.length) throw notFound('Modifier group');
    }
  }

  private async saveVariants(tx: Tx, productId: string, variants: NonNullable<UpdateProductDto['variants']>): Promise<void> {
    const existing = await tx.productVariant.findMany({ where: { productId } });
    const known = new Set(existing.map((v) => v.id));
    if (variants.some((v) => v.id && !known.has(v.id))) throw notFound('Variant');
    const active = variants.filter((v) => v.isActive);
    if (active.length === 0) throw badRequest('NO_ACTIVE_VARIANT', 'A product needs at least one active variant');
    const defaultIndex = Math.max(0, variants.findIndex((v) => v.isDefault && v.isActive));
    const defaultVariant = variants[defaultIndex]!.isActive ? variants[defaultIndex]! : active[0]!;

    const keep = new Set(variants.map((v) => v.id).filter(Boolean));
    // Variants are retired, never deleted: past orders and recipes still refer to them.
    await tx.productVariant.updateMany({ where: { productId, id: { notIn: [...keep] as string[] } }, data: { isActive: false, isDefault: false } });
    for (const [sortOrder, v] of variants.entries()) {
      const data = { name: v.name, priceMinor: v.priceMinor, isActive: v.isActive, isDefault: v === defaultVariant, sortOrder };
      if (v.id) await tx.productVariant.update({ where: { id: v.id }, data });
      else await tx.productVariant.create({ data: { ...data, productId } });
    }
  }

  async createProduct(ctx: RequestContext, dto: ProductDto) {
    await this.assertProductRefs(ctx, dto);
    const { variants, modifierGroupIds, ...fields } = dto;
    const product = await this.prisma.tx(async (tx) => {
      const created = await tx.product.create({
        data: {
          ...fields,
          restaurantId: ctx.restaurantId,
          modifierGroups: { create: [...new Set(modifierGroupIds)].map((modifierGroupId, sortOrder) => ({ modifierGroupId, sortOrder })) },
        },
      });
      await this.saveVariants(tx, created.id, variants);
      await this.audit.log(ctx, 'menu.product_create', 'Product', created.id, { name: created.name, sku: created.sku }, tx);
      return tx.product.findUniqueOrThrow({ where: { id: created.id }, include: productInclude });
    });
    await this.notify(ctx.restaurantId);
    return product;
  }

  async updateProduct(ctx: RequestContext, id: string, dto: UpdateProductDto) {
    const before = await this.owned(this.prisma.product.findFirst({ where: { id, restaurantId: ctx.restaurantId }, include: { variants: true } }), 'Product');
    await this.assertProductRefs(ctx, dto);
    const { variants, modifierGroupIds, ...fields } = dto;
    const product = await this.prisma.tx(async (tx) => {
      await tx.product.update({ where: { id }, data: fields });
      if (variants) await this.saveVariants(tx, id, variants);
      if (modifierGroupIds) {
        await tx.productModifierGroup.deleteMany({ where: { productId: id } });
        await tx.productModifierGroup.createMany({
          data: [...new Set(modifierGroupIds)].map((modifierGroupId, sortOrder) => ({ productId: id, modifierGroupId, sortOrder })),
        });
      }
      const priceChanges = (variants ?? [])
        .map((v) => ({ v, old: before.variants.find((b) => b.id === v.id) }))
        .filter(({ v, old }) => old && old.priceMinor !== v.priceMinor)
        .map(({ v, old }) => ({ variant: v.name, from: old!.priceMinor, to: v.priceMinor }));
      await this.audit.log(ctx, 'menu.product_update', 'Product', id, { fields: Object.keys(dto), priceChanges }, tx);
      return tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });
    });
    await this.notify(ctx.restaurantId);
    return product;
  }

  async setAvailability(ctx: OutletContext, productId: string, dto: AvailabilityDto) {
    const product = await this.owned(
      this.prisma.product.findFirst({ where: { id: productId, restaurantId: ctx.restaurantId }, include: { variants: true } }),
      'Product',
    );
    if (dto.variantPrices) {
      assertCan(ctx, 'menu.manage', 'Only menu managers can set outlet prices');
      if (dto.variantPrices.some((p) => !product.variants.some((v) => v.id === p.variantId))) throw notFound('Variant');
    }
    await this.prisma.tx(async (tx) => {
      await tx.outletProductSetting.upsert({
        where: { outletId_productId: { outletId: ctx.outletId, productId } },
        create: { outletId: ctx.outletId, productId, isAvailable: dto.isAvailable },
        update: { isAvailable: dto.isAvailable },
      });
      for (const p of dto.variantPrices ?? []) {
        const where = { outletId_variantId: { outletId: ctx.outletId, variantId: p.variantId } };
        if (p.priceMinor == null) await tx.outletVariantPrice.deleteMany({ where: { outletId: ctx.outletId, variantId: p.variantId } });
        else await tx.outletVariantPrice.upsert({ where, create: { outletId: ctx.outletId, variantId: p.variantId, priceMinor: p.priceMinor }, update: { priceMinor: p.priceMinor } });
      }
      await this.audit.log(ctx, 'menu.availability', 'Product', productId, { isAvailable: dto.isAvailable, outletPrices: dto.variantPrices?.length ?? 0 }, tx);
    });
    this.realtime.emit(ctx.outletId, REALTIME_EVENTS.menuChanged);
    return { productId, outletId: ctx.outletId, isAvailable: dto.isAvailable };
  }

  async saveImage(ctx: RequestContext, file: UploadedImage | undefined) {
    if (!file) throw badRequest('FILE_REQUIRED', 'Attach an image in the "file" field');
    if (file.size > MAX_IMAGE_BYTES) throw badRequest('FILE_TOO_LARGE', 'Images must be 2 MB or smaller');
    const ext = sniffImage(file.buffer);
    if (!ext) throw badRequest('UNSUPPORTED_FILE', 'Only PNG, JPEG and WebP images are accepted');
    // The stored name is random: nothing from the upload ends up in a file path.
    const name = `${randomBytes(16).toString('hex')}.${ext}`;
    if (env.STORAGE_PROVIDER === 'database') {
      const contentType = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[ext];
      await this.prisma.storedFile.create({ data: { restaurantId: ctx.restaurantId, name, contentType, size: file.size, data: new Uint8Array(file.buffer) } });
      return { url: `/api/v1/files/${name}` };
    }
    const dir = join(UPLOAD_DIR, ctx.restaurantId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), file.buffer, { flag: 'wx' });
    return { url: `/uploads/${ctx.restaurantId}/${name}` };
  }

  /** A stored image by its public name. Menu images are not secret: the guest QR page shows them. */
  async file(name: string) {
    const file = /^[0-9a-f]{32}\.(png|jpg|webp)$/.test(name) ? await this.prisma.storedFile.findUnique({ where: { name } }) : null;
    if (!file) throw notFound('File');
    return file;
  }

  // ── Modifier groups ──

  modifierGroups(ctx: RequestContext) {
    return this.prisma.modifierGroup.findMany({
      where: { restaurantId: ctx.restaurantId },
      orderBy: { name: 'asc' },
      include: { options: { orderBy: { sortOrder: 'asc' } }, _count: { select: { products: true } } },
    });
  }

  async saveModifierGroup(ctx: RequestContext, id: string | null, dto: ModifierGroupDto) {
    const activeOptions = dto.options.filter((o) => o.isActive).length;
    if (dto.isActive && dto.minSelect > activeOptions) throw badRequest('TOO_FEW_OPTIONS', 'The group requires more choices than it has active options');
    const { options, ...fields } = dto;
    const group = await this.prisma.tx(async (tx) => {
      let groupId = id;
      if (groupId) {
        const existing = await tx.modifierGroup.findFirst({ where: { id: groupId, restaurantId: ctx.restaurantId }, include: { options: true } });
        if (!existing) throw notFound('Modifier group');
        if (options.some((o) => o.id && !existing.options.some((e) => e.id === o.id))) throw notFound('Modifier option');
        await tx.modifierGroup.update({ where: { id: groupId }, data: fields });
        const keep = options.map((o) => o.id).filter(Boolean) as string[];
        await tx.modifierOption.updateMany({ where: { modifierGroupId: groupId, id: { notIn: keep } }, data: { isActive: false } });
      } else {
        groupId = (await tx.modifierGroup.create({ data: { ...fields, restaurantId: ctx.restaurantId } })).id;
      }
      for (const [sortOrder, o] of options.entries()) {
        const data = { name: o.name, priceMinor: o.priceMinor, isActive: o.isActive, sortOrder };
        if (o.id) await tx.modifierOption.update({ where: { id: o.id }, data });
        else await tx.modifierOption.create({ data: { ...data, modifierGroupId: groupId } });
      }
      await this.audit.log(ctx, id ? 'menu.modifier_update' : 'menu.modifier_create', 'ModifierGroup', groupId, { name: dto.name }, tx);
      return tx.modifierGroup.findUniqueOrThrow({ where: { id: groupId }, include: { options: { orderBy: { sortOrder: 'asc' } } } });
    });
    await this.notify(ctx.restaurantId);
    return group;
  }

  // ── Tax categories ──

  taxCategories(ctx: RequestContext) {
    return this.prisma.taxCategory.findMany({ where: { restaurantId: ctx.restaurantId }, orderBy: { name: 'asc' }, include: { rules: true } });
  }

  async saveTaxCategory(ctx: RequestContext, id: string | null, dto: TaxCategoryDto) {
    const { rules, ...fields } = dto;
    const saved = await this.prisma.tx(async (tx) => {
      let categoryId = id;
      if (categoryId) {
        const existing = await tx.taxCategory.findFirst({ where: { id: categoryId, restaurantId: ctx.restaurantId }, include: { rules: true } });
        if (!existing) throw notFound('Tax category');
        await tx.taxCategory.update({ where: { id: categoryId }, data: fields });
        // Old orders keep their own tax snapshot, so replacing the rules cannot alter past bills.
        await tx.taxRule.deleteMany({ where: { taxCategoryId: categoryId } });
        await this.audit.log(ctx, 'tax.update', 'TaxCategory', categoryId, { before: existing.rules.map((r) => `${r.name}:${r.rateBps}`), after: rules.map((r) => `${r.name}:${r.rateBps}`) }, tx);
      } else {
        categoryId = (await tx.taxCategory.create({ data: { ...fields, restaurantId: ctx.restaurantId } })).id;
        await this.audit.log(ctx, 'tax.create', 'TaxCategory', categoryId, { name: dto.name }, tx);
      }
      await tx.taxRule.createMany({ data: rules.map((r) => ({ ...r, taxCategoryId: categoryId! })) });
      return tx.taxCategory.findUniqueOrThrow({ where: { id: categoryId }, include: { rules: true } });
    });
    await this.notify(ctx.restaurantId);
    return saved;
  }

  // ── Discounts ──

  discounts(ctx: RequestContext) {
    return this.prisma.discount.findMany({ where: { restaurantId: ctx.restaurantId }, orderBy: { createdAt: 'desc' } });
  }

  private assertDiscount(dto: UpdateDiscountDto): void {
    if (dto.type === 'PERCENT' && (dto.value ?? 0) > 10_000) throw badRequest('INVALID_DISCOUNT', 'A percentage discount cannot exceed 100%');
    if (dto.validFrom && dto.validTo && dto.validFrom >= dto.validTo) throw badRequest('INVALID_RANGE', 'The discount must end after it starts');
  }

  async createDiscount(ctx: RequestContext, dto: DiscountDto) {
    this.assertDiscount(dto);
    return this.prisma.tx(async (tx) => {
      const created = await tx.discount.create({ data: { ...dto, restaurantId: ctx.restaurantId } });
      await this.audit.log(ctx, 'discount.create', 'Discount', created.id, { name: dto.name, code: dto.code }, tx);
      return created;
    });
  }

  async updateDiscount(ctx: RequestContext, id: string, dto: UpdateDiscountDto) {
    const existing = await this.owned(this.prisma.discount.findFirst({ where: { id, restaurantId: ctx.restaurantId } }), 'Discount');
    this.assertDiscount({ type: existing.type, value: existing.value, ...dto });
    if (existing.usedCount > 0 && (dto.type || dto.value != null)) {
      throw conflict('DISCOUNT_IN_USE', 'A discount that has been used cannot change its value. Deactivate it and create a new one.');
    }
    return this.prisma.tx(async (tx) => {
      const updated = await tx.discount.update({ where: { id }, data: dto });
      await this.audit.log(ctx, 'discount.update', 'Discount', id, { fields: Object.keys(dto) }, tx);
      return updated;
    });
  }
}

@ApiTags('Menu')
@ApiBearerAuth()
@Controller()
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get('menu/catalog')
  @OutletScoped()
  @RequirePermissions('menu.view')
  catalog(@Ctx() ctx: OutletContext) {
    return this.menu.catalog(ctx);
  }

  @Get('menu/categories')
  @RequirePermissions('menu.view')
  categories(@Ctx() ctx: RequestContext) {
    return this.menu.categories(ctx);
  }

  @Post('menu/categories')
  @RequirePermissions('menu.manage')
  createCategory(@Ctx() ctx: RequestContext, @Body() dto: CategoryDto) {
    return this.menu.createCategory(ctx, dto);
  }

  @Patch('menu/categories/:id')
  @RequirePermissions('menu.manage')
  updateCategory(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.menu.updateCategory(ctx, id, dto);
  }

  @Get('menu/products')
  @RequirePermissions('menu.view')
  products(@Ctx() ctx: RequestContext, @Query() q: ProductQueryDto) {
    return this.menu.products(ctx, q);
  }

  @Post('menu/products')
  @RequirePermissions('menu.manage')
  createProduct(@Ctx() ctx: RequestContext, @Body() dto: ProductDto) {
    return this.menu.createProduct(ctx, dto);
  }

  @Get('menu/products/:id')
  @RequirePermissions('menu.view')
  product(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.menu.product(ctx, id);
  }

  @Patch('menu/products/:id')
  @RequirePermissions('menu.manage')
  updateProduct(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.menu.updateProduct(ctx, id, dto);
  }

  @Put('menu/products/:id/availability')
  @OutletScoped()
  @RequirePermissions('menu.availability')
  availability(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AvailabilityDto) {
    return this.menu.setAvailability(ctx, id, dto);
  }

  @Post('uploads/product-image')
  @RequirePermissions('menu.manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  upload(@Ctx() ctx: RequestContext, @UploadedFile() file: UploadedImage | undefined) {
    return this.menu.saveImage(ctx, file);
  }

  @Public()
  @Get('files/:name')
  async file(@Param('name') name: string, @Res() res: Response): Promise<void> {
    const file = await this.menu.file(name);
    // The name is random and the content never changes, so browsers may keep it for good.
    res.set({ 'Content-Type': file.contentType, 'Content-Length': String(file.size), 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    res.end(Buffer.from(file.data));
  }

  @Get('menu/modifier-groups')
  @RequirePermissions('menu.view')
  modifierGroups(@Ctx() ctx: RequestContext) {
    return this.menu.modifierGroups(ctx);
  }

  @Post('menu/modifier-groups')
  @RequirePermissions('menu.manage')
  createModifierGroup(@Ctx() ctx: RequestContext, @Body() dto: ModifierGroupDto) {
    return this.menu.saveModifierGroup(ctx, null, dto);
  }

  @Put('menu/modifier-groups/:id')
  @RequirePermissions('menu.manage')
  updateModifierGroup(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ModifierGroupDto) {
    return this.menu.saveModifierGroup(ctx, id, dto);
  }

  @Get('tax-categories')
  @RequirePermissions('menu.view')
  taxCategories(@Ctx() ctx: RequestContext) {
    return this.menu.taxCategories(ctx);
  }

  @Post('tax-categories')
  @RequirePermissions('restaurant.manage')
  createTaxCategory(@Ctx() ctx: RequestContext, @Body() dto: TaxCategoryDto) {
    return this.menu.saveTaxCategory(ctx, null, dto);
  }

  @Put('tax-categories/:id')
  @RequirePermissions('restaurant.manage')
  updateTaxCategory(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TaxCategoryDto) {
    return this.menu.saveTaxCategory(ctx, id, dto);
  }

  @Get('discounts')
  @RequirePermissions('discount.manage')
  discounts(@Ctx() ctx: RequestContext) {
    return this.menu.discounts(ctx);
  }

  @Post('discounts')
  @RequirePermissions('discount.manage')
  createDiscount(@Ctx() ctx: RequestContext, @Body() dto: DiscountDto) {
    return this.menu.createDiscount(ctx, dto);
  }

  @Patch('discounts/:id')
  @RequirePermissions('discount.manage')
  updateDiscount(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDiscountDto) {
    return this.menu.updateDiscount(ctx, id, dto);
  }
}

@Module({ controllers: [MenuController], providers: [MenuService], exports: [MenuService] })
export class MenuModule {}
