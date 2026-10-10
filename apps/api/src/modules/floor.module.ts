import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  diningAreaSchema,
  REALTIME_EVENTS,
  reservationSchema,
  reservationStatusSchema,
  tableSchema,
  updateDiningAreaSchema,
  updateTableSchema,
} from '@serveos/shared';
import { createZodDto } from 'nestjs-zod';
import { Ctx, OutletScoped, RequirePermissions, type OutletContext } from '../common/context';
import { badRequest, conflict, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RealtimeGateway } from '../common/realtime.gateway';

class DiningAreaDto extends createZodDto(diningAreaSchema) {}
class UpdateDiningAreaDto extends createZodDto(updateDiningAreaSchema) {}
class TableDto extends createZodDto(tableSchema) {}
class UpdateTableDto extends createZodDto(updateTableSchema) {}
class ReservationDto extends createZodDto(reservationSchema) {}
class ReservationStatusDto extends createZodDto(reservationStatusSchema) {}

/** A booked table shows as reserved from this long before the booking starts. */
const RESERVATION_HOLD_MS = 60 * 60_000;

@Injectable()
export class FloorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private changed(outletId: string): void {
    this.realtime.emit(outletId, REALTIME_EVENTS.floorChanged);
  }

  /**
   * The floor plan with each table's status. Status is never stored: it is worked out from
   * the table's open order and its reservations, so it cannot drift out of step with them.
   *   OCCUPIED  - an open order holds the table, or paid guest (QR) orders are in progress on it
   *   RESERVED  - a booking starts within the next hour or is in progress
   *   AVAILABLE - neither
   */
  async plan(ctx: OutletContext) {
    const now = new Date();
    const areas = await this.prisma.diningArea.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        tables: {
          orderBy: { name: 'asc' },
          include: {
            orderTables: {
              where: { isActive: true },
              include: {
                order: {
                  select: {
                    id: true, orderNumber: true, status: true, isHeld: true, totalMinor: true, paymentStatus: true, createdAt: true, waiterId: true, guestCount: true,
                    _count: { select: { items: { where: { status: 'ACTIVE' } } } },
                  },
                },
              },
            },
            reservations: {
              where: { status: 'BOOKED', startsAt: { lte: new Date(now.getTime() + RESERVATION_HOLD_MS) }, endsAt: { gt: now } },
              orderBy: { startsAt: 'asc' },
              take: 1,
            },
          },
        },
      },
    });
    // Guest (QR) orders do not lock a table, but a table with paid guest orders in progress is in use.
    const guestOrders = await this.prisma.order.groupBy({
      by: ['guestTableId'],
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, source: 'QR', guestTableId: { not: null }, OR: [{ status: { in: ['CONFIRMED', 'PREPARING', 'READY'] } }, { status: 'PLACED', paidMinor: { gt: 0 } }] },
      _count: true,
    });
    const guestCount = new Map(guestOrders.map((g) => [g.guestTableId, g._count]));
    const waiterIds = new Set<string>();
    for (const a of areas) for (const t of a.tables) for (const id of [t.assignedWaiterId, t.orderTables[0]?.order.waiterId]) if (id) waiterIds.add(id);
    const waiters = await this.prisma.user.findMany({ where: { id: { in: [...waiterIds] } }, select: { id: true, name: true } });
    const nameOf = (id: string | null | undefined) => waiters.find((w) => w.id === id)?.name ?? null;

    return areas.map((area) => ({
      id: area.id,
      name: area.name,
      sortOrder: area.sortOrder,
      isActive: area.isActive,
      tables: area.tables.map(({ orderTables, reservations, qrToken: _secret, ...table }) => {
        const order = orderTables[0]?.order ?? null;
        const reservation = reservations[0] ?? null;
        return {
          ...table,
          status: order || guestCount.has(table.id) ? ('OCCUPIED' as const) : reservation ? ('RESERVED' as const) : ('AVAILABLE' as const),
          guestOrders: guestCount.get(table.id) ?? 0,
          assignedWaiterName: nameOf(table.assignedWaiterId),
          order: order && { ...order, itemCount: order._count.items, waiterName: nameOf(order.waiterId) },
          reservation: reservation && { id: reservation.id, guestName: reservation.guestName, partySize: reservation.partySize, startsAt: reservation.startsAt, endsAt: reservation.endsAt },
        };
      }),
    }));
  }

  async createArea(ctx: OutletContext, dto: DiningAreaDto) {
    const area = await this.prisma.diningArea.create({ data: { ...dto, restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
    this.changed(ctx.outletId);
    return area;
  }

  async updateArea(ctx: OutletContext, id: string, dto: UpdateDiningAreaDto) {
    if (!(await this.prisma.diningArea.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId } }))) throw notFound('Dining area');
    const area = await this.prisma.diningArea.update({ where: { id }, data: dto });
    this.changed(ctx.outletId);
    return area;
  }

  private async assertTableRefs(ctx: OutletContext, dto: UpdateTableDto): Promise<void> {
    if (dto.areaId && !(await this.prisma.diningArea.findFirst({ where: { id: dto.areaId, restaurantId: ctx.restaurantId, outletId: ctx.outletId } }))) throw notFound('Dining area');
    if (dto.assignedWaiterId) {
      const waiter = await this.prisma.user.findFirst({
        where: { id: dto.assignedWaiterId, restaurantId: ctx.restaurantId, status: 'ACTIVE', OR: [{ allOutlets: true }, { assignments: { some: { outletId: ctx.outletId } } }] },
      });
      if (!waiter) throw notFound('Staff member');
    }
  }

  async createTable(ctx: OutletContext, dto: TableDto) {
    await this.assertTableRefs(ctx, dto);
    const table = await this.prisma.restaurantTable.create({ data: { ...dto, restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
    this.changed(ctx.outletId);
    return table;
  }

  async updateTable(ctx: OutletContext, id: string, dto: UpdateTableDto) {
    const existing = await this.prisma.restaurantTable.findFirst({
      where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId },
      include: { orderTables: { where: { isActive: true } } },
    });
    if (!existing) throw notFound('Table');
    await this.assertTableRefs(ctx, dto);
    if (dto.isActive === false && existing.orderTables.length > 0) throw conflict('TABLE_OCCUPIED', 'A table with an open order cannot be deactivated');
    const table = await this.prisma.restaurantTable.update({ where: { id }, data: dto });
    this.changed(ctx.outletId);
    return table;
  }

  reservations(ctx: OutletContext) {
    return this.prisma.reservation.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, endsAt: { gte: new Date(Date.now() - 12 * 3600_000) } },
      orderBy: { startsAt: 'asc' },
      take: 300,
      include: { table: { select: { id: true, name: true } } },
    });
  }

  async createReservation(ctx: OutletContext, dto: ReservationDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) throw badRequest('INVALID_RANGE', 'The reservation must end after it starts');
    const table = await this.prisma.restaurantTable.findFirst({ where: { id: dto.tableId, restaurantId: ctx.restaurantId, outletId: ctx.outletId, isActive: true } });
    if (!table) throw notFound('Table');
    if (dto.partySize > table.capacity) throw badRequest('TABLE_TOO_SMALL', `Table ${table.name} seats ${table.capacity}`);
    const reservation = await this.prisma.tx(async (tx) => {
      // Lock the table row so two overlapping bookings cannot both pass the check below.
      await tx.$queryRaw`SELECT 1 FROM "RestaurantTable" WHERE "id" = ${table.id}::uuid FOR UPDATE`;
      const clash = await tx.reservation.findFirst({ where: { tableId: table.id, status: { in: ['BOOKED', 'SEATED'] }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } } });
      if (clash) throw conflict('TABLE_ALREADY_RESERVED', `Table ${table.name} is already reserved for ${clash.guestName} at that time`);
      return tx.reservation.create({
        data: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, tableId: table.id, guestName: dto.guestName, guestPhone: dto.guestPhone, partySize: dto.partySize, startsAt, endsAt, note: dto.note, createdById: ctx.userId },
      });
    });
    this.changed(ctx.outletId);
    return reservation;
  }

  async setReservationStatus(ctx: OutletContext, id: string, status: ReservationStatusDto['status']) {
    const existing = await this.prisma.reservation.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
    if (!existing) throw notFound('Reservation');
    if (['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(existing.status)) throw conflict('RESERVATION_CLOSED', 'This reservation is already closed');
    const reservation = await this.prisma.reservation.update({ where: { id }, data: { status } });
    this.changed(ctx.outletId);
    return reservation;
  }
}

@ApiTags('Floor')
@ApiBearerAuth()
@OutletScoped()
@Controller()
export class FloorController {
  constructor(private readonly floor: FloorService) {}

  @Get('floor')
  @RequirePermissions('table.view')
  plan(@Ctx() ctx: OutletContext) {
    return this.floor.plan(ctx);
  }

  @Post('dining-areas')
  @RequirePermissions('table.manage')
  createArea(@Ctx() ctx: OutletContext, @Body() dto: DiningAreaDto) {
    return this.floor.createArea(ctx, dto);
  }

  @Patch('dining-areas/:id')
  @RequirePermissions('table.manage')
  updateArea(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDiningAreaDto) {
    return this.floor.updateArea(ctx, id, dto);
  }

  @Post('tables')
  @RequirePermissions('table.manage')
  createTable(@Ctx() ctx: OutletContext, @Body() dto: TableDto) {
    return this.floor.createTable(ctx, dto);
  }

  @Patch('tables/:id')
  @RequirePermissions('table.manage')
  updateTable(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTableDto) {
    return this.floor.updateTable(ctx, id, dto);
  }

  @Get('reservations')
  @RequirePermissions('table.view')
  reservations(@Ctx() ctx: OutletContext) {
    return this.floor.reservations(ctx);
  }

  @Post('reservations')
  @RequirePermissions('reservation.manage')
  createReservation(@Ctx() ctx: OutletContext, @Body() dto: ReservationDto) {
    return this.floor.createReservation(ctx, dto);
  }

  @Patch('reservations/:id')
  @RequirePermissions('reservation.manage')
  setReservationStatus(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReservationStatusDto) {
    return this.floor.setReservationStatus(ctx, id, dto.status);
  }
}

@Module({ controllers: [FloorController], providers: [FloorService] })
export class FloorModule {}
