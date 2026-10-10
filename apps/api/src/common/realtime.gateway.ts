import { Injectable, Logger } from '@nestjs/common';
import { OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { REALTIME_EVENTS } from '@serveos/shared';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { env } from '../config/env';
import { AccessService } from './access.service';

type RealtimeEvent = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

/**
 * Live updates for the POS, KDS and mobile app. Messages are only hints ("something about
 * order X changed"): clients always re-read the authoritative state over the REST API, and
 * do so again after every reconnect, so a dropped socket can never lose an order.
 */
@WebSocketGateway({ cors: { origin: env.CORS_ORIGINS, credentials: true } })
@Injectable()
export class RealtimeGateway implements OnGatewayInit {
  private readonly logger = new Logger('Realtime');

  @WebSocketServer()
  private server?: Server;

  constructor(private readonly access: AccessService) {}

  /**
   * Authenticates during the handshake, so a socket is never "connected" before we know who
   * it is. A bad or expired token is refused with a connect_error the client can react to.
   */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      this.access
        .authenticate(String(socket.handshake.auth?.token ?? ''))
        .then((ctx) => {
          socket.data.outletIds = ctx.outletIds;
          next();
        })
        .catch(() => next(new Error('Not authenticated')));
    });
  }

  @SubscribeMessage('subscribe')
  async subscribe(client: Socket, body: unknown): Promise<{ ok: boolean }> {
    const parsed = z.object({ outletId: z.uuid() }).safeParse(body);
    const allowed: string[] = client.data.outletIds ?? [];
    if (!parsed.success || !allowed.includes(parsed.data.outletId)) return { ok: false };
    for (const room of client.rooms) if (room.startsWith('outlet:')) await client.leave(room);
    await client.join(`outlet:${parsed.data.outletId}`);
    return { ok: true };
  }

  /** Call only after the database transaction has committed. */
  emit(outletId: string, event: RealtimeEvent, payload: Record<string, unknown> = {}): void {
    try {
      this.server?.to(`outlet:${outletId}`).emit(event, { ...payload, outletId, at: new Date().toISOString() });
    } catch (err) {
      this.logger.warn({ err }, 'failed to broadcast realtime event');
    }
  }
}
