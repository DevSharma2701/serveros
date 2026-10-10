import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { auditQuery, grantPermissionSchema, inviteStaffSchema, scheduleSchema, updateStaffSchema, type PermissionKey } from '@serveos/shared';
import { createZodDto } from 'nestjs-zod';
import { can, Ctx, OutletScoped, RequirePermissions, type OutletContext, type RequestContext } from '../common/context';
import { badRequest, conflict, forbidden, notFound } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/services';
import { paged, paginate } from '../common/util';
import { AuthModule, AuthService } from './auth.module';

class InviteStaffDto extends createZodDto(inviteStaffSchema) {}
class UpdateStaffDto extends createZodDto(updateStaffSchema) {}
class GrantPermissionDto extends createZodDto(grantPermissionSchema) {}
class ScheduleDto extends createZodDto(scheduleSchema) {}
class AuditQueryDto extends createZodDto(auditQuery) {}

const staffInclude = {
  role: { select: { id: true, key: true, name: true, rank: true } },
  assignments: { select: { outletId: true } },
  grants: { select: { id: true, permissionKey: true, outletId: true } },
} as const;

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  private present<T extends { passwordHash: string | null; failedLoginCount: number; lockedUntil: Date | null }>(user: T) {
    const { passwordHash: _hash, failedLoginCount: _failed, lockedUntil: _locked, ...safe } = user;
    return safe;
  }

  roles(ctx: RequestContext) {
    return this.prisma.role.findMany({
      where: { OR: [{ restaurantId: null }, { restaurantId: ctx.restaurantId }], key: { not: 'PLATFORM_ADMIN' } },
      orderBy: { rank: 'desc' },
      include: { permissions: { select: { permissionKey: true } } },
    });
  }

  async list(ctx: RequestContext) {
    const users = await this.prisma.user.findMany({ where: { restaurantId: ctx.restaurantId }, orderBy: { name: 'asc' }, include: staffInclude });
    return users.map((u) => this.present(u));
  }

  /** A role may be handed out only if it ranks strictly below the caller's own role. */
  private async assignableRole(ctx: RequestContext, roleId: string) {
    const role = await this.prisma.role.findFirst({ where: { id: roleId, OR: [{ restaurantId: null }, { restaurantId: ctx.restaurantId }] } });
    if (!role || role.key === 'PLATFORM_ADMIN') throw notFound('Role');
    if (role.rank >= ctx.roleRank) throw forbidden('You can only assign roles below your own');
    return role;
  }

  /** Outlets may be handed out only if they belong to this restaurant and the caller has them too. */
  private assertOutlets(ctx: RequestContext, outletIds: string[], allOutlets: boolean): void {
    if (allOutlets && !ctx.allOutlets) throw forbidden('You cannot give access to all outlets');
    if (outletIds.some((id) => !ctx.outletIds.includes(id))) throw forbidden('You can only assign outlets you have access to');
  }

  private async manageable(ctx: RequestContext, userId: string) {
    const target = await this.prisma.user.findFirst({ where: { id: userId, restaurantId: ctx.restaurantId }, include: staffInclude });
    if (!target) throw notFound('Staff member');
    if (target.id === ctx.userId) throw forbidden('You cannot change your own access');
    if (target.role.rank >= ctx.roleRank) throw forbidden('You can only manage staff with a role below your own');
    return target;
  }

  async invite(ctx: RequestContext, dto: InviteStaffDto) {
    const role = await this.assignableRole(ctx, dto.roleId);
    this.assertOutlets(ctx, dto.outletIds, dto.allOutlets);
    if (await this.prisma.user.findUnique({ where: { email: dto.email } })) throw conflict('EMAIL_IN_USE', 'A user with this email already exists');
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } });
    const user = await this.prisma.tx(async (tx) => {
      const created = await tx.user.create({
        data: {
          restaurantId: ctx.restaurantId,
          roleId: role.id,
          email: dto.email,
          name: dto.name,
          phone: dto.phone,
          employeeCode: dto.employeeCode,
          jobTitle: dto.jobTitle,
          allOutlets: dto.allOutlets,
          assignments: { create: dto.outletIds.map((outletId) => ({ outletId })) },
        },
        include: staffInclude,
      });
      await this.audit.log(ctx, 'staff.invite', 'User', created.id, { email: dto.email, role: role.key }, tx);
      return created;
    });
    await this.auth.sendInvite(user, restaurant.name);
    return this.present(user);
  }

  async resendInvite(ctx: RequestContext, userId: string): Promise<void> {
    const target = await this.manageable(ctx, userId);
    if (target.status !== 'INVITED') throw badRequest('NOT_INVITED', 'This person has already activated their account');
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: ctx.restaurantId } });
    await this.auth.sendInvite(target, restaurant.name);
  }

  async update(ctx: RequestContext, userId: string, dto: UpdateStaffDto) {
    const target = await this.manageable(ctx, userId);
    const { outletIds, roleId, status, ...profile } = dto;
    const role = roleId ? await this.assignableRole(ctx, roleId) : null;
    if (outletIds || dto.allOutlets != null) this.assertOutlets(ctx, outletIds ?? [], dto.allOutlets ?? false);
    if (status === 'ACTIVE' && target.status === 'INVITED') throw badRequest('NOT_ACTIVATED', 'This person must accept their invitation first');

    const user = await this.prisma.tx(async (tx) => {
      if (outletIds) {
        // Only touch outlets the caller controls; assignments to other outlets stay as they are.
        await tx.userOutletAssignment.deleteMany({ where: { userId, outletId: { in: ctx.outletIds, notIn: outletIds } } });
        await tx.userOutletAssignment.createMany({ data: outletIds.map((outletId) => ({ userId, outletId })), skipDuplicates: true });
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { ...profile, ...(role ? { roleId: role.id } : {}), ...(status ? { status } : {}) },
        include: staffInclude,
      });
      if (status === 'DISABLED' || role) {
        // Force a fresh sign-in so the old access cannot linger.
        await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'access_changed' } });
      }
      await this.audit.log(
        ctx,
        role && role.id !== target.roleId ? 'staff.role_change' : 'staff.update',
        'User',
        userId,
        { fields: Object.keys(dto), fromRole: target.role.key, toRole: role?.key ?? target.role.key, status: status ?? target.status },
        tx,
      );
      return updated;
    });
    return this.present(user);
  }

  async grant(ctx: RequestContext, userId: string, dto: GrantPermissionDto) {
    await this.manageable(ctx, userId);
    const key = dto.permissionKey as PermissionKey;
    // You cannot hand out a right you do not hold yourself, in the same scope.
    if (key === 'platform.manage' || !can(ctx, key, dto.outletId)) throw forbidden('You can only grant permissions you hold yourself');
    if (dto.outletId && !ctx.outletIds.includes(dto.outletId)) throw forbidden('You are not assigned to this outlet');
    const existing = await this.prisma.userPermissionGrant.findFirst({ where: { userId, permissionKey: key, outletId: dto.outletId } });
    if (existing) return existing;
    return this.prisma.tx(async (tx) => {
      const grant = await tx.userPermissionGrant.create({ data: { userId, permissionKey: key, outletId: dto.outletId, grantedById: ctx.userId } });
      await this.audit.log(ctx, 'staff.permission_grant', 'User', userId, { permission: key, outletId: dto.outletId }, tx);
      return grant;
    });
  }

  async revokeGrant(ctx: RequestContext, userId: string, grantId: string): Promise<void> {
    await this.manageable(ctx, userId);
    const grant = await this.prisma.userPermissionGrant.findFirst({ where: { id: grantId, userId } });
    if (!grant) throw notFound('Permission grant');
    await this.prisma.tx(async (tx) => {
      await tx.userPermissionGrant.delete({ where: { id: grantId } });
      await this.audit.log(ctx, 'staff.permission_revoke', 'User', userId, { permission: grant.permissionKey, outletId: grant.outletId }, tx);
    });
  }

  async revokeSessions(ctx: RequestContext, userId: string): Promise<void> {
    await this.manageable(ctx, userId);
    await this.auth.revokeAllSessions(userId, 'revoked_by_manager');
    await this.audit.log(ctx, 'staff.sessions_revoked', 'User', userId);
  }

  // ── Attendance and schedules ──

  async clockIn(ctx: OutletContext) {
    const open = await this.prisma.attendance.findFirst({ where: { userId: ctx.userId, clockOutAt: null } });
    if (open) throw conflict('ALREADY_CLOCKED_IN', 'You are already clocked in');
    return this.prisma.attendance.create({ data: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, userId: ctx.userId } });
  }

  async clockOut(ctx: RequestContext) {
    const open = await this.prisma.attendance.findFirst({ where: { userId: ctx.userId, clockOutAt: null } });
    if (!open) throw conflict('NOT_CLOCKED_IN', 'You are not clocked in');
    return this.prisma.attendance.update({ where: { id: open.id }, data: { clockOutAt: new Date() } });
  }

  async attendance(ctx: OutletContext) {
    const seesAll = can(ctx, 'staff.view');
    return this.prisma.attendance.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, ...(seesAll ? {} : { userId: ctx.userId }) },
      orderBy: { clockInAt: 'desc' },
      take: 200,
      include: { user: { select: { id: true, name: true } } },
    });
  }

  schedules(ctx: OutletContext) {
    return this.prisma.shiftSchedule.findMany({
      where: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, endsAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
      orderBy: { startsAt: 'asc' },
      take: 500,
      include: { user: { select: { id: true, name: true } } },
    });
  }

  async createSchedule(ctx: OutletContext, dto: ScheduleDto) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) throw badRequest('INVALID_RANGE', 'The shift must end after it starts');
    const user = await this.prisma.user.findFirst({
      where: { id: dto.userId, restaurantId: ctx.restaurantId, OR: [{ allOutlets: true }, { assignments: { some: { outletId: ctx.outletId } } }] },
    });
    if (!user) throw notFound('Staff member');
    return this.prisma.shiftSchedule.create({
      data: { restaurantId: ctx.restaurantId, outletId: ctx.outletId, userId: user.id, startsAt, endsAt, note: dto.note, createdById: ctx.userId },
    });
  }

  async deleteSchedule(ctx: OutletContext, id: string): Promise<void> {
    const result = await this.prisma.shiftSchedule.deleteMany({ where: { id, restaurantId: ctx.restaurantId, outletId: ctx.outletId } });
    if (result.count === 0) throw notFound('Scheduled shift');
  }

  async auditEvents(ctx: RequestContext, q: AuditQueryDto) {
    const where = {
      restaurantId: ctx.restaurantId,
      // Staff limited to some outlets see restaurant-wide events and those of their own outlets only.
      ...(ctx.allOutlets ? {} : { OR: [{ outletId: null }, { outletId: { in: ctx.outletIds } }] }),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q) }),
      this.prisma.auditEvent.count({ where }),
    ]);
    return paged(items, total, q);
  }
}

@ApiTags('Staff')
@ApiBearerAuth()
@Controller()
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get('roles')
  @RequirePermissions('staff.view')
  roles(@Ctx() ctx: RequestContext) {
    return this.staff.roles(ctx);
  }

  @Get('staff')
  @RequirePermissions('staff.view')
  list(@Ctx() ctx: RequestContext) {
    return this.staff.list(ctx);
  }

  @Post('staff')
  @RequirePermissions('staff.manage')
  invite(@Ctx() ctx: RequestContext, @Body() dto: InviteStaffDto) {
    return this.staff.invite(ctx, dto);
  }

  @Patch('staff/:id')
  @RequirePermissions('staff.manage')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStaffDto) {
    return this.staff.update(ctx, id, dto);
  }

  @Post('staff/:id/resend-invite')
  @HttpCode(204)
  @RequirePermissions('staff.manage')
  resend(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.resendInvite(ctx, id);
  }

  @Post('staff/:id/revoke-sessions')
  @HttpCode(204)
  @RequirePermissions('staff.manage')
  revokeSessions(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.revokeSessions(ctx, id);
  }

  @Post('staff/:id/grants')
  @RequirePermissions('staff.manage')
  grant(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: GrantPermissionDto) {
    return this.staff.grant(ctx, id, dto);
  }

  @Delete('staff/:id/grants/:grantId')
  @HttpCode(204)
  @RequirePermissions('staff.manage')
  revokeGrant(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('grantId', ParseUUIDPipe) grantId: string) {
    return this.staff.revokeGrant(ctx, id, grantId);
  }

  @Post('attendance/clock-in')
  @OutletScoped()
  clockIn(@Ctx() ctx: OutletContext) {
    return this.staff.clockIn(ctx);
  }

  @Post('attendance/clock-out')
  @HttpCode(200)
  clockOut(@Ctx() ctx: RequestContext) {
    return this.staff.clockOut(ctx);
  }

  @Get('attendance')
  @OutletScoped()
  attendance(@Ctx() ctx: OutletContext) {
    return this.staff.attendance(ctx);
  }

  @Get('schedules')
  @OutletScoped()
  schedules(@Ctx() ctx: OutletContext) {
    return this.staff.schedules(ctx);
  }

  @Post('schedules')
  @OutletScoped()
  @RequirePermissions('staff.manage')
  createSchedule(@Ctx() ctx: OutletContext, @Body() dto: ScheduleDto) {
    return this.staff.createSchedule(ctx, dto);
  }

  @Delete('schedules/:id')
  @HttpCode(204)
  @OutletScoped()
  @RequirePermissions('staff.manage')
  deleteSchedule(@Ctx() ctx: OutletContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.deleteSchedule(ctx, id);
  }

  @Get('audit-events')
  @RequirePermissions('audit.view')
  auditEvents(@Ctx() ctx: RequestContext, @Query() q: AuditQueryDto) {
    return this.staff.auditEvents(ctx, q);
  }
}

@Module({ imports: [AuthModule], controllers: [StaffController], providers: [StaffService] })
export class StaffModule {}
