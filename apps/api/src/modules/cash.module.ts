import { Body, Controller, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { CashMovementType, Prisma } from '@prisma/client';
import { cashMovementSchema, closeShiftSchema, openShiftSchema, registerSchema, updateRegisterSchema } from '@serveos/shared';
import { createZodDto } from 'nestjs-zod';
import { can, Ctx, OutletScoped, RequirePermissions, type OutletContext } from '../common/context';
import { conflict, forbidden, notFound } from '../common/errors';
import { PrismaService, type Tx } from '../common/prisma.service';
import { AuditService } from '../common/services';

class RegisterDto extends createZodDto(registerSchema) {}
class UpdateRegisterDto extends createZodDto(updateRegisterSchema) {}
class OpenShiftDto extends createZodDto(openShiftSchema) {}
class CashMovementDto extends createZodDto(cashMovementSchema) {}
class CloseShiftDto extends createZodDto(closeShiftSchema) {}

type Db = Tx | PrismaService;

@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The open shift the current user is running in the selected outlet, if any. */
  openShiftOf(db: Db, ctx: OutletContext) {
    return db.cashShift.findFirst({ where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, openedById: ctx.userId, status: 'OPEN' } });
  }

  /**
   * Adds a row to the cash drawer ledger. The shift row is locked and must still be OPEN,
   * so nothing can be posted to a shift while (or after) it is being closed.
   */
  async recordMovement(tx: Tx, shiftId: string, m: { type: CashMovementType; amountMinor: number; reason?: string; paymentId?: string; refundId?: string; actorId: string }): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "CashShift" WHERE "id" = ${shiftId}::uuid FOR UPDATE`;
    if (rows[0]?.status !== 'OPEN') throw conflict('SHIFT_CLOSED', 'This cash shift is closed');
    await tx.cashMovement.create({
      data: { shiftId, type: m.type, amountMinor: m.amountMinor, reason: m.reason ?? '', paymentId: m.paymentId ?? null, refundId: m.refundId ?? null, createdById: m.actorId },
    });
  }

  /**
   * Reconciliation for a shift.
   * Expected cash = opening float + every cash movement (cash sales, cash refunds, cash in/out, petty cash).
   * Card, UPI and other digital payments are listed by method but are never counted as cash.
   */
  async summary(db: Db, shiftId: string) {
    const [shift, movements, payments, refunds] = await Promise.all([
      db.cashShift.findUniqueOrThrow({ where: { id: shiftId }, include: { register: { select: { name: true } } } }),
      db.cashMovement.findMany({ where: { shiftId }, orderBy: { createdAt: 'asc' } }),
      db.payment.groupBy({ by: ['method'], where: { shiftId, state: 'SUCCEEDED' }, _sum: { amountMinor: true }, _count: true }),
      db.refund.findMany({ where: { shiftId }, include: { payment: { select: { method: true } } } }),
    ]);
    const byType: Record<string, number> = { SALE: 0, REFUND: 0, CASH_IN: 0, CASH_OUT: 0, PETTY_CASH: 0 };
    for (const m of movements) byType[m.type] = (byType[m.type] ?? 0) + m.amountMinor;
    const expectedCashMinor = shift.openingFloatMinor + movements.reduce((a, m) => a + m.amountMinor, 0);
    const refundByMethod = new Map<string, number>();
    for (const r of refunds) refundByMethod.set(r.payment.method, (refundByMethod.get(r.payment.method) ?? 0) + r.amountMinor);
    const methods = new Set([...payments.map((p) => p.method as string), ...refundByMethod.keys()]);
    return {
      shift,
      cash: { openingFloatMinor: shift.openingFloatMinor, salesMinor: byType.SALE!, refundsMinor: byType.REFUND!, cashInMinor: byType.CASH_IN!, cashOutMinor: byType.CASH_OUT!, pettyCashMinor: byType.PETTY_CASH!, expectedCashMinor },
      byMethod: [...methods].sort().map((method) => {
        const paid = payments.find((p) => p.method === method);
        const refunded = refundByMethod.get(method) ?? 0;
        return { method, count: paid?._count ?? 0, collectedMinor: paid?._sum.amountMinor ?? 0, refundedMinor: refunded, netMinor: (paid?._sum.amountMinor ?? 0) - refunded };
      }),
      movements,
    };
  }

  // ── Registers ──

  registers(ctx: OutletContext) {
    return this.prisma.cashRegister.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId },
      orderBy: { name: 'asc' },
      include: { shifts: { where: { status: 'OPEN' }, select: { id: true, openedById: true, openedByName: true, openedAt: true } } },
    });
  }

  createRegister(ctx: OutletContext, dto: RegisterDto) {
    return this.prisma.cashRegister.create({ data: { ...dto, restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
  }

  async updateRegister(ctx: OutletContext, id: string, dto: UpdateRegisterDto) {
    const register = await this.prisma.cashRegister.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId }, include: { shifts: { where: { status: 'OPEN' } } } });
    if (!register) throw notFound('Cash register');
    if (dto.isActive === false && register.shifts.length > 0) throw conflict('SHIFT_OPEN', 'Close the open shift before deactivating this register');
    return this.prisma.cashRegister.update({ where: { id }, data: dto });
  }

  // ── Shifts ──

  async current(ctx: OutletContext) {
    const shift = await this.openShiftOf(this.prisma, ctx);
    return shift ? this.summary(this.prisma, shift.id) : null;
  }

  async open(ctx: OutletContext, dto: OpenShiftDto) {
    const register = await this.prisma.cashRegister.findFirst({ where: { id: dto.registerId, restaurantId: ctx.restaurantId, outletId: ctx.outletId, isActive: true } });
    if (!register) throw notFound('Cash register');
    if (await this.openShiftOf(this.prisma, ctx)) throw conflict('SHIFT_ALREADY_OPEN', 'You already have an open shift. Close it first.');
    if (await this.prisma.cashShift.findFirst({ where: { registerId: register.id, status: 'OPEN' } })) {
      throw conflict('REGISTER_IN_USE', `${register.name} already has an open shift`);
    }
    try {
      const shift = await this.prisma.tx(async (tx) => {
        const created = await tx.cashShift.create({
          data: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, registerId: register.id, openedById: ctx.userId, openedByName: ctx.userName, openingFloatMinor: dto.openingFloatMinor },
        });
        await this.audit.log(ctx, 'shift.open', 'CashShift', created.id, { register: register.name, openingFloatMinor: dto.openingFloatMinor }, tx);
        return created;
      });
      return this.summary(this.prisma, shift.id);
    } catch (e) {
      // The partial unique index is the final guard if two people open the same register at once.
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') throw conflict('REGISTER_IN_USE', `${register.name} already has an open shift`);
      throw e;
    }
  }

  private async manageable(db: Db, ctx: OutletContext, id: string) {
    const shift = await db.cashShift.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
    if (!shift) throw notFound('Cash shift');
    if (shift.openedById !== ctx.userId && !can(ctx, 'shift.manage')) throw forbidden("You cannot operate another person's shift");
    return shift;
  }

  async addMovement(ctx: OutletContext, id: string, dto: CashMovementDto) {
    await this.prisma.tx(async (tx) => {
      await this.manageable(tx, ctx, id);
      const amountMinor = dto.type === 'CASH_IN' ? dto.amountMinor : -dto.amountMinor;
      await this.recordMovement(tx, id, { type: dto.type, amountMinor, reason: dto.reason, actorId: ctx.userId });
      await this.audit.log(ctx, `shift.${dto.type.toLowerCase()}`, 'CashShift', id, { amountMinor: dto.amountMinor, reason: dto.reason }, tx);
    });
    return this.summary(this.prisma, id);
  }

  /**
   * Closes a shift: compares counted cash with expected cash and stores the variance. A variance
   * above the restaurant's threshold must be closed by someone allowed to approve it.
   * A closed shift is final; nothing can be added to or changed on it afterwards.
   */
  async close(ctx: OutletContext, id: string, dto: CloseShiftDto) {
    await this.prisma.tx(async (tx) => {
      await this.manageable(tx, ctx, id);
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "CashShift" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (rows[0]?.status !== 'OPEN') throw conflict('SHIFT_CLOSED', 'This cash shift is already closed');
      const { cash } = await this.summary(tx, id);
      const varianceMinor = dto.countedCashMinor - cash.expectedCashMinor;
      const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId }, select: { cashVarianceApprovalThresholdMinor: true } });
      const needsApproval = Math.abs(varianceMinor) > restaurant.cashVarianceApprovalThresholdMinor;
      if (needsApproval && !can(ctx, 'shift.approve_variance')) {
        throw conflict('VARIANCE_NEEDS_APPROVAL', 'The counted cash differs too much from the expected amount. Recount, or ask a manager to close this shift.', { varianceMinor });
      }
      await tx.cashShift.update({
        where: { id },
        data: {
          status: 'CLOSED', closedAt: new Date(), closedById: ctx.userId, expectedCashMinor: cash.expectedCashMinor, countedCashMinor: dto.countedCashMinor,
          varianceMinor, varianceApprovedById: needsApproval ? ctx.userId : null, closeNote: dto.note,
        },
      });
      await this.audit.log(ctx, 'shift.close', 'CashShift', id, { expectedCashMinor: cash.expectedCashMinor, countedCashMinor: dto.countedCashMinor, varianceMinor, approved: needsApproval }, tx);
    });
    return this.summary(this.prisma, id);
  }

  list(ctx: OutletContext) {
    return this.prisma.cashShift.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, ...(can(ctx, 'shift.view_all') ? {} : { openedById: ctx.userId }) },
      orderBy: { openedAt: 'desc' },
      take: 100,
      include: { register: { select: { name: true } } },
    });
  }

  async detail(ctx: OutletContext, id: string) {
    const shift = await this.prisma.cashShift.findFirst({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
    if (!shift) throw notFound('Cash shift');
    if (shift.openedById !== ctx.userId && !can(ctx, 'shift.view_all')) throw forbidden();
    return this.summary(this.prisma, id);
  }
}

@ApiTags('Cash')
@ApiBearerAuth()
@OutletScoped()
@Controller()
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Get('registers')
  @RequirePermissions('shift.operate')
  registers(@Ctx() ctx: OutletContext) {
    return this.cash.registers(ctx);
  }

  @Post('registers')
  @RequirePermissions('shift.manage')
  createRegister(@Ctx() ctx: OutletContext, @Body() dto: RegisterDto) {
    return this.cash.createRegister(ctx, dto);
  }

  @Patch('registers/:id')
  @RequirePermissions('shift.manage')
  updateRegister(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRegisterDto) {
    return this.cash.updateRegister(ctx, id, dto);
  }

  @Get('shifts/current')
  @RequirePermissions('shift.operate')
  current(@Ctx() ctx: OutletContext) {
    return this.cash.current(ctx);
  }

  @Get('shifts')
  @RequirePermissions('shift.operate')
  list(@Ctx() ctx: OutletContext) {
    return this.cash.list(ctx);
  }

  @Get('shifts/:id')
  @RequirePermissions('shift.operate')
  detail(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.detail(ctx, id);
  }

  @Post('shifts/open')
  @RequirePermissions('shift.operate')
  open(@Ctx() ctx: OutletContext, @Body() dto: OpenShiftDto) {
    return this.cash.open(ctx, dto);
  }

  @Post('shifts/:id/movements')
  @RequirePermissions('shift.operate')
  addMovement(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CashMovementDto) {
    return this.cash.addMovement(ctx, id, dto);
  }

  @Post('shifts/:id/close')
  @HttpCode(200)
  @RequirePermissions('shift.operate')
  close(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseShiftDto) {
    return this.cash.close(ctx, id, dto);
  }
}

@Module({ controllers: [CashController], providers: [CashService], exports: [CashService] })
export class CashModule {}
