import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@serveos/shared';
import { forbidden } from './errors';

/** Who is calling and what they may touch. Built by AuthGuard from the database, never from the request body. */
export interface RequestContext {
  userId: string;
  userName: string;
  sessionId: string;
  /** Empty string for platform admins, who may only call endpoints marked @AllowPlatform. */
  restaurantId: string;
  isPlatformAdmin: boolean;
  roleKey: string;
  roleRank: number;
  /** Permissions from the role plus restaurant-wide grants. */
  permissions: Set<string>;
  /** Extra permissions granted for a single outlet. */
  outletPermissions: Map<string, Set<string>>;
  /** Outlets this user may act in. */
  outletIds: string[];
  /** True when the user is allowed in every outlet of the restaurant, including future ones. */
  allOutlets: boolean;
  /** The outlet selected with the X-Outlet-Id header, already verified against outletIds. */
  outletId: string | null;
  ip: string;
  correlationId: string;
}
export type OutletContext = RequestContext & { outletId: string };

export function can(ctx: RequestContext, permission: PermissionKey, outletId: string | null = ctx.outletId): boolean {
  return ctx.permissions.has(permission) || (outletId != null && (ctx.outletPermissions.get(outletId)?.has(permission) ?? false));
}

export function assertCan(ctx: RequestContext, permission: PermissionKey, message?: string): void {
  if (!can(ctx, permission)) throw forbidden(message);
}

export const IS_PUBLIC = 'serveos:public';
export const PERMISSIONS_KEY = 'serveos:permissions';
export const OUTLET_SCOPED = 'serveos:outlet';
export const ALLOW_PLATFORM = 'serveos:platform';

/** No authentication needed (login, health checks, signed webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Caller needs every listed permission. */
export const RequirePermissions = (...permissions: PermissionKey[]) => SetMetadata(PERMISSIONS_KEY, permissions);
/** Caller must select an outlet they are assigned to with the X-Outlet-Id header. */
export const OutletScoped = () => SetMetadata(OUTLET_SCOPED, true);
/** Endpoint may be called by platform admins, who belong to no restaurant. */
export const AllowPlatform = () => SetMetadata(ALLOW_PLATFORM, true);

export const Ctx = createParamDecorator((_: unknown, host: ExecutionContext): RequestContext => {
  return host.switchToHttp().getRequest().auth;
});
