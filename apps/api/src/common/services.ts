import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import type { RequestContext } from './context';
import { PrismaService, type Tx } from './prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Records a sensitive action. Pass `tx` so the audit row commits or rolls back with the change. */
  async log(
    ctx: Pick<RequestContext, 'restaurantId' | 'outletId' | 'userId' | 'userName' | 'ip' | 'correlationId'> | null,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonObject = {},
    tx: Tx | PrismaService = this.prisma,
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        restaurantId: ctx?.restaurantId || null,
        outletId: ctx?.outletId ?? null,
        actorId: ctx?.userId ?? null,
        actorName: ctx?.userName ?? '',
        action,
        entityType,
        entityId,
        metadata,
        ip: ctx?.ip ?? '',
        correlationId: ctx?.correlationId ?? '',
      },
    });
  }
}

export type DocType = 'ORDER' | 'KOT' | 'INVOICE' | 'CREDIT_NOTE' | 'PO' | 'GRN';

@Injectable()
export class SequenceService {
  /**
   * Returns the next number of a per-outlet counter. The row lock is held until the caller's
   * transaction ends, so numbers are unique and, if the transaction rolls back, not skipped.
   */
  async next(tx: Tx, outletId: string, docType: DocType, period: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ lastValue: number }>>`
      INSERT INTO "DocumentSequence" ("outletId", "docType", "period", "lastValue")
      VALUES (${outletId}::uuid, ${docType}, ${period}, 1)
      ON CONFLICT ("outletId", "docType", "period")
      DO UPDATE SET "lastValue" = "DocumentSequence"."lastValue" + 1
      RETURNING "lastValue"`;
    return rows[0]!.lastValue;
  }
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  sentAt: string;
}

/**
 * Email port with two adapters:
 *  - dev: logs the message and keeps it in memory for the dev outbox endpoint; nothing is sent.
 *  - resend: sends through the Resend HTTP API from the address in EMAIL_FROM.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger('Email');
  readonly outbox: OutgoingEmail[] = [];

  async send(to: string, subject: string, text: string): Promise<void> {
    if (env.EMAIL_PROVIDER === 'dev') {
      this.outbox.unshift({ to, subject, text, sentAt: new Date().toISOString() });
      this.outbox.length = Math.min(this.outbox.length, 50);
      if (env.NODE_ENV !== 'test') this.logger.log(`Not sent (dev adapter). To: ${to} | ${subject}\n${text}`);
      return;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(15_000),
    }).catch((err: unknown) => err as Error);
    // The message body holds a sign-in link, so only the outcome is logged, never the content.
    if (res instanceof Error || !res.ok) {
      this.logger.error({ to, subject, status: res instanceof Error ? res.message : res.status }, 'email could not be sent');
      throw new Error('The email could not be sent');
    }
  }
}
