import { CanActivate, ExecutionContext, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { PermissionKey } from '@serveos/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { syncAccessCatalogue } from './access-catalogue';
import { ALLOW_PLATFORM, can, IS_PUBLIC, OUTLET_SCOPED, PERMISSIONS_KEY, type RequestContext } from './context';
import { badRequest, forbidden, unauthorized } from './errors';
import { PrismaService } from './prisma.service';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
}

@Injectable()
export class AccessService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async onModuleInit(): Promise<void> {
    await syncAccessCatalogue(this.prisma);
  }

  signAccessToken(userId: string, sessionId: string): { accessToken: string; expiresIn: number } {
    const expiresIn = 15 * 60;
    const payload: AccessTokenPayload = { sub: userId, sid: sessionId };
    return { accessToken: this.jwt.sign(payload, { secret: env.JWT_ACCESS_SECRET, expiresIn }), expiresIn };
  }

  /**
   * Verifies an access token and loads the caller's current rights from the database, so a
   * revoked session, disabled user or changed role takes effect on the very next request.
   */
  async authenticate(token: string): Promise<Omit<RequestContext, 'outletId' | 'ip' | 'correlationId'>> {
    let payload: AccessTokenPayload;
    try {
      payload = this.jwt.verify<AccessTokenPayload>(token, { secret: env.JWT_ACCESS_SECRET });
    } catch {
      throw unauthorized('Your session has expired. Sign in again.');
    }
    const session = await this.prisma.userSession.findUnique({
      where: { id: payload.sid },
      include: {
        user: {
          include: {
            role: { include: { permissions: true } },
            grants: true,
            assignments: true,
            restaurant: { select: { isActive: true, outlets: { where: { isActive: true }, select: { id: true } } } },
          },
        },
      },
    });
    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt < new Date()) {
      throw unauthorized('Your session has ended. Sign in again.');
    }
    const user = session.user;
    if (user.status !== 'ACTIVE') throw unauthorized('This account is not active.');
    if (user.restaurant && !user.restaurant.isActive) throw forbidden('This restaurant account is suspended.');

    const restaurantOutlets = user.restaurant?.outlets.map((o) => o.id) ?? [];
    const assigned = new Set(user.assignments.map((a) => a.outletId));
    const outletIds = user.allOutlets ? restaurantOutlets : restaurantOutlets.filter((id) => assigned.has(id));

    const permissions = new Set<string>(user.role.permissions.map((p) => p.permissionKey));
    const outletPermissions = new Map<string, Set<string>>();
    for (const grant of user.grants) {
      if (grant.outletId == null) permissions.add(grant.permissionKey);
      else if (outletIds.includes(grant.outletId)) {
        if (!outletPermissions.has(grant.outletId)) outletPermissions.set(grant.outletId, new Set());
        outletPermissions.get(grant.outletId)!.add(grant.permissionKey);
      }
    }
    const isPlatformAdmin = user.restaurantId == null;
    if (!isPlatformAdmin) permissions.delete('platform.manage');

    return {
      userId: user.id,
      userName: user.name,
      sessionId: session.id,
      restaurantId: user.restaurantId ?? '',
      isPlatformAdmin,
      roleKey: user.role.key,
      roleRank: user.role.rank,
      permissions,
      outletPermissions,
      outletIds,
      allOutlets: user.allOutlets,
    };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger('AuthGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
  ) {}

  async canActivate(host: ExecutionContext): Promise<boolean> {
    if (host.getType() !== 'http') return true; // sockets authenticate in the gateway
    const targets = [host.getHandler(), host.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = host.switchToHttp().getRequest<Request & { auth?: RequestContext; id?: string }>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw unauthorized();
    const base = await this.access.authenticate(header.slice(7));

    let outletId: string | null = null;
    const requested = req.headers['x-outlet-id'];
    if (typeof requested === 'string' && requested !== '') {
      if (!z.uuid().safeParse(requested).success) throw badRequest('INVALID_OUTLET', 'X-Outlet-Id is not a valid id');
      // Same answer for "does not exist" and "not yours", so outlet ids cannot be probed.
      if (!base.outletIds.includes(requested)) throw forbidden('You are not assigned to this outlet');
      outletId = requested;
    }
    const ctx: RequestContext = { ...base, outletId, ip: req.ip ?? '', correlationId: String(req.id ?? '') };

    if (ctx.isPlatformAdmin && !this.reflector.getAllAndOverride<boolean>(ALLOW_PLATFORM, targets)) {
      throw forbidden('Platform admins cannot access restaurant data');
    }
    if (this.reflector.getAllAndOverride<boolean>(OUTLET_SCOPED, targets) && !outletId) {
      throw badRequest('OUTLET_REQUIRED', 'Select an outlet first (X-Outlet-Id header)');
    }
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, targets) ?? [];
    const missing = required.filter((p) => !can(ctx, p));
    if (missing.length > 0) {
      this.logger.warn({ userId: ctx.userId, missing, path: req.url }, 'permission denied');
      throw forbidden();
    }
    req.auth = ctx;
    return true;
  }
}
