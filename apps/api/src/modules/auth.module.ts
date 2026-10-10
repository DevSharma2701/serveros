import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { hash, verify } from '@node-rs/argon2';
import { changePasswordSchema, forgotPasswordSchema, loginSchema, refreshSchema, resetPasswordSchema } from '@serveos/shared';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { AccessService } from '../common/access.service';
import { AllowPlatform, Ctx, Public, type RequestContext } from '../common/context';
import { badRequest, notFound, unauthorized } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AuditService, EmailService } from '../common/services';
import { hmac, randomToken, sha256 } from '../common/util';
import { env, isProduction } from '../config/env';

class LoginDto extends createZodDto(loginSchema) {}
class RefreshDto extends createZodDto(refreshSchema) {}
class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}
class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

const REFRESH_COOKIE = 'serveos_rt';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const AUTH_THROTTLE = { default: { limit: env.NODE_ENV === 'test' ? 10_000 : 10, ttl: 60_000 } };
// Every page load refreshes the session, so this is far looser than sign-in. A refresh token is 48 random bytes: it cannot be guessed.
const REFRESH_THROTTLE = { default: { limit: env.NODE_ENV === 'test' ? 10_000 : 120, ttl: 60_000 } };

// Argon2id is the library default; parameters follow the OWASP minimum recommendation.
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
export const hashPassword = (password: string): Promise<string> => hash(password, ARGON);
// Verified against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = hashPassword(randomToken(16));

const refreshHash = (token: string): string => hmac(env.JWT_REFRESH_SECRET, token);

interface ClientInfo {
  ip: string;
  userAgent: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  async login(dto: LoginDto, client: ClientInfo) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const invalid = unauthorized('Incorrect email or password');
    if (!user || !user.passwordHash) {
      await verify(await DUMMY_HASH, dto.password).catch(() => false);
      throw invalid;
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw unauthorized('Too many failed attempts. Try again in a few minutes.');
    }
    const ok = await verify(user.passwordHash, dto.password).catch(() => false);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const locked = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: locked ? 0 : failed, lockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null },
      });
      if (locked) await this.audit.log(null, 'auth.locked', 'User', user.id, { ip: client.ip });
      throw invalid;
    }
    if (user.status !== 'ACTIVE') throw unauthorized('This account is not active. Contact your manager.');

    const refreshToken = randomToken();
    const session = await this.prisma.userSession.create({
      data: {
        userId: user.id,
        refreshTokenHash: refreshHash(refreshToken),
        userAgent: client.userAgent.slice(0, 300),
        ip: client.ip,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    return { ...this.access.signAccessToken(user.id, session.id), refreshToken };
  }

  /** Exchanges a refresh token for a new access token and rotates the refresh token. */
  async refresh(token: string | undefined) {
    if (!token) throw unauthorized();
    const session = await this.prisma.userSession.findUnique({ where: { refreshTokenHash: refreshHash(token) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.user.status !== 'ACTIVE') throw unauthorized();
    const refreshToken = randomToken();
    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { refreshTokenHash: refreshHash(refreshToken), lastUsedAt: new Date(), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    return { ...this.access.signAccessToken(session.userId, session.id), refreshToken };
  }

  async revokeSession(userId: string, sessionId: string, reason: string): Promise<void> {
    const result = await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    if (result.count === 0) throw notFound('Session');
  }

  async revokeAllSessions(userId: string, reason: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async me(ctx: RequestContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, include: { role: true, restaurant: true } });
    const outlets = await this.prisma.outlet.findMany({
      where: { id: { in: ctx.outletIds } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, timezone: true, city: true, stateCode: true },
    });
    const r = user.restaurant;
    return {
      user: { id: user.id, name: user.name, email: user.email, role: { key: user.role.key, name: user.role.name, rank: user.role.rank } },
      restaurant: r && {
        id: r.id,
        name: r.name,
        currency: r.currency,
        pricesIncludeTax: r.pricesIncludeTax,
        roundOffMode: r.roundOffMode,
        serviceChargeBps: r.serviceChargeBps,
        discountApprovalThresholdBps: r.discountApprovalThresholdBps,
        allowPartialPayment: r.allowPartialPayment,
        loyaltyEnabled: r.loyaltyEnabled,
        loyaltyPointValueMinor: r.loyaltyPointValueMinor,
        loyaltyMinRedeemPoints: r.loyaltyMinRedeemPoints,
      },
      outlets,
      allOutlets: ctx.allOutlets,
      permissions: [...ctx.permissions].sort(),
      outletPermissions: Object.fromEntries([...ctx.outletPermissions].map(([id, set]) => [id, [...set].sort()])),
      paymentGateway: env.PAYMENT_PROVIDER,
    };
  }

  /** Creates a one-time link for setting a password, used for both invitations and resets. */
  async issuePasswordToken(userId: string, purpose: 'INVITE' | 'PASSWORD_RESET'): Promise<string> {
    const token = randomToken(32);
    await this.prisma.userToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
    await this.prisma.userToken.create({
      data: { userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + (purpose === 'INVITE' ? 7 * 24 * 60 : 30) * 60_000) },
    });
    return token;
  }

  async sendInvite(user: { id: string; email: string; name: string }, restaurantName: string): Promise<void> {
    const token = await this.issuePasswordToken(user.id, 'INVITE');
    await this.email.send(
      user.email,
      `You have been invited to ${restaurantName} on ServeOS`,
      `Hello ${user.name},\n\nSet your password to activate your account (link valid for 7 days):\n${env.WEB_URL}/set-password?token=${token}\n`,
    );
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Always succeed silently so the endpoint cannot be used to discover accounts.
    if (!user || user.status === 'DISABLED') return;
    const token = await this.issuePasswordToken(user.id, user.status === 'INVITED' ? 'INVITE' : 'PASSWORD_RESET');
    await this.email.send(
      user.email,
      'Reset your ServeOS password',
      `Hello ${user.name},\n\nUse this link within 30 minutes to choose a new password:\n${env.WEB_URL}/set-password?token=${token}\n\nIf you did not ask for this, ignore this email.`,
    );
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const record = await this.prisma.userToken.findUnique({ where: { tokenHash: sha256(dto.token) }, include: { user: true } });
    if (!record || record.usedAt || record.expiresAt < new Date() || record.user.status === 'DISABLED') {
      throw badRequest('INVALID_TOKEN', 'This link is invalid or has expired. Request a new one.');
    }
    const passwordHash = await hashPassword(dto.password);
    await this.prisma.tx(async (tx) => {
      // Guarded update: if two requests race, only one can consume the token.
      const used = await tx.userToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count === 0) throw badRequest('INVALID_TOKEN', 'This link has already been used.');
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash, status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null } });
      await tx.userSession.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'password_reset' } });
      await tx.auditEvent.create({
        data: {
          restaurantId: record.user.restaurantId,
          actorId: record.userId,
          actorName: record.user.name,
          action: record.purpose === 'INVITE' ? 'auth.invite_accepted' : 'auth.password_reset',
          entityType: 'User',
          entityId: record.userId,
        },
      });
    });
  }

  async changePassword(ctx: RequestContext, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    const ok = user.passwordHash ? await verify(user.passwordHash, dto.currentPassword).catch(() => false) : false;
    if (!ok) throw badRequest('WRONG_PASSWORD', 'Your current password is incorrect');
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(dto.newPassword) } });
    await this.revokeAllSessions(user.id, 'password_changed', ctx.sessionId);
    await this.audit.log(ctx, 'auth.password_changed', 'User', user.id);
  }
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  private setCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: REFRESH_TTL_MS,
    });
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in. Web clients receive the refresh token as an httpOnly cookie; mobile clients in the body.' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, ...tokens } = await this.auth.login(dto, { ip: req.ip ?? '', userAgent: req.headers['user-agent'] ?? '' });
    if (dto.client === 'mobile') return { ...tokens, refreshToken };
    this.setCookie(res, refreshToken);
    return tokens;
  }

  @Public()
  @Throttle(REFRESH_THROTTLE)
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const fromBody = dto.refreshToken;
    const { refreshToken, ...tokens } = await this.auth.refresh(fromBody ?? req.cookies?.[REFRESH_COOKIE]);
    if (fromBody) return { ...tokens, refreshToken };
    this.setCookie(res, refreshToken);
    return tokens;
  }

  @AllowPlatform()
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  async logout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.revokeSession(ctx.userId, ctx.sessionId, 'logout');
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  @AllowPlatform()
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Current user, restaurant, authorised outlets and permissions' })
  me(@Ctx() ctx: RequestContext) {
    return this.auth.me(ctx);
  }

  @AllowPlatform()
  @ApiBearerAuth()
  @Get('sessions')
  async sessions(@Ctx() ctx: RequestContext) {
    const rows = await this.prisma.userSession.findMany({
      where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true },
    });
    return rows.map((s) => ({ ...s, current: s.id === ctx.sessionId }));
  }

  @AllowPlatform()
  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.auth.revokeSession(ctx.userId, id, 'revoked_by_user');
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('password/forgot')
  @HttpCode(204)
  async forgot(@Body() dto: ForgotPasswordDto): Promise<void> {
    await this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('password/reset')
  @HttpCode(204)
  @ApiOperation({ summary: 'Set a password using an invitation or reset token' })
  async reset(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto);
  }

  @AllowPlatform()
  @ApiBearerAuth()
  @Post('password/change')
  @HttpCode(204)
  async change(@Ctx() ctx: RequestContext, @Body() dto: ChangePasswordDto): Promise<void> {
    await this.auth.changePassword(ctx, dto);
  }
}

@Module({ controllers: [AuthController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
