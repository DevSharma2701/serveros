import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post, Query, Req, type RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Payment, PaymentState, Prisma } from '@prisma/client';
import { devSimulateSchema, pageQuery, REALTIME_EVENTS, recordPaymentSchema, refundSchema } from '@serveos/shared';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Ctx, OutletScoped, Public, RequirePermissions, type OutletContext } from '../common/context';
import { badRequest, conflict, notFound, unauthorized } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { RealtimeGateway } from '../common/realtime.gateway';
import { AuditService } from '../common/services';
import { paged, paginate } from '../common/util';
import { env } from '../config/env';
import { BillingModule, BillingService, derivePaymentStatus } from './billing.module';
import { CashModule, CashService } from './cash.module';
import { createGateway, DevGateway, type GatewayEvent, type PaymentGateway } from './gateways';
import { CustomersModule, CustomersService } from './customers.module';
import { OrdersModule, OrdersService } from './orders.module';

class RecordPaymentDto extends createZodDto(recordPaymentSchema) {}
class RefundDto extends createZodDto(refundSchema) {}
class DevSimulateDto extends createZodDto(devSimulateSchema) {}
class PaymentQueryDto extends createZodDto(pageQuery.extend({ state: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED']).optional() })) {}

const gateway: PaymentGateway | null = createGateway();

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly billing: BillingService,
    private readonly cash: CashService,
    private readonly customers: CustomersService,
    private readonly orders: OrdersService,
  ) {}

  private async lockOrder(tx: Tx, restaurantId: string, orderId: string) {
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId}::uuid AND "restaurantId" = ${restaurantId}::uuid FOR UPDATE`;
    return tx.order.findFirst({ where: { id: orderId, restaurantId }, include: { restaurant: true } });
  }

  /** Adds a confirmed payment to the order's totals and issues the invoice once the bill is fully paid. */
  private async applySuccess(tx: Tx, payment: Pick<Payment, 'id' | 'orderId' | 'amountMinor' | 'method'>, actor: { userId: string | null; userName: string }): Promise<void> {
    const order = await tx.order.update({ where: { id: payment.orderId }, data: { paidMinor: { increment: payment.amountMinor }, version: { increment: 1 } } });
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: derivePaymentStatus(order.totalMinor, order.paidMinor, order.refundedMinor) } });
    await tx.orderEvent.create({
      data: { orderId: order.id, type: 'PAYMENT', message: `Payment received: ${payment.method}`, data: { paymentId: payment.id, amountMinor: payment.amountMinor }, actorId: actor.userId, actorName: actor.userName },
    });
    if (order.paidMinor - order.refundedMinor >= order.totalMinor && order.status !== 'CANCELLED') await this.billing.ensureInvoice(tx, order.id);
  }

  /**
   * Records one or more tenders against an order in a single transaction (split payment).
   * The amount due is worked out by the server from the stored order; the client only says
   * how much of it is paid by which method. Retrying with the same Idempotency-Key is safe.
   */
  async record(ctx: OutletContext, orderId: string, dto: RecordPaymentDto, key: string | undefined) {
    if (!key || !/^[\w-]{8,100}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-100 letters, digits, "-" or "_")');
    const replayed = await this.prisma.payment.findMany({ where: { restaurantId: ctx.restaurantId, idempotencyKey: { startsWith: `${key}:` } } });
    if (replayed.length > 0) {
      if (replayed.some((p) => p.orderId !== orderId)) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for another order');
      return { payments: replayed, replayed: true };
    }

    const payments = await this.prisma.tx(async (tx) => {
      const order = await this.lockOrder(tx, ctx.restaurantId, orderId);
      if (!order || order.outletId !== ctx.outletId) throw notFound('Order');
      if (!['PLACED', 'CONFIRMED', 'PREPARING', 'READY'].includes(order.status)) {
        throw conflict('ORDER_NOT_PAYABLE', order.status === 'DRAFT' ? 'Place the order before taking payment' : 'This order is closed');
      }
      const pending = await tx.payment.aggregate({ where: { orderId, state: 'PENDING' }, _sum: { amountMinor: true } });
      const dueMinor = order.totalMinor - (order.paidMinor - order.refundedMinor) - (pending._sum.amountMinor ?? 0);
      const sum = dto.tenders.reduce((a, t) => a + t.amountMinor, 0);
      if (sum > dueMinor) throw conflict('OVERPAYMENT', 'The payment is more than the amount due', { dueMinor });
      if (sum < dueMinor && !order.restaurant.allowPartialPayment) throw conflict('PARTIAL_PAYMENT_NOT_ALLOWED', 'The full amount due must be paid together', { dueMinor });

      const shift = await this.cash.openShiftOf(tx, ctx);
      const created: Payment[] = [];
      for (const [index, tender] of dto.tenders.entries()) {
        const base = {
          restaurantId: ctx.restaurantId, outletId: ctx.outletId, orderId, shiftId: shift?.id ?? null, method: tender.method, currency: order.currency,
          amountMinor: tender.amountMinor, reference: tender.reference, idempotencyKey: `${key}:${index}`, receivedById: ctx.userId,
        } satisfies Partial<Prisma.PaymentUncheckedCreateInput>;
        const now = new Date();
        let payment: Payment;

        if (tender.mode === 'GATEWAY') {
          if (!gateway?.counterPayments) throw badRequest('GATEWAY_NOT_CONFIGURED', 'Gateway payments cannot be started at the counter. Record the card or UPI payment manually instead.');
          if (!['UPI', 'CARD'].includes(tender.method)) throw badRequest('INVALID_METHOD', 'Only UPI and card payments can go through the gateway');
          payment = await tx.payment.create({ data: { ...base, provider: gateway.name, state: 'PENDING', verification: 'GATEWAY' } });
          const { providerRef } = await gateway.createPayment({ paymentId: payment.id, amountMinor: payment.amountMinor, currency: payment.currency, method: payment.method, orderNumber: order.orderNumber });
          payment = await tx.payment.update({ where: { id: payment.id }, data: { providerRef } });
          created.push(payment);
          continue; // not money yet: it counts only after the provider's signed confirmation
        }

        if (tender.method === 'CASH') {
          if (!shift) throw conflict('NO_OPEN_SHIFT', 'Open a cash shift before taking cash');
          const tenderedMinor = tender.tenderedMinor ?? tender.amountMinor;
          if (tenderedMinor < tender.amountMinor) throw badRequest('INSUFFICIENT_TENDER', 'The cash handed over is less than the amount');
          payment = await tx.payment.create({
            data: { ...base, provider: 'cash', state: 'SUCCEEDED', verification: 'NOT_REQUIRED', tenderedMinor, changeMinor: tenderedMinor - tender.amountMinor, succeededAt: now },
          });
          await this.cash.recordMovement(tx, shift.id, { type: 'SALE', amountMinor: tender.amountMinor, paymentId: payment.id, actorId: ctx.userId, reason: `Order ${order.orderNumber}` });
        } else if (tender.method === 'LOYALTY') {
          const r = order.restaurant;
          if (!r.loyaltyEnabled) throw badRequest('LOYALTY_DISABLED', 'Loyalty is not enabled for this restaurant');
          if (!order.customerId) throw badRequest('CUSTOMER_REQUIRED', 'Attach a customer to the order to redeem points');
          if (tender.amountMinor % r.loyaltyPointValueMinor !== 0) throw badRequest('INVALID_REDEMPTION', 'Points can only be redeemed in whole points');
          const points = tender.amountMinor / r.loyaltyPointValueMinor;
          if (points < r.loyaltyMinRedeemPoints) throw badRequest('BELOW_MIN_REDEMPTION', `At least ${r.loyaltyMinRedeemPoints} points must be redeemed at a time`);
          payment = await tx.payment.create({ data: { ...base, provider: 'loyalty', state: 'SUCCEEDED', verification: 'NOT_REQUIRED', reference: `${points} points`, succeededAt: now } });
          await this.customers.redeem(tx, { restaurantId: ctx.restaurantId, customerId: order.customerId, points, orderId, paymentId: payment.id, actorId: ctx.userId });
        } else {
          // Taken on a separate card machine or UPI app: the cashier vouches for it. Marked MANUAL, not gateway verified.
          payment = await tx.payment.create({ data: { ...base, provider: 'manual', state: 'SUCCEEDED', verification: 'MANUAL', succeededAt: now } });
        }
        await this.applySuccess(tx, payment, ctx);
        created.push(payment);
      }
      return created;
    });
    // A guest order paid at the counter instead of online is released to the kitchen the same way.
    await this.orders.releasePaidGuestOrder(orderId);
    this.realtime.emit(ctx.outletId, REALTIME_EVENTS.orderChanged, { orderId });
    return { payments, replayed: false };
  }

  /**
   * Handles a provider callback. The signature is verified first; what happens next is the
   * same idempotent settle step every confirmation route uses.
   */
  async handleWebhook(provider: string, rawBody: Buffer | undefined, signature: string | undefined, headers: Record<string, string | string[] | undefined>) {
    if (!gateway || gateway.name !== provider) throw notFound('Payment provider');
    const header = headers[gateway.signatureHeader];
    const given = signature ?? (typeof header === 'string' ? header : undefined);
    if (!rawBody || !given) throw unauthorized('Missing webhook signature');
    const event = gateway.parseWebhook(rawBody, given, headers);
    if (!event) return { received: true, status: 'ignored' as const };
    return { received: true, status: await this.settle(provider, event) };
  }

  /**
   * Applies a verified provider outcome to our payment, exactly once. Each event id is
   * recorded, and the payment leaves PENDING through a guarded update, so a confirmation that
   * arrives twice, by two routes, or while the order is being cancelled cannot be counted twice.
   */
  private async settle(provider: string, event: GatewayEvent): Promise<'processed' | 'duplicate' | 'unknown_payment' | 'already_final'> {
    const result = await this.prisma.tx(async (tx) => {
      const fresh = await tx.paymentWebhookEvent.createMany({ data: [{ provider, eventId: event.eventId }], skipDuplicates: true });
      if (fresh.count === 0) return { status: 'duplicate' as const };
      const payment = await tx.payment.findUnique({ where: { provider_providerRef: { provider, providerRef: event.providerRef } } });
      if (!payment) return { status: 'unknown_payment' as const };
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${payment.orderId}::uuid FOR UPDATE`;
      const succeeded = event.outcome === 'success' && event.amountMinor === payment.amountMinor;
      const state: PaymentState = succeeded ? 'SUCCEEDED' : 'FAILED';
      const failureReason = succeeded ? '' : event.outcome === 'success' ? 'Amount does not match the payment request' : (event.failureReason ?? 'Declined');
      // A payment the guest was told had expired can still be captured by the provider; it must be recorded so it can be refunded.
      const moved = await tx.payment.updateMany({
        where: { id: payment.id, state: succeeded ? { in: ['PENDING', 'CANCELLED'] } : 'PENDING' },
        data: { state, failureReason, succeededAt: succeeded ? new Date() : null, ...(event.paymentRef ? { reference: event.paymentRef } : {}), ...(succeeded && event.method ? { method: event.method } : {}) },
      });
      if (moved.count === 0) {
        // Already settled by a faster route that did not know the method (the page's return does not
        // say). The method is a label, not money, so it is safe to fill in from this later event.
        if (succeeded && event.method && payment.state === 'SUCCEEDED' && payment.method !== event.method && payment.refundedMinor === 0) {
          await tx.payment.update({ where: { id: payment.id }, data: { method: event.method } });
        }
        return { status: 'already_final' as const, payment };
      }
      if (succeeded) {
        await this.applySuccess(tx, payment, { userId: null, userName: `${provider} gateway` });
        const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId }, select: { status: true } });
        if (order.status === 'CANCELLED') {
          await tx.orderEvent.create({ data: { orderId: payment.orderId, type: 'ATTENTION', actorName: 'System', message: 'A payment arrived after this order was cancelled. Refund it.', data: { paymentId: payment.id } } });
        }
      } else {
        await tx.orderEvent.create({ data: { orderId: payment.orderId, type: 'PAYMENT_FAILED', message: `Payment failed: ${failureReason}`, data: { paymentId: payment.id } } });
      }
      return { status: 'processed' as const, payment };
    });
    // Pay first, then cook: a guest order reaches the kitchen only now that its payment is confirmed.
    if (result.status === 'processed') await this.orders.releasePaidGuestOrder(result.payment.orderId);
    if ('payment' in result && result.payment) this.realtime.emit(result.payment.outletId, REALTIME_EVENTS.orderChanged, { orderId: result.payment.orderId });
    return result.status;
  }

  /** What the guest's page needs to open the provider's own checkout for a waiting payment. */
  checkoutFor(payment: Pick<Payment, 'provider' | 'providerRef' | 'amountMinor' | 'currency'>): Record<string, string | number> | null {
    if (!gateway?.checkout || gateway.name !== payment.provider || !payment.providerRef) return null;
    return gateway.checkout({ providerRef: payment.providerRef, amountMinor: payment.amountMinor, currency: payment.currency });
  }

  /**
   * The provider's checkout returned to the guest's page with a signed result. The signature is
   * verified with our secret, and the result must belong to this order; only then is it settled.
   */
  async confirmGuestCheckout(orderId: string, fields: Record<string, string>): Promise<void> {
    if (!gateway?.verifyCheckout) throw notFound('Payment provider');
    const verified = gateway.verifyCheckout(fields);
    const payment = await this.prisma.payment.findUnique({ where: { provider_providerRef: { provider: gateway.name, providerRef: verified.providerRef } } });
    if (!payment || payment.orderId !== orderId) throw unauthorized('Invalid payment confirmation');
    await this.settle(gateway.name, { eventId: `checkout:${verified.paymentRef}`, providerRef: verified.providerRef, outcome: 'success', amountMinor: payment.amountMinor, paymentRef: verified.paymentRef });
  }

  /**
   * Asks the provider about payments still waiting after a minute. This is the safety net for
   * a confirmation that never reached us: without it a guest could pay and never be served.
   */
  async reconcilePending(olderThanMs = 60_000): Promise<number> {
    if (!gateway?.fetchStatus) return 0;
    const waiting = await this.prisma.payment.findMany({
      where: { provider: gateway.name, state: 'PENDING', providerRef: { not: null }, createdAt: { lt: new Date(Date.now() - olderThanMs) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    let settled = 0;
    for (const payment of waiting) {
      try {
        const status = await gateway.fetchStatus(payment.providerRef!);
        if (!status.paid) continue;
        const outcome = await this.settle(gateway.name, { eventId: `reconcile:${payment.providerRef}`, providerRef: payment.providerRef!, outcome: 'success', amountMinor: status.amountMinor, paymentRef: status.paymentRef, method: status.method });
        if (outcome === 'processed') settled += 1;
      } catch {
        // The provider is unreachable or refused: leave the payment waiting and try again next time.
      }
    }
    return settled;
  }

  // ───────────── Guest (QR) payments ─────────────

  /** The online gateway guests can pay through, or null when none is configured. */
  get guestGateway(): string | null {
    return gateway?.name ?? null;
  }

  /**
   * Starts an online payment for the full amount a guest order still owes. Reuses a payment
   * that is already waiting, so tapping "Pay" twice cannot create two charges.
   */
  async startGuestPayment(orderId: string, method: 'UPI' | 'CARD'): Promise<Payment> {
    if (!gateway) throw conflict('ONLINE_PAYMENT_UNAVAILABLE', 'Online payment is not available. Please pay at the counter.');
    const provider = gateway;
    return this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      if (order.source !== 'QR' || order.status !== 'PLACED') throw conflict('ORDER_NOT_PAYABLE', 'This order can no longer be paid here');
      const waiting = await tx.payment.findFirst({ where: { orderId, state: 'PENDING' } });
      if (waiting) return waiting;
      const dueMinor = order.totalMinor - (order.paidMinor - order.refundedMinor);
      if (dueMinor <= 0) throw conflict('ALREADY_PAID', 'This order is already paid');
      const attempts = await tx.payment.count({ where: { orderId } });
      const created = await tx.payment.create({
        data: {
          restaurantId: order.restaurantId, outletId: order.outletId, orderId, method, currency: order.currency, amountMinor: dueMinor,
          provider: provider.name, state: 'PENDING', verification: 'GATEWAY', idempotencyKey: `guest-${orderId}-${attempts + 1}`, receivedById: null,
        },
      });
      const { providerRef } = await provider.createPayment({ paymentId: created.id, amountMinor: dueMinor, currency: order.currency, method, orderNumber: order.orderNumber });
      return tx.payment.update({ where: { id: created.id }, data: { providerRef } });
    });
  }

  /** Development gateway only: the guest's page plays the provider by sending a signed callback. */
  async guestSimulate(orderId: string, outcome: 'success' | 'failure'): Promise<void> {
    if (!(gateway instanceof DevGateway)) throw notFound('Payment provider');
    const payment = await this.prisma.payment.findFirst({ where: { orderId, provider: 'dev', state: 'PENDING' } });
    if (!payment) throw conflict('NOT_PENDING', 'There is no payment waiting for this order');
    const body = JSON.stringify({
      id: `evt_${randomBytes(10).toString('hex')}`,
      type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
      data: { providerRef: payment.providerRef, amountMinor: payment.amountMinor },
    });
    await this.handleWebhook('dev', Buffer.from(body), gateway.sign(body), {});
  }

  private async findPayment(ctx: OutletContext, id: string) {
    const payment = await this.prisma.payment.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
    if (!payment) throw notFound('Payment');
    return payment;
  }

  /** Development only: plays the provider's part by sending a correctly signed callback to our own webhook handler. */
  async devSimulate(ctx: OutletContext, id: string, outcome: 'success' | 'failure') {
    if (!(gateway instanceof DevGateway)) throw notFound('Payment provider');
    const payment = await this.findPayment(ctx, id);
    if (payment.provider !== 'dev' || payment.state !== 'PENDING') throw conflict('NOT_PENDING', 'This payment is not awaiting confirmation');
    const body = JSON.stringify({
      id: `evt_${randomBytes(10).toString('hex')}`,
      type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
      data: { providerRef: payment.providerRef, amountMinor: payment.amountMinor },
    });
    await this.handleWebhook('dev', Buffer.from(body), gateway.sign(body), {});
    return this.findPayment(ctx, id);
  }

  async cancelPending(ctx: OutletContext, id: string) {
    const payment = await this.findPayment(ctx, id);
    const moved = await this.prisma.payment.updateMany({ where: { id, state: 'PENDING' }, data: { state: 'CANCELLED', failureReason: `Cancelled by ${ctx.userName}` } });
    if (moved.count === 0) throw conflict('NOT_PENDING', 'Only a pending payment can be cancelled');
    this.realtime.emit(ctx.outletId, REALTIME_EVENTS.orderChanged, { orderId: payment.orderId });
    return this.findPayment(ctx, id);
  }

  /**
   * Refunds part or all of a payment. The original payment is never edited or deleted:
   * a Refund row with its own credit note number is added, and cash refunds leave the drawer
   * through the cash ledger. A completed order that is refunded in full becomes REFUNDED.
   */
  async refund(ctx: OutletContext, paymentId: string, dto: RefundDto, key: string | undefined) {
    if (!key || !/^[\w-]{8,100}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-100 letters, digits, "-" or "_")');
    const existing = await this.prisma.refund.findUnique({ where: { restaurantId_idempotencyKey: { restaurantId: ctx.restaurantId, idempotencyKey: key } } });
    if (existing) return { refund: existing, replayed: true };
    const found = await this.findPayment(ctx, paymentId);

    const refund = await this.prisma.tx(async (tx) => {
      const order = await this.lockOrder(tx, ctx.restaurantId, found.orderId);
      if (!order) throw notFound('Order');
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (payment.state !== 'SUCCEEDED') throw conflict('NOT_REFUNDABLE', 'Only a successful payment can be refunded');
      if (dto.amountMinor > payment.amountMinor - payment.refundedMinor) {
        throw conflict('REFUND_TOO_LARGE', 'The refund is more than what remains on this payment', { refundableMinor: payment.amountMinor - payment.refundedMinor });
      }
      const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: ctx.outletId } });
      const shift = await this.cash.openShiftOf(tx, ctx);
      if (payment.method === 'CASH' && !shift) throw conflict('NO_OPEN_SHIFT', 'Open a cash shift before refunding cash');

      const created = await tx.refund.create({
        data: {
          restaurantId: ctx.restaurantId, outletId: ctx.outletId, orderId: order.id, paymentId, shiftId: shift?.id ?? null, amountMinor: dto.amountMinor, reason: dto.reason,
          creditNoteNumber: await this.billing.nextCreditNoteNumber(tx, outlet), idempotencyKey: key, createdById: ctx.userId,
        },
      });
      await tx.payment.update({ where: { id: paymentId }, data: { refundedMinor: { increment: dto.amountMinor } } });
      if (payment.method === 'CASH') await this.cash.recordMovement(tx, shift!.id, { type: 'REFUND', amountMinor: -dto.amountMinor, refundId: created.id, actorId: ctx.userId, reason: dto.reason });
      if (payment.method === 'LOYALTY' && order.customerId) {
        const points = Math.floor(dto.amountMinor / order.restaurant.loyaltyPointValueMinor);
        await this.customers.restore(tx, { restaurantId: ctx.restaurantId, customerId: order.customerId, points, orderId: order.id, refundId: created.id, actorId: ctx.userId });
      }
      // The provider is asked last, so nothing above can fail after the money has actually been sent back.
      if (payment.verification === 'GATEWAY' && gateway && gateway.name === payment.provider && payment.providerRef) {
        await gateway.refund({ providerRef: payment.providerRef, paymentRef: payment.reference, amountMinor: dto.amountMinor });
      }

      const refundedMinor = order.refundedMinor + dto.amountMinor;
      const fullyRefunded = order.status === 'COMPLETED' && refundedMinor === order.paidMinor;
      await tx.order.update({
        where: { id: order.id },
        data: { refundedMinor, paymentStatus: derivePaymentStatus(order.totalMinor, order.paidMinor, refundedMinor), ...(fullyRefunded ? { status: 'REFUNDED' as const } : {}), version: { increment: 1 } },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id, type: 'REFUND', message: `Refund ${created.creditNoteNumber}: ${dto.reason}`, data: { refundId: created.id, amountMinor: dto.amountMinor },
          actorId: ctx.userId, actorName: ctx.userName, ...(fullyRefunded ? { fromStatus: 'COMPLETED' as const, toStatus: 'REFUNDED' as const } : {}),
        },
      });
      if (fullyRefunded) await this.customers.reverseForOrder(tx, order.id, ctx.userId);
      await this.audit.log(ctx, 'payment.refund', 'Order', order.id, { orderNumber: order.orderNumber, paymentId, method: payment.method, amountMinor: dto.amountMinor, creditNote: created.creditNoteNumber, reason: dto.reason }, tx);
      return created;
    });
    this.realtime.emit(ctx.outletId, REALTIME_EVENTS.orderChanged, { orderId: found.orderId });
    return { refund, replayed: false };
  }

  async list(ctx: OutletContext, q: PaymentQueryDto) {
    const where = { restaurantId: ctx.restaurantId, outletId: ctx.outletId, ...(q.state ? { state: q.state } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), include: { order: { select: { orderNumber: true, status: true } } } }),
      this.prisma.payment.count({ where }),
    ]);
    return paged(items, total, q);
  }
}

@ApiTags('Payments')
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('orders/:id/payments')
  @ApiBearerAuth()
  @OutletScoped()
  @RequirePermissions('payment.record')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Record one or more tenders (cash, manual card/UPI, loyalty, or a gateway request) against an order' })
  record(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordPaymentDto, @Headers('idempotency-key') key?: string) {
    return this.payments.record(ctx, id, dto, key);
  }

  @Get('payments')
  @ApiBearerAuth()
  @OutletScoped()
  @RequirePermissions('payment.record')
  @ApiOperation({ summary: 'List payments; filter state=PENDING to reconcile unconfirmed gateway payments' })
  list(@Ctx() ctx: OutletContext, @Query() q: PaymentQueryDto) {
    return this.payments.list(ctx, q);
  }

  @Post('payments/:id/refunds')
  @ApiBearerAuth()
  @OutletScoped()
  @RequirePermissions('payment.refund')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  refund(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDto, @Headers('idempotency-key') key?: string) {
    return this.payments.refund(ctx, id, dto, key);
  }

  @Post('payments/:id/cancel')
  @HttpCode(200)
  @ApiBearerAuth()
  @OutletScoped()
  @RequirePermissions('payment.record')
  cancel(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.cancelPending(ctx, id);
  }

  @Post('payments/:id/dev-simulate')
  @HttpCode(200)
  @ApiBearerAuth()
  @OutletScoped()
  @RequirePermissions('payment.record')
  @ApiOperation({ summary: 'Development gateway only: simulate the provider confirming or declining a pending payment' })
  devSimulate(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DevSimulateDto) {
    return this.payments.devSimulate(ctx, id, dto.outcome);
  }

  @Public()
  @Post('payments/webhooks/:provider')
  @HttpCode(200)
  @ApiOperation({ summary: 'Provider callback. Authenticated by its signature, not by a user session.' })
  webhook(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>) {
    return this.payments.handleWebhook(provider, req.rawBody, undefined, req.headers);
  }
}

@Module({ imports: [BillingModule, CashModule, CustomersModule, OrdersModule], controllers: [PaymentsController], providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}
