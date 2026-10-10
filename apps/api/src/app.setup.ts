import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { Response } from 'express';
import helmet from 'helmet';
import { cleanupOpenApiDoc, ZodValidationPipe } from 'nestjs-zod';
import { AllExceptionsFilter } from './common/errors';
import { env, isProduction } from './config/env';
import { UPLOAD_DIR } from './modules/menu.module';

/** Applies the same HTTP configuration to the real server and to the test server. */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('api/v1');
  app.set('trust proxy', isProduction ? 1 : false);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Outlet-Id', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
  });
  // Uploaded product images: random file names, served read-only, never executed.
  app.useStaticAssets(UPLOAD_DIR, { prefix: '/uploads', index: false, dotfiles: 'deny', setHeaders: (res: Response) => res.setHeader('X-Content-Type-Options', 'nosniff') });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if ((env.API_DOCS ?? (isProduction ? 'off' : 'on')) === 'off') return;
  const config = new DocumentBuilder()
    .setTitle('ServeOS API')
    .setDescription('Restaurant POS and management API. Send `Authorization: Bearer <token>` and, for outlet data, `X-Outlet-Id`.')
    .setVersion('1')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(SwaggerModule.createDocument(app, config)));
}
