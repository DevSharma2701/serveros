import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { KitchenTicketStatus, OrderStatus, OrderType, Prisma } from '@prisma/client';
import { KITCHEN_ORDER_STATUSES, REALTIME_EVENTS, stationSchema, ticketItemSchema, ticketQuery, ticketStatusSchema, updateStationSchema } from '@serveos/shared';
import { createZodDto } from 'nestjs-zod';
import { Ctx, OutletScoped, RequirePermissions, type OutletContext } from '../common/context';
import { conflict, notFound } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { RealtimeGateway } from '../common/realtime.gateway';
import { SequenceService } from '../common/services';
import { businessDay } from '../common/util';

class TicketStatusDto extends createZodDto(ticketStatusSchema) {}
class TicketItemDto extends createZodDto(ticketItemSchema) {}
class TicketQueryDto extends createZodDto(ticketQuery) {}
class StationDto extends createZodDto(stationSchema) {}
class UpdateStationDto extends createZodDto(updateStationSchema) {}

const ticketInclude = {
  items: { orderBy: { id: 'asc' } },
  station: { select: { id: true, key: true, name: true } },
} satisfies Prisma.KitchenTicketInclude;

interface FireableItem {
  id: string;
  productName: string;
  variantName: string;
  quantity: number;
  notes: string;
  stationKey: string | null;
  modifiers: Array<{ optionName: string }>;
}

interface Actor {
  userId: string;
  userName: string;
}

@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequenceService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Creates one kitchen ticket per station for items not yet sent to the kitchen.
   * Items route by their station key; anything unrouted goes to the outlet's default station.
   */
  async fire(
    tx: Tx,
    order: { id: string; restaurantId: string; outletId: string; type: OrderType; orderNumber: string; tableLabel: string; notes: string },
    items: FireableItem[],
    timezone: string,
  ): Promise<number> {
    if (items.length === 0) return 0;
    const stations = await tx.kitchenStation.findMany({ where: { outletId: order.outletId, isActive: true }, orderBy: { sortOrder: 'asc' } });
    const fallback = stations.find((s) => s.isDefault) ?? stations[0];
    if (!fallback) throw conflict('NO_KITCHEN_STATION', 'This outlet has no kitchen station. Add one in Kitchen settings.');

    const byStation = new Map<string, FireableItem[]>();
    for (const item of items) {
      const station = stations.find((s) => s.key === item.stationKey) ?? fallback;
      byStation.set(station.id, [...(byStation.get(station.id) ?? []), item]);
    }
    const day = businessDay(new Date(), timezone);
    for (const [stationId, stationItems] of byStation) {
      const seq = await this.sequences.next(tx, order.outletId, 'KOT', day);
      await tx.kitchenTicket.create({
        data: {
          restaurantId: order.restaurantId,
          outletId: order.outletId,
          orderId: order.id,
          stationId,
          ticketNumber: `K${String(seq).padStart(4, '0')}`,
          orderType: order.type,
          orderNumber: order.orderNumber,
          tableLabel: order.tableLabel,
          notes: order.notes,
          items: {
            create: stationItems.map((i) => ({
              orderItemId: i.id,
              name: i.variantName && i.variantName !== 'Regular' ? `${i.productName} (${i.variantName})` : i.productName,
              quantity: i.quantity,
              modifiers: i.modifiers.map((m) => m.optionName).join(', '),
              notes: i.notes,
            })),
          },
        },
      });
    }
    await tx.orderItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { sentToKitchenAt: new Date() } });
    return byStation.size;
  }

  /**
   * Derives the order's kitchen status from its tickets and records the change:
   * all ready -> READY, some started -> PREPARING, none started -> CONFIRMED.
   */
  async syncOrderStatus(tx: Tx, orderId: string, actor: Actor): Promise<OrderStatus> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    if (!KITCHEN_ORDER_STATUSES.includes(order.status)) return order.status;
    const tickets = await tx.kitchenTicket.findMany({ where: { orderId, status: { not: 'CANCELLED' } }, select: { status: true } });
    let next: OrderStatus = 'CONFIRMED';
    if (tickets.length > 0 && tickets.every((t) => t.status === 'READY')) next = 'READY';
    else if (tickets.some((t) => t.status !== 'PENDING')) next = 'PREPARING';
    if (next === order.status) return next;
    await tx.order.update({ where: { id: orderId }, data: { status: next, version: { increment: 1 } } });
    await tx.orderEvent.create({
      data: { orderId, type: 'STATUS_CHANGED', fromStatus: order.status, toStatus: next, actorId: actor.userId, actorName: actor.userName, message: 'Kitchen update' },
    });
    return next;
  }

  /** Removes voided items from their tickets; a ticket with nothing left is cancelled. */
  async cancelItems(tx: Tx, orderItemIds: string[]): Promise<void> {
    if (orderItemIds.length === 0) return;
    const affected = await tx.kitchenTicketItem.findMany({ where: { orderItemId: { in: orderItemIds } }, select: { ticketId: true } });
    await tx.kitchenTicketItem.updateMany({ where: { orderItemId: { in: orderItemIds } }, data: { isCancelled: true } });
    for (const ticketId of new Set(affected.map((a) => a.ticketId))) {
      const remaining = await tx.kitchenTicketItem.findMany({ where: { ticketId, isCancelled: false } });
      if (remaining.length === 0) await tx.kitchenTicket.update({ where: { id: ticketId }, data: { status: 'CANCELLED' } });
      else if (remaining.every((i) => i.isPrepared)) await tx.kitchenTicket.updateMany({ where: { id: ticketId, status: { not: 'READY' } }, data: { status: 'READY', readyAt: new Date() } });
    }
  }

  /** Closes every open ticket of an order (cancelled order, or order served without the KDS). */
  async closeTickets(tx: Tx, orderId: string, to: 'READY' | 'CANCELLED'): Promise<void> {
    await tx.kitchenTicket.updateMany({
      where: { orderId, status: { in: ['PENDING', 'PREPARING'] } },
      data: to === 'READY' ? { status: 'READY', readyAt: new Date() } : { status: 'CANCELLED' },
    });
  }

  /** Order-line ids whose preparation has not started, i.e. stock can still be put back. */
  async unstartedItemIds(tx: Tx, orderItemIds: string[]): Promise<Set<string>> {
    const rows = await tx.kitchenTicketItem.findMany({
      where: { orderItemId: { in: orderItemIds }, isPrepared: false, ticket: { status: 'PENDING' } },
      select: { orderItemId: true },
    });
    return new Set(rows.map((r) => r.orderItemId));
  }

  // ── KDS API ──

  tickets(ctx: OutletContext, q: TicketQueryDto) {
    const where: Prisma.KitchenTicketWhereInput =
      q.scope === 'active'
        ? { status: { in: ['PENDING', 'PREPARING'] } }
        : { status: 'READY', readyAt: { gte: new Date(Date.now() - 2 * 3600_000) } };
    return this.prisma.kitchenTicket.findMany({
      where: { ...where, restaurantId: ctx.restaurantId, outletId: ctx.outletId, ...(q.stationId ? { stationId: q.stationId } : {}) },
      orderBy: q.scope === 'active' ? { firedAt: 'asc' } : { readyAt: 'desc' },
      take: 200,
      include: ticketInclude,
    });
  }

  private async ticketFor(tx: Tx, ctx: OutletContext, id: string) {
    const ticket = await tx.kitchenTicket.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId }, include: { order: { select: { status: true } } } });
    if (!ticket) throw notFound('Kitchen ticket');
    if (ticket.status === 'CANCELLED' || !KITCHEN_ORDER_STATUSES.includes(ticket.order.status)) {
      throw conflict('TICKET_CLOSED', 'This ticket belongs to an order that is already closed');
    }
    return ticket;
  }

  private broadcast(outletId: string, ticketId: string, orderId: string): void {
    this.realtime.emit(outletId, REALTIME_EVENTS.ticketChanged, { ticketId, orderId });
    this.realtime.emit(outletId, REALTIME_EVENTS.orderChanged, { orderId });
  }

  async setStatus(ctx: OutletContext, id: string, status: Exclude<KitchenTicketStatus, 'CANCELLED'>) {
    const result = await this.prisma.tx(async (tx) => {
      const ticket = await this.ticketFor(tx, ctx, id);
      if (ticket.status !== status) {
        const now = new Date();
        await tx.kitchenTicket.update({
          where: { id },
          data: {
            status,
            startedAt: status === 'PENDING' ? null : (ticket.startedAt ?? now),
            readyAt: status === 'READY' ? now : null,
          },
        });
        if (status === 'READY') await tx.kitchenTicketItem.updateMany({ where: { ticketId: id, isCancelled: false, isPrepared: false }, data: { isPrepared: true, preparedAt: now } });
        if (status === 'PENDING') await tx.kitchenTicketItem.updateMany({ where: { ticketId: id }, data: { isPrepared: false, preparedAt: null } });
        await this.syncOrderStatus(tx, ticket.orderId, ctx);
      }
      return tx.kitchenTicket.findUniqueOrThrow({ where: { id }, include: ticketInclude });
    });
    this.broadcast(ctx.outletId, id, result.orderId);
    return result;
  }

  async setItemPrepared(ctx: OutletContext, ticketId: string, itemId: string, isPrepared: boolean) {
    const result = await this.prisma.tx(async (tx) => {
      const ticket = await this.ticketFor(tx, ctx, ticketId);
      const updated = await tx.kitchenTicketItem.updateMany({
        where: { id: itemId, ticketId, isCancelled: false },
        data: { isPrepared, preparedAt: isPrepared ? new Date() : null },
      });
      if (updated.count === 0) throw notFound('Ticket item');
      const items = await tx.kitchenTicketItem.findMany({ where: { ticketId, isCancelled: false } });
      const allDone = items.every((i) => i.isPrepared);
      const status: KitchenTicketStatus = allDone ? 'READY' : items.some((i) => i.isPrepared) || ticket.status !== 'PENDING' ? 'PREPARING' : 'PENDING';
      if (status !== ticket.status) {
        const now = new Date();
        await tx.kitchenTicket.update({ where: { id: ticketId }, data: { status, startedAt: ticket.startedAt ?? now, readyAt: allDone ? now : null } });
        await this.syncOrderStatus(tx, ticket.orderId, ctx);
      }
      return tx.kitchenTicket.findUniqueOrThrow({ where: { id: ticketId }, include: ticketInclude });
    });
    this.broadcast(ctx.outletId, ticketId, result.orderId);
    return result;
  }

  stations(ctx: OutletContext) {
    return this.prisma.kitchenStation.findMany({ where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  async saveStation(ctx: OutletContext, id: string | null, dto: UpdateStationDto & Partial<StationDto>) {
    return this.prisma.tx(async (tx) => {
      if (id && !(await tx.kitchenStation.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId } }))) throw notFound('Kitchen station');
      // Exactly one station is the default; choosing a new one releases the old one.
      if (dto.isDefault) await tx.kitchenStation.updateMany({ where: { outletId: ctx.outletId }, data: { isDefault: false } });
      const saved = id
        ? await tx.kitchenStation.update({ where: { id }, data: dto })
        : await tx.kitchenStation.create({ data: { ...(dto as StationDto), restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
      const usable = await tx.kitchenStation.count({ where: { outletId: ctx.outletId, isActive: true, isDefault: true } });
      if (usable === 0) throw conflict('DEFAULT_STATION_REQUIRED', 'An outlet needs one active default station to receive unrouted items');
      return saved;
    });
  }
}

@ApiTags('Kitchen')
@ApiBearerAuth()
@OutletScoped()
@Controller('kitchen')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get('tickets')
  @RequirePermissions('kitchen.view')
  tickets(@Ctx() ctx: OutletContext, @Query() q: TicketQueryDto) {
    return this.kitchen.tickets(ctx, q);
  }

  @Patch('tickets/:id')
  @RequirePermissions('kitchen.update')
  setStatus(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketStatusDto) {
    return this.kitchen.setStatus(ctx, id, dto.status);
  }

  @Patch('tickets/:id/items/:itemId')
  @RequirePermissions('kitchen.update')
  setItemPrepared(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: TicketItemDto) {
    return this.kitchen.setItemPrepared(ctx, id, itemId, dto.isPrepared);
  }

  @Get('stations')
  @RequirePermissions('kitchen.view')
  stations(@Ctx() ctx: OutletContext) {
    return this.kitchen.stations(ctx);
  }

  @Post('stations')
  @RequirePermissions('kitchen.manage')
  createStation(@Ctx() ctx: OutletContext, @Body() dto: StationDto) {
    return this.kitchen.saveStation(ctx, null, dto);
  }

  @Patch('stations/:id')
  @RequirePermissions('kitchen.manage')
  updateStation(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStationDto) {
    return this.kitchen.saveStation(ctx, id, dto);
  }
}

@Module({ controllers: [KitchenController], providers: [KitchenService], exports: [KitchenService] })
export class KitchenModule {}
