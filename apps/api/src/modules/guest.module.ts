import { Body, Controller, Get, Headers, HttpCode, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { devSimulateSchema, guestOrderSchema, guestPaySchema, REALTIME_EVENTS } from '@serveos/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Ctx, OutletScoped, Public, RequirePermissions, type OutletContext } from '../common/context';
import { badRequest, conflict, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RealtimeGateway } from '../common/realtime.gateway';
import { AuditService } from '../common/services';
import { randomToken } from '../common/util';
import { env } from '../config/env';
import { BillingModule, BillingService } from './billing.module';
import { MenuModule, MenuService } from './menu.module';
import { GUEST_PAYMENT_WINDOW_MS, OrdersModule, OrdersService } from './orders.module';
import { PaymentsModule, PaymentsService } from './payments.module';

class GuestOrderDto extends createZodDto(guestOrderSchema) {}
class GuestPayDto extends createZodDto(guestPaySchema) {}
class GuestSimulateDto extends createZodDto(devSimulateSchema) {}
/** Whatever the provider's checkout handed back to the page. It is only trusted after its signature is verified. */
class GuestConfirmDto extends createZodDto(z.record(z.string().max(40), z.string().max(300)).refine((v) => Object.keys(v).length <= 10)) {}

/** A table may have at most this many guest orders waiting for payment at once. */
const MAX_UNPAID_PER_TABLE = 5;
const test = env.NODE_ENV === 'test';
// These endpoints need no login, so they are limited harder than the rest of the API (per IP).
const READ_LIMIT = { default: { limit: test ? 100_000 : 120, ttl: 60_000 } };
const WRITE_LIMIT = { default: { limit: test ? 100_000 : 12, ttl: 60_000 } };

type Scope = { restaurantId: string; outletId: string };
const asContext = (scope: Scope) => scope as unknown as OutletContext;

@Injectable()
export class GuestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('GuestOrdering');
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly menu: MenuService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    if (test) return; // tests call expireUnpaidGuestOrders directly
    this.sweeper = setInterval(() => {
      // Order matters: first learn about payments whose confirmation never arrived, then expire what is truly unpaid.
      this.payments
        .reconcilePending()
        .then(() => this.orders.expireUnpaidGuestOrders())
        .catch((err) => this.logger.error({ err }, 'could not expire unpaid guest orders'));
    }, 60_000);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /**
   * Finds the table behind a QR token. Every failure (unknown token, inactive table, ordering
   * switched off) gives the same "not found", so tokens cannot be probed.
   */
  private async table(token: string) {
    const table = /^[\w-]{20,80}$/.test(token)
      ? await this.prisma.restaurantTable.findUnique({ where: { qrToken: token }, include: { outlet: { include: { restaurant: true } } } })
      : null;
    if (!table || !table.isActive || !table.outlet.isActive || !table.outlet.qrOrderingEnabled || !table.outlet.restaurant.isActive) throw notFound('Table');
    return table;
  }

  private async order(guestToken: string) {
    const order = /^[\w-]{20,80}$/.test(guestToken)
      ? await this.prisma.order.findUnique({
          where: { guestToken },
          include: { items: { orderBy: { createdAt: 'asc' }, include: { modifiers: true } }, taxLines: true, payments: { orderBy: { createdAt: 'asc' } }, tickets: { select: { status: true } }, events: { where: { type: 'ATTENTION' }, take: 1 } },
        })
      : null;
    if (!order || order.source !== 'QR') throw notFound('Order');
    return order;
  }

  /** The menu a guest sees: names, prices and choices only. No costs, stock, tax set-up or internal settings. */
  async tableMenu(token: string) {
    const table = await this.table(token);
    const catalog = await this.menu.catalog(asContext({ restaurantId: table.restaurantId, outletId: table.outletId }));
    return {
      restaurant: table.outlet.restaurant.name,
      outlet: table.outlet.name,
      table: table.name,
      currency: catalog.settings.currency,
      pricesIncludeTax: catalog.settings.pricesIncludeTax,
      onlinePayment: this.payments.guestGateway, // "dev" is the simulator; null means pay at the counter
      categories: catalog.categories,
      products: catalog.products.map(({ sku: _sku, taxCategoryId: _tax, ...p }) => p),
      modifierGroups: catalog.modifierGroups,
      popularProductIds: catalog.popularProductIds,
    };
  }

  async quote(token: string, dto: GuestOrderDto) {
    const table = await this.table(token);
    const p = await this.orders.guestQuote({ restaurantId: table.restaurantId, outletId: table.outletId }, dto.items);
    return {
      subtotalMinor: p.subtotalMinor, serviceChargeMinor: p.serviceChargeMinor, taxMinor: p.taxMinor, roundOffMinor: p.roundOffMinor, totalMinor: p.totalMinor,
      taxLines: p.taxLines.map((t) => ({ name: t.name, amountMinor: t.amountMinor })),
    };
  }

  async createOrder(token: string, dto: GuestOrderDto, key: string | undefined) {
    if (!key || !/^[\w-]{8,100}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header');
    const table = await this.table(token);
    const unpaid = await this.prisma.order.count({ where: { guestTableId: table.id, source: 'QR', status: 'PLACED', paidMinor: 0 } });
    const replay = await this.prisma.order.findUnique({ where: { restaurantId_idempotencyKey: { restaurantId: table.restaurantId, idempotencyKey: `qr-${key}` } } });
    if (!replay && unpaid >= MAX_UNPAID_PER_TABLE) {
      throw conflict('TOO_MANY_UNPAID_ORDERS', 'This table has several orders waiting for payment. Pay or wait for them to expire, or ask a member of staff.');
    }
    const order = await this.orders.createGuestOrder(
      { restaurantId: table.restaurantId, outletId: table.outletId, tableId: table.id, tableName: table.name },
      dto,
      `qr-${key}`, // namespaced so a guest can never collide with a key used by the POS
      randomToken(24),
    );
    return this.view(order.guestToken!);
  }

  /** Everything the guest's phone may know about its own order. */
  async view(guestToken: string) {
    const o = await this.order(guestToken);
    const pending = o.payments.find((p) => p.state === 'PENDING');
    const lastFailed = [...o.payments].reverse().find((p) => p.state === 'FAILED');
    const paid = o.paidMinor - o.refundedMinor >= o.totalMinor && o.paidMinor > 0;
    const tickets = o.tickets.filter((t) => t.status !== 'CANCELLED');
    return {
      guestToken: o.guestToken,
      orderNumber: o.orderNumber,
      status: o.status,
      table: o.tableLabel,
      guestName: o.guestName,
      currency: o.currency,
      createdAt: o.createdAt,
      items: o.items
        .filter((i) => i.status === 'ACTIVE')
        .map((i) => ({ name: i.productName, variant: i.variantName, quantity: i.quantity, modifiers: i.modifiers.map((m) => m.optionName), notes: i.notes, amountMinor: i.lineSubtotalMinor })),
      subtotalMinor: o.subtotalMinor,
      serviceChargeMinor: o.serviceChargeMinor,
      taxLines: o.taxLines.map((t) => ({ name: t.name, amountMinor: t.amountMinor })),
      roundOffMinor: o.roundOffMinor,
      totalMinor: o.totalMinor,
      refundedMinor: o.refundedMinor,
      payment: {
        state: paid ? ('PAID' as const) : pending ? ('PENDING' as const) : ('UNPAID' as const),
        provider: pending?.provider ?? null,
        checkout: pending ? this.payments.checkoutFor(pending) : null,
        lastFailure: !paid && !pending && lastFailed ? lastFailed.failureReason || 'Declined' : null,
        payBy: o.status === 'PLACED' && !paid ? new Date(o.createdAt.getTime() + GUEST_PAYMENT_WINDOW_MS) : null,
      },
      kitchen: { tickets: tickets.length, ready: tickets.filter((t) => t.status === 'READY').length },
      // Paid but held back from the kitchen: staff have been told and will sort it out.
      needsStaff: o.status === 'PLACED' && paid && o.events.length > 0,
      cancelReason: o.status === 'CANCELLED' ? o.cancelReason : null,
      onlinePayment: this.payments.guestGateway,
    };
  }

  async pay(guestToken: string, dto: GuestPayDto) {
    const order = await this.order(guestToken);
    await this.payments.startGuestPayment(order.id, dto.method);
    this.realtime.emit(order.outletId, REALTIME_EVENTS.orderChanged, { orderId: order.id });
    return this.view(guestToken);
  }

  /** The provider's checkout came back to the guest's page; verify its signed result and settle. */
  async confirm(guestToken: string, fields: Record<string, string>) {
    const order = await this.order(guestToken);
    await this.payments.confirmGuestCheckout(order.id, fields);
    return this.view(guestToken);
  }

  async simulate(guestToken: string, outcome: 'success' | 'failure') {
    const order = await this.order(guestToken);
    await this.payments.guestSimulate(order.id, outcome);
    return this.view(guestToken);
  }

  async receipt(guestToken: string) {
    const order = await this.order(guestToken);
    const receipt = await this.billing.receipt(asContext({ restaurantId: order.restaurantId, outletId: order.outletId }), order.id);
    return { isInvoice: receipt.isInvoice, invoiceNumber: receipt.invoiceNumber, text: receipt.text };
  }

  // ── Staff: QR codes ──

  /** Tables of the selected outlet with their QR secrets. Missing secrets are created on first use. */
  async qrCodes(ctx: OutletContext) {
    const outlet = await this.prisma.outlet.findUniqueOrThrow({ where: { id: ctx.outletId }, select: { qrOrderingEnabled: true, name: true } });
    const tables = await this.prisma.restaurantTable.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, isActive: true },
      orderBy: [{ area: { sortOrder: 'asc' } }, { name: 'asc' }],
      include: { area: { select: { name: true } } },
    });
    for (const t of tables) {
      if (!t.qrToken) t.qrToken = (await this.prisma.restaurantTable.update({ where: { id: t.id }, data: { qrToken: randomToken(24) } })).qrToken;
    }
    return {
      enabled: outlet.qrOrderingEnabled,
      outlet: outlet.name,
      onlinePayment: this.payments.guestGateway,
      webUrl: env.WEB_URL,
      tables: tables.map((t) => ({ id: t.id, name: t.name, area: t.area.name, qrToken: t.qrToken! })),
    };
  }

  /** Replaces a table's QR secret. Every printed copy of the old code stops working at once. */
  async regenerate(ctx: OutletContext, tableId: string) {
    const table = await this.prisma.restaurantTable.findFirst({ where: { id: tableId, restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
    if (!table) throw notFound('Table');
    const updated = await this.prisma.restaurantTable.update({ where: { id: tableId }, data: { qrToken: randomToken(24) } });
    await this.audit.log(ctx, 'table.qr_regenerated', 'RestaurantTable', tableId, { table: table.name });
    return { id: updated.id, name: updated.name, qrToken: updated.qrToken! };
  }
}

@ApiTags('Guest ordering (public)')
@Public()
@Controller('public')
export class GuestController {
  constructor(private readonly guest: GuestService) {}

  @Get('tables/:token')
  @Throttle(READ_LIMIT)
  @ApiOperation({ summary: 'Menu for the table behind a QR code. No login.' })
  menu(@Param('token') token: string) {
    return this.guest.tableMenu(token);
  }

  @Post('tables/:token/quote')
  @HttpCode(200)
  @Throttle(READ_LIMIT)
  quote(@Param('token') token: string, @Body() dto: GuestOrderDto) {
    return this.guest.quote(token, dto);
  }

  @Post('tables/:token/orders')
  @Throttle(WRITE_LIMIT)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Place a guest order. It is sent to the kitchen only after it has been paid.' })
  create(@Param('token') token: string, @Body() dto: GuestOrderDto, @Headers('idempotency-key') key?: string) {
    return this.guest.createOrder(token, dto, key);
  }

  @Get('orders/:guestToken')
  @Throttle(READ_LIMIT)
  view(@Param('guestToken') guestToken: string) {
    return this.guest.view(guestToken);
  }

  @Post('orders/:guestToken/pay')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  pay(@Param('guestToken') guestToken: string, @Body() dto: GuestPayDto) {
    return this.guest.pay(guestToken, dto);
  }

  @Post('orders/:guestToken/confirm')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @ApiOperation({ summary: "Verify the signed result returned by the provider's checkout" })
  confirm(@Param('guestToken') guestToken: string, @Body() dto: GuestConfirmDto) {
    return this.guest.confirm(guestToken, dto as unknown as Record<string, string>);
  }

  @Post('orders/:guestToken/dev-pay')
  @HttpCode(200)
  @Throttle(WRITE_LIMIT)
  @ApiOperation({ summary: 'Development gateway only: simulate the provider confirming or declining the payment' })
  simulate(@Param('guestToken') guestToken: string, @Body() dto: GuestSimulateDto) {
    return this.guest.simulate(guestToken, dto.outcome);
  }

  @Get('orders/:guestToken/receipt')
  @Throttle(READ_LIMIT)
  receipt(@Param('guestToken') guestToken: string) {
    return this.guest.receipt(guestToken);
  }
}

@ApiTags('Floor')
@ApiBearerAuth()
@OutletScoped()
@Controller('qr-codes')
export class QrCodesController {
  constructor(private readonly guest: GuestService) {}

  @Get()
  @RequirePermissions('table.manage')
  list(@Ctx() ctx: OutletContext) {
    return this.guest.qrCodes(ctx);
  }

  @Post(':tableId/regenerate')
  @HttpCode(200)
  @RequirePermissions('table.manage')
  regenerate(@Ctx() ctx: OutletContext, @Param('tableId', ParseUUIDPipe) tableId: string) {
    return this.guest.regenerate(ctx, tableId);
  }
}

@Module({ imports: [MenuModule, OrdersModule, PaymentsModule, BillingModule], controllers: [GuestController, QrCodesController], providers: [GuestService] })
export class GuestModule {}
