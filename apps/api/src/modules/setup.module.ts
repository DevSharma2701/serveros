import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createRestaurantSchema, outletSchema, updateOutletSchema, updateRestaurantSchema } from '@serveos/shared';
import { createZodDto } from 'nestjs-zod';
import { AllowPlatform, can, Ctx, RequirePermissions, type RequestContext } from '../common/context';
import { badRequest, conflict, notFound } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { AuditService } from '../common/services';
import { assertTimeZone } from '../common/util';
import { env } from '../config/env';
import { AuthModule, AuthService } from './auth.module';

class UpdateRestaurantDto extends createZodDto(updateRestaurantSchema) {}
class OutletDto extends createZodDto(outletSchema) {}
class UpdateOutletDto extends createZodDto(updateOutletSchema) {}
class CreateRestaurantDto extends createZodDto(createRestaurantSchema) {}

const DEFAULT_UNITS = [
  { code: 'g', name: 'Gram', dimension: 'MASS', toBaseFactor: 1 },
  { code: 'kg', name: 'Kilogram', dimension: 'MASS', toBaseFactor: 1000 },
  { code: 'ml', name: 'Millilitre', dimension: 'VOLUME', toBaseFactor: 1 },
  { code: 'l', name: 'Litre', dimension: 'VOLUME', toBaseFactor: 1000 },
  { code: 'pc', name: 'Piece', dimension: 'COUNT', toBaseFactor: 1 },
  { code: 'dozen', name: 'Dozen', dimension: 'COUNT', toBaseFactor: 12 },
] as const;

/** Units every new restaurant starts with. */
export async function provisionRestaurantDefaults(tx: Tx, restaurantId: string): Promise<void> {
  await tx.unitOfMeasure.createMany({ data: DEFAULT_UNITS.map((u) => ({ ...u, restaurantId })), skipDuplicates: true });
}

/** A new outlet gets one kitchen station, one cash register and one dining area so it is usable at once. */
export async function provisionOutletDefaults(tx: Tx, restaurantId: string, outletId: string): Promise<void> {
  await tx.kitchenStation.create({ data: { restaurantId, outletId, key: 'MAIN', name: 'Main kitchen', isDefault: true } });
  await tx.cashRegister.create({ data: { restaurantId, outletId, name: 'Counter 1' } });
  await tx.diningArea.create({ data: { restaurantId, outletId, name: 'Main hall' } });
}

@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  getRestaurant(ctx: RequestContext) {
    return this.prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } });
  }

  async updateRestaurant(ctx: RequestContext, dto: UpdateRestaurantDto) {
    for (const taxCategoryId of [dto.serviceChargeTaxCategoryId, dto.deliveryChargeTaxCategoryId]) {
      if (taxCategoryId && !(await this.prisma.taxCategory.findFirst({ where: { id: taxCategoryId, restaurantId: ctx.restaurantId } }))) {
        throw notFound('Tax category');
      }
    }
    return this.prisma.tx(async (tx) => {
      const updated = await tx.restaurant.update({ where: { id: ctx.restaurantId }, data: dto });
      await this.audit.log(ctx, 'restaurant.update', 'Restaurant', updated.id, { fields: Object.keys(dto) }, tx);
      return updated;
    });
  }

  listOutlets(ctx: RequestContext) {
    const seesAll = ctx.allOutlets || can(ctx, 'outlet.manage');
    return this.prisma.outlet.findMany({
      where: { restaurantId: ctx.restaurantId, ...(seesAll ? {} : { id: { in: ctx.outletIds } }) },
      orderBy: { name: 'asc' },
    });
  }

  async createOutlet(ctx: RequestContext, dto: OutletDto) {
    assertTimeZone(dto.timezone);
    return this.prisma.tx(async (tx) => {
      const outlet = await tx.outlet.create({ data: { ...dto, restaurantId: ctx.restaurantId } });
      await provisionOutletDefaults(tx, ctx.restaurantId, outlet.id);
      await this.audit.log(ctx, 'outlet.create', 'Outlet', outlet.id, { name: outlet.name }, tx);
      return outlet;
    });
  }

  async updateOutlet(ctx: RequestContext, id: string, dto: UpdateOutletDto) {
    const outlet = await this.prisma.outlet.findFirst({ where: { id, restaurantId: ctx.restaurantId } });
    if (!outlet) throw notFound('Outlet');
    if (dto.timezone) assertTimeZone(dto.timezone);
    if (dto.code && dto.code !== outlet.code && (await this.prisma.order.count({ where: { outletId: id } })) > 0) {
      // The code is part of issued invoice numbers.
      throw conflict('OUTLET_CODE_LOCKED', 'The outlet code cannot change once orders exist');
    }
    return this.prisma.tx(async (tx) => {
      const updated = await tx.outlet.update({ where: { id }, data: dto });
      await this.audit.log(ctx, 'outlet.update', 'Outlet', id, { fields: Object.keys(dto) }, tx);
      return updated;
    });
  }

  /**
   * What is and is not ready for real use, judged from the server's configuration and this
   * restaurant's data. It reports the state of each setting, never the value of a secret.
   */
  async systemStatus(ctx: RequestContext) {
    const local = (url: string) => /localhost|127\.0\.0\.1/.test(url);
    const [restaurant, outlets, products, taxCategories, untaxed, staff, tables] = await Promise.all([
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } }),
      this.prisma.outlet.findMany({ where: { restaurantId: ctx.restaurantId, isActive: true }, select: { name: true, gstin: true, addressLine1: true } }),
      this.prisma.product.count({ where: { restaurantId: ctx.restaurantId, isActive: true } }),
      this.prisma.taxCategory.count({ where: { restaurantId: ctx.restaurantId, isActive: true } }),
      this.prisma.product.count({ where: { restaurantId: ctx.restaurantId, isActive: true, taxCategoryId: null } }),
      this.prisma.user.count({ where: { restaurantId: ctx.restaurantId, status: 'ACTIVE' } }),
      this.prisma.restaurantTable.count({ where: { restaurantId: ctx.restaurantId, isActive: true } }),
    ]);
    type Item = { key: string; area: 'Server' | 'Restaurant'; label: string; state: 'ready' | 'attention' | 'not_set'; detail: string };
    const live = env.PAYMENT_API_KEY.startsWith('rzp_live_');
    const items: Item[] = [
      { key: 'environment', area: 'Server', label: 'Running mode', state: env.NODE_ENV === 'production' ? 'ready' : 'attention', detail: env.NODE_ENV === 'production' ? 'Production mode.' : 'Development mode. Fine on your own computer; a real server must run with NODE_ENV=production.' },
      {
        key: 'payments', area: 'Server', label: 'Online payments (guest QR orders)',
        state: env.PAYMENT_PROVIDER === 'razorpay' ? (live ? 'ready' : 'attention') : 'not_set',
        detail: env.PAYMENT_PROVIDER === 'razorpay' ? (live ? 'Razorpay with live keys: real money moves.' : 'Razorpay with TEST keys: no real money moves yet.') : env.PAYMENT_PROVIDER === 'dev' ? 'Payment simulator: guests can "pay" without any money moving. Do not use with real customers.' : 'Not configured: guests pay staff at the counter.',
      },
      { key: 'email', area: 'Server', label: 'Email (invitations, password resets)', state: env.EMAIL_PROVIDER === 'resend' ? 'ready' : 'not_set', detail: env.EMAIL_PROVIDER === 'resend' ? `Sending through Resend from ${env.EMAIL_FROM}.` : 'Not configured: emails are not sent. Staff cannot receive invitations or reset links.' },
      { key: 'storage', area: 'Server', label: 'Product image storage', state: env.STORAGE_PROVIDER === 'database' ? 'ready' : 'attention', detail: env.STORAGE_PROVIDER === 'database' ? 'Images are kept in the database and backed up with it.' : "Images are kept on the server's disk. Many hosts wipe that disk on every deploy; use STORAGE_PROVIDER=database there." },
      { key: 'address', area: 'Server', label: 'Public web address', state: local(env.WEB_URL) || local(env.API_URL) ? 'attention' : 'ready', detail: local(env.WEB_URL) || local(env.API_URL) ? 'Still set to localhost, which only works on this computer. Email links and QR codes need your real address.' : `${env.WEB_URL}` },
      { key: 'legal', area: 'Restaurant', label: 'Business details on invoices', state: restaurant.legalName && outlets.every((o) => o.addressLine1) ? (restaurant.gstin || outlets.some((o) => o.gstin) ? 'ready' : 'attention') : 'not_set', detail: restaurant.gstin || outlets.some((o) => o.gstin) ? 'Legal name, address and GSTIN are filled in.' : 'Add your legal name, outlet address and GSTIN (if registered) in Settings and Outlets. They are printed on every invoice.' },
      { key: 'tax', area: 'Restaurant', label: 'Taxes', state: taxCategories === 0 ? 'not_set' : untaxed > 0 ? 'attention' : 'ready', detail: taxCategories === 0 ? 'No tax categories yet. Bills would show no tax.' : untaxed > 0 ? `${untaxed} active product(s) have no tax category and are billed without tax.` : 'Every active product has a tax category. Have your accountant confirm the rates.' },
      { key: 'menu', area: 'Restaurant', label: 'Menu', state: products > 0 ? 'ready' : 'not_set', detail: products > 0 ? `${products} active product(s).` : 'No products yet.' },
      { key: 'staff', area: 'Restaurant', label: 'Staff accounts', state: staff > 1 ? 'ready' : 'attention', detail: staff > 1 ? `${staff} active accounts.` : 'Only one active account. Invite your cashiers, waiters and kitchen staff so each action is recorded under the right name.' },
      { key: 'tables', area: 'Restaurant', label: 'Tables', state: tables > 0 ? 'ready' : 'attention', detail: tables > 0 ? `${tables} active table(s).` : 'No tables yet. Needed for dine-in and QR ordering.' },
    ];
    return { items, ready: items.filter((i) => i.state === 'ready').length, total: items.length };
  }

  listRestaurants() {
    return this.prisma.restaurant.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, legalName: true, slug: true, isActive: true, createdAt: true, _count: { select: { outlets: true, users: true } } },
    });
  }

  async createRestaurant(ctx: RequestContext, dto: CreateRestaurantDto) {
    assertTimeZone(dto.outlet.timezone);
    const ownerRole = await this.prisma.role.findFirstOrThrow({ where: { restaurantId: null, key: 'RESTAURANT_OWNER' } });
    if (await this.prisma.user.findUnique({ where: { email: dto.ownerEmail } })) {
      throw badRequest('EMAIL_IN_USE', 'A user with this email already exists');
    }
    const slugBase = dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'restaurant';
    const result = await this.prisma.tx(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: { name: dto.name, legalName: dto.legalName, slug: `${slugBase}-${Date.now().toString(36)}`, stateCode: dto.outlet.stateCode },
      });
      await provisionRestaurantDefaults(tx, restaurant.id);
      const outlet = await tx.outlet.create({ data: { ...dto.outlet, restaurantId: restaurant.id } });
      await provisionOutletDefaults(tx, restaurant.id, outlet.id);
      const owner = await tx.user.create({
        data: { restaurantId: restaurant.id, roleId: ownerRole.id, email: dto.ownerEmail, name: dto.ownerName, allOutlets: true },
      });
      await this.audit.log({ ...ctx, restaurantId: restaurant.id }, 'restaurant.create', 'Restaurant', restaurant.id, { name: dto.name }, tx);
      return { restaurant, owner };
    });
    await this.auth.sendInvite(result.owner, result.restaurant.name);
    return { id: result.restaurant.id, name: result.restaurant.name, ownerEmail: result.owner.email };
  }
}

@ApiTags('Restaurant & outlets')
@ApiBearerAuth()
@Controller()
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('restaurant')
  @RequirePermissions('restaurant.manage')
  getRestaurant(@Ctx() ctx: RequestContext) {
    return this.setup.getRestaurant(ctx);
  }

  @Patch('restaurant')
  @RequirePermissions('restaurant.manage')
  updateRestaurant(@Ctx() ctx: RequestContext, @Body() dto: UpdateRestaurantDto) {
    return this.setup.updateRestaurant(ctx, dto);
  }

  @Get('system/status')
  @RequirePermissions('restaurant.manage')
  systemStatus(@Ctx() ctx: RequestContext) {
    return this.setup.systemStatus(ctx);
  }

  @Get('outlets')
  listOutlets(@Ctx() ctx: RequestContext) {
    return this.setup.listOutlets(ctx);
  }

  @Post('outlets')
  @RequirePermissions('outlet.manage')
  createOutlet(@Ctx() ctx: RequestContext, @Body() dto: OutletDto) {
    return this.setup.createOutlet(ctx, dto);
  }

  @Patch('outlets/:id')
  @RequirePermissions('outlet.manage')
  updateOutlet(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOutletDto) {
    return this.setup.updateOutlet(ctx, id, dto);
  }

  @Get('platform/restaurants')
  @AllowPlatform()
  @RequirePermissions('platform.manage')
  listRestaurants() {
    return this.setup.listRestaurants();
  }

  @Post('platform/restaurants')
  @AllowPlatform()
  @RequirePermissions('platform.manage')
  createRestaurant(@Ctx() ctx: RequestContext, @Body() dto: CreateRestaurantDto) {
    return this.setup.createRestaurant(ctx, dto);
  }
}

@Module({ imports: [AuthModule], controllers: [SetupController], providers: [SetupService] })
export class SetupModule {}
