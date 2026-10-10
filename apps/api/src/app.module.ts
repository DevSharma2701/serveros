import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { AccessService, AuthGuard } from './common/access.service';
import { PrismaService } from './common/prisma.service';
import { RealtimeGateway } from './common/realtime.gateway';
import { AuditService, EmailService, SequenceService } from './common/services';
import { env, isProduction } from './config/env';
import { AuthModule } from './modules/auth.module';
import { BillingModule } from './modules/billing.module';
import { CashModule } from './modules/cash.module';
import { CustomersModule } from './modules/customers.module';
import { FloorModule } from './modules/floor.module';
import { GuestModule } from './modules/guest.module';
import { InventoryModule } from './modules/inventory.module';
import { KitchenModule } from './modules/kitchen.module';
import { MenuModule } from './modules/menu.module';
import { OrdersModule } from './modules/orders.module';
import { PaymentsModule } from './modules/payments.module';
import { ReportsModule } from './modules/reports.module';
import { SetupModule } from './modules/setup.module';
import { StaffModule } from './modules/staff.module';

/** Services every feature module needs. */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [PrismaService, AccessService, AuditService, SequenceService, EmailService, RealtimeGateway],
  exports: [PrismaService, AccessService, AuditService, SequenceService, EmailService, RealtimeGateway],
})
export class CoreModule {}

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.NODE_ENV === 'test' ? 'silent' : isProduction ? 'info' : 'debug',
        // Every request gets a correlation id, echoed in the response and in error bodies.
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const incoming = req.headers['x-request-id'];
          const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-serveos-signature"]', 'res.headers["set-cookie"]'],
        autoLogging: env.NODE_ENV !== 'test',
        transport: isProduction || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } },
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: env.NODE_ENV === 'test' ? 100_000 : 600 }]),
    CoreModule,
    AuthModule,
    SetupModule,
    StaffModule,
    MenuModule,
    FloorModule,
    KitchenModule,
    InventoryModule,
    CustomersModule,
    BillingModule,
    OrdersModule,
    CashModule,
    PaymentsModule,
    GuestModule,
    ReportsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
