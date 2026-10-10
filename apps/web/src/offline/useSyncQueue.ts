import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api, getApiOutlet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { reportOffline, useOnline } from '@/lib/online';
import type { Order } from '@/lib/types';
import { acceptServerTotal, countOps, discardOp, dropOfflinePayment, enqueueOrder, listOps, openOfflineDb, purgeFinished, removeLines, retryOp, syncQueue, type NewOfflineOrder, type OfflineDb, type OpStatus, type QueuedOrder, type SyncTransport } from './queue';

let dbPromise: Promise<OfflineDb> | null = null;
export const offlineDb = (): Promise<OfflineDb> => (dbPromise ??= openOfflineDb());

interface Snapshot {
  ops: QueuedOrder[];
  counts: Record<OpStatus, number>;
  syncing: boolean;
}
let snapshot: Snapshot = { ops: [], counts: { queued: 0, syncing: 0, synced: 0, conflict: 0, discarded: 0 }, syncing: false };
const listeners = new Set<() => void>();
const publish = (next: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
};

export async function refreshQueue(): Promise<void> {
  const ops = await listOps(await offlineDb());
  publish({ ops, counts: countOps(ops) });
}

const transport: SyncTransport = {
  async createOrder(op) {
    const order = await api<Order>('/orders', { method: 'POST', body: { ...op.payload, expectedTotalMinor: op.payload.expectedTotalMinor ?? op.expectedTotalMinor }, idempotencyKey: op.opId, outletId: op.outletId });
    return { id: order.id, orderNumber: order.orderNumber, totalMinor: order.dueMinor };
  },
  async recordCash(orderId, amountMinor, tenderedMinor, idempotencyKey) {
    await api(`/orders/${orderId}/payments`, { method: 'POST', body: { tenders: [{ method: 'CASH', amountMinor, tenderedMinor }] }, idempotencyKey, outletId: getApiOutlet() });
  },
};

let running: Promise<void> | null = null;
function runSync(userId: string, outletId: string, onDone: (synced: number) => void): Promise<void> {
  running ??= (async () => {
    publish({ syncing: true });
    try {
      const db = await offlineDb();
      const result = await syncQueue(db, transport, { userId, outletId });
      if (result.stoppedOffline) reportOffline();
      await purgeFinished(db);
      onDone(result.synced);
    } finally {
      await refreshQueue();
      publish({ syncing: false });
      running = null;
    }
  })();
  return running;
}

/** The offline queue for the whole app: its contents, counts, and the actions an operator can take. */
export function useSyncQueue() {
  const state = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
  );
  const { me, outlet, offlineSession } = useAuth();
  const online = useOnline();
  const queryClient = useQueryClient();
  const userId = me?.user.id;
  const outletId = outlet?.id;

  const syncNow = useCallback(async () => {
    if (!userId || !outletId) return;
    await runSync(userId, outletId, (synced) => {
      if (synced > 0) for (const key of ['orders', 'floor', 'shift', 'dashboard']) void queryClient.invalidateQueries({ queryKey: [key] });
    });
  }, [userId, outletId, queryClient]);

  useEffect(() => {
    void refreshQueue();
  }, []);

  // Send automatically as soon as we are online with a real (not cached) session, then keep trying.
  useEffect(() => {
    if (!online || offlineSession || state.counts.queued === 0) return;
    void syncNow();
    const timer = setInterval(() => void syncNow(), 20_000);
    return () => clearInterval(timer);
  }, [online, offlineSession, state.counts.queued, syncNow]);

  const act = useCallback(async (run: (db: OfflineDb) => Promise<unknown>) => {
    await run(await offlineDb());
    await refreshQueue();
  }, []);

  return {
    ...state,
    syncNow,
    enqueue: async (input: NewOfflineOrder): Promise<QueuedOrder> => {
      const op = await enqueueOrder(await offlineDb(), input);
      await refreshQueue();
      return op;
    },
    retry: (opId: string) => act((db) => retryOp(db, opId)),
    acceptTotal: (opId: string) => act((db) => acceptServerTotal(db, opId)),
    dropPayment: (opId: string) => act((db) => dropOfflinePayment(db, opId)),
    removeProduct: (opId: string, productId: string) => act((db) => removeLines(db, opId, productId)),
    discard: (opId: string, reason: string) => act((db) => discardOp(db, opId, reason)),
  };
}
