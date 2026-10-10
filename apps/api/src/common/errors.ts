import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

/** An error with a stable machine-readable code that clients can act on. */
export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message, status);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Sign in to continue') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'FORBIDDEN', message);
/** Used for missing rows and for rows owned by another restaurant, so ids cannot be probed. */
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);

function findZodError(exception: unknown): ZodError | null {
  if (exception instanceof ZodError) return exception;
  const inner = (exception as { getZodError?: () => unknown })?.getZodError?.();
  return inner instanceof ZodError ? inner : null;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const correlationId = String(req.id ?? '');

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Please try again.';
    let details: unknown;

    const zodError = findZodError(exception);
    if (zodError) {
      status = 400;
      code = 'VALIDATION_FAILED';
      message = 'Some fields are invalid';
      details = zodError.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (exception instanceof AppError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'REQUEST_FAILED';
      message = status === 429 ? 'Too many requests. Please wait a moment.' : exception.message;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = 409;
        code = 'ALREADY_EXISTS';
        message = 'A record with these details already exists';
      } else if (exception.code === 'P2025') {
        status = 404;
        code = 'NOT_FOUND';
        message = 'Record not found';
      } else if (exception.code === 'P2003') {
        status = 409;
        code = 'IN_USE';
        message = 'This record is referenced by other data and cannot be changed this way';
      }
    }

    if (status >= 500) {
      // Full detail goes to the server log only; the client gets a generic message.
      this.logger.error({ correlationId, path: req.url, err: exception }, exception instanceof Error ? exception.stack : undefined);
    }
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message, details, correlationId } });
  }
}
