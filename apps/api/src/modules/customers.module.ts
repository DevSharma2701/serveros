import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { customerQuery, customerSchema, loyaltyAdjustSchema, updateCustomerSchema } from '@serveos/shared';
import { createZodDto } from 'nestjs-zod';
import { can, Ctx, RequirePermissions, type RequestContext } from '../common/context';
import { conflict, forbidden, notFound } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { AuditService } from '../common/services';
import { paged, paginate } from '../common/util';

class CustomerDto extends createZodDto(customerSchema) {}
class UpdateCustomerDto extends createZodDto(updateCustomerSchema) {}
class CustomerQueryDto extends createZodDto(customerQuery) {}
class LoyaltyAdjustDto extends createZodDto(loyaltyAdjustSchema) {}

type CustomerRow = Prisma.CustomerGetPayload<object>;

const maskPhone = (phone: string | null): string | null => (phone ? `${'•'.repeat(Math.max(phone.length - 4, 0))}${phone.slice(-4)}` : null);
const maskEmail = (email: string): string => (email ? email.replace(/^(.).*(@.*)$/, '$1•••$2') : '');

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Contact details and notes are personal data: they are masked or removed unless the role allows them. */
  present(ctx: RequestContext, c: CustomerRow) {
    const contact = can(ctx, 'customer.view_contact');
    return {
      ...c,
      phone: contact ? c.phone : maskPhone(c.phone),
      email: contact ? c.email : maskEmail(c.email),
      gstin: contact ? c.gstin : '',
      notes: can(ctx, 'customer.notes') ? c.notes : undefined,
    };
  }

  private async find(ctx: RequestContext, id: string): Promise<CustomerRow> {
    const customer = await this.prisma.customer.findFirst({ where: { id, restaurantId: ctx.restaurantId } });
    if (!customer) throw notFound('Customer');
    return customer;
  }

  async list(ctx: RequestContext, q: CustomerQueryDto) {
    const digits = q.q?.replace(/[^\d]/g, '') ?? '';
    const where: Prisma.CustomerWhereInput = {
      restaurantId: ctx.restaurantId,
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : [])] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, ...paginate(q) }),
      this.prisma.customer.count({ where }),
    ]);
    return paged(items.map((c) => this.present(ctx, c)), total, q);
  }

  async detail(ctx: RequestContext, id: string) {
    const customer = await this.find(ctx, id);
    const [orders, ledger] = await Promise.all([
      this.prisma.order.findMany({
        where: { customerId: id, restaurantId: ctx.restaurantId, outletId: { in: ctx.outletIds } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, orderNumber: true, type: true, status: true, totalMinor: true, createdAt: true, outletId: true },
      }),
      this.prisma.loyaltyLedgerEntry.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    return { ...this.present(ctx, customer), orders, ledger };
  }

  private consent(dto: UpdateCustomerDto, before?: CustomerRow): { consentUpdatedAt?: Date } {
    const keys = ['marketingSms', 'marketingEmail', 'marketingWhatsapp'] as const;
    return keys.some((k) => dto[k] != null && dto[k] !== (before?.[k] ?? false)) ? { consentUpdatedAt: new Date() } : {};
  }

  async create(ctx: RequestContext, dto: CustomerDto) {
    if (dto.notes != null && !can(ctx, 'customer.notes')) throw forbidden('You cannot write customer notes');
    const phone = dto.phone || null;
    if (phone && (await this.prisma.customer.findFirst({ where: { restaurantId: ctx.restaurantId, phone } }))) {
      throw conflict('CUSTOMER_EXISTS', 'A customer with this phone number already exists');
    }
    const created = await this.prisma.customer.create({ data: { ...dto, phone, restaurantId: ctx.restaurantId, ...this.consent(dto) } });
    return this.present(ctx, created);
  }

  async update(ctx: RequestContext, id: string, dto: UpdateCustomerDto) {
    const before = await this.find(ctx, id);
    if (dto.notes != null && !can(ctx, 'customer.notes')) throw forbidden('You cannot write customer notes');
    const contactEdit = dto.phone != null || dto.email != null || dto.gstin != null;
    if (contactEdit && !can(ctx, 'customer.view_contact')) throw forbidden('You cannot change customer contact details');
    const data = { ...dto, ...(dto.phone != null ? { phone: dto.phone || null } : {}), ...this.consent(dto, before) };
    const updated = await this.prisma.customer.update({ where: { id }, data });
    if (data.consentUpdatedAt) {
      await this.audit.log(ctx, 'customer.consent_change', 'Customer', id, { sms: updated.marketingSms, email: updated.marketingEmail, whatsapp: updated.marketingWhatsapp });
    }
    return this.present(ctx, updated);
  }

  // ── Loyalty ledger ──

  /** Changes a customer's points and writes the ledger entry. Returns false if `dedupeKey` was already used. */
  private async post(
    tx: Tx,
    entry: { restaurantId: string; customerId: string; type: 'EARN' | 'REDEEM' | 'REVERSAL' | 'ADJUSTMENT'; points: number; orderId?: string | null; dedupeKey?: string; reason?: string; actorId?: string | null },
  ): Promise<boolean> {
    if (entry.points === 0) return false;
    if (entry.dedupeKey && (await tx.loyaltyLedgerEntry.findUnique({ where: { dedupeKey: entry.dedupeKey } }))) return false;
    // The WHERE clause refuses to take the balance below zero, even under concurrent redemptions.
    const rows = await tx.$queryRaw<Array<{ loyaltyPoints: number }>>`
      UPDATE "Customer" SET "loyaltyPoints" = "loyaltyPoints" + ${entry.points}, "updatedAt" = now()
      WHERE "id" = ${entry.customerId}::uuid AND "restaurantId" = ${entry.restaurantId}::uuid AND "loyaltyPoints" + ${entry.points} >= 0
      RETURNING "loyaltyPoints"`;
    if (rows.length === 0) throw conflict('INSUFFICIENT_POINTS', 'The customer does not have enough loyalty points');
    await tx.loyaltyLedgerEntry.create({
      data: {
        restaurantId: entry.restaurantId,
        customerId: entry.customerId,
        type: entry.type,
        points: entry.points,
        balanceAfter: rows[0]!.loyaltyPoints,
        orderId: entry.orderId ?? null,
        dedupeKey: entry.dedupeKey ?? null,
        reason: entry.reason ?? '',
        createdById: entry.actorId ?? null,
      },
    });
    return true;
  }

  /** Awards points for a completed order, once. Amounts paid with points do not earn points. */
  async accrueForOrder(tx: Tx, orderId: string, actorId: string): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { restaurant: true, payments: { where: { state: 'SUCCEEDED' } } } });
    if (!order.customerId || !order.restaurant.loyaltyEnabled) return;
    const claimed = await tx.order.updateMany({ where: { id: orderId, loyaltyAccruedAt: null }, data: { loyaltyAccruedAt: new Date() } });
    if (claimed.count === 0) return;
    const eligible = order.payments.filter((p) => p.method !== 'LOYALTY').reduce((a, p) => a + p.amountMinor - p.refundedMinor, 0);
    const points = Math.floor((eligible * order.restaurant.loyaltyEarnPointsPer100) / 10_000);
    await this.post(tx, { restaurantId: order.restaurantId, customerId: order.customerId, type: 'EARN', points, orderId, dedupeKey: `earn:${orderId}`, reason: `Order ${order.orderNumber}`, actorId });
  }

  /** Takes back points earned on an order that was fully refunded (never more than the customer still has). */
  async reverseForOrder(tx: Tx, orderId: string, actorId: string): Promise<void> {
    const earned = await tx.loyaltyLedgerEntry.findUnique({ where: { dedupeKey: `earn:${orderId}` }, include: { customer: true } });
    if (!earned) return;
    const points = Math.min(earned.points, earned.customer.loyaltyPoints);
    await this.post(tx, { restaurantId: earned.restaurantId, customerId: earned.customerId, type: 'REVERSAL', points: -points, orderId, dedupeKey: `reverse:${orderId}`, reason: 'Order refunded', actorId });
  }

  async redeem(tx: Tx, p: { restaurantId: string; customerId: string; points: number; orderId: string; paymentId: string; actorId: string }): Promise<void> {
    await this.post(tx, { ...p, type: 'REDEEM', points: -p.points, dedupeKey: `redeem:${p.paymentId}`, reason: 'Redeemed against bill' });
  }

  async restore(tx: Tx, p: { restaurantId: string; customerId: string; points: number; orderId: string; refundId: string; actorId: string }): Promise<void> {
    await this.post(tx, { ...p, type: 'REVERSAL', dedupeKey: `refund:${p.refundId}`, reason: 'Loyalty payment refunded' });
  }

  async adjust(ctx: RequestContext, id: string, dto: LoyaltyAdjustDto) {
    await this.find(ctx, id);
    return this.prisma.tx(async (tx) => {
      await this.post(tx, { restaurantId: ctx.restaurantId, customerId: id, type: 'ADJUSTMENT', points: dto.points, reason: dto.reason, actorId: ctx.userId });
      await this.audit.log(ctx, 'loyalty.adjust', 'Customer', id, { points: dto.points, reason: dto.reason }, tx);
      return this.present(ctx, await tx.customer.findUniqueOrThrow({ where: { id } }));
    });
  }
}

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('customer.view')
  list(@Ctx() ctx: RequestContext, @Query() q: CustomerQueryDto) {
    return this.customers.list(ctx, q);
  }

  @Post()
  @RequirePermissions('customer.manage')
  create(@Ctx() ctx: RequestContext, @Body() dto: CustomerDto) {
    return this.customers.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('customer.view')
  detail(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.detail(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('customer.manage')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(ctx, id, dto);
  }

  @Post(':id/loyalty/adjust')
  @RequirePermissions('loyalty.adjust')
  adjust(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LoyaltyAdjustDto) {
    return this.customers.adjust(ctx, id, dto);
  }
}

@Module({ controllers: [CustomersController], providers: [CustomersService], exports: [CustomersService] })
export class CustomersModule {}
