/**
 * Offline order queue (IndexedDB).
 *
 * While the server cannot be reached, the POS captures orders here. Each one gets a permanent
 * operation id that is also its Idempotency-Key, so sending it twice can never create two orders.
 *
 * Rules this module guarantees:
 *  - An operation is never dropped on failure. It stays `queued` (to retry) or becomes a
 *    `conflict` that a person must resolve. Only a person can discard one, with a reason.
 *  - Nothing here is a server-confirmed transaction until its status is `synced`.
 *  - Cash noted as collected offline is recorded as a payment only after the order syncs.
 *  - An operation is only ever sent under the login of the person who captured it.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CreateOrderInput } from '@serveos/shared';
import type { Catalog } from '@/lib/types';

export type OpStatus = 'queued' | 'syncing' | 'synced' | 'conflict' | 'discarded';

export interface QueuedOrder {
  opId: string;
  /** Capture order on this device. Timestamps can tie, so this decides what is sent first. */
  seq: number;
  /** Reference printed on the provisional slip, e.g. "OFF-0007". Not an order number. */
  localRef: string;
  outletId: string;
  userId: string;
  userName: string;
  createdAt: string;
  payload: CreateOrderInput;
  summary: { lines: Array<{ name: string; quantity: number; totalMinor: number }>; totalMinor: number };
  /** The total the operator quoted. If the server computes a different one, the sync stops and asks. */
  expectedTotalMinor: number;
  /** Cash handed over at the counter, or null if the order was captured unpaid. */
  cashTenderedMinor: number | null;
  status: OpStatus;
  attempts: number;
  lastError: { code: string; message: string; details?: unknown } | null;
  orderId?: string;
  orderNumber?: string;
  serverTotalMinor?: number;
  paymentRecorded: boolean;
  syncedAt?: string;
  discardReason?: string;
}

interface Schema extends DBSchema {
  queue: { key: string; value: QueuedOrder; indexes: { byCreated: string } };
  catalog: { key: string; value: { outletId: string; savedAt: string; catalog: Catalog } };
  meta: { key: string; value: { key: string; value: number } };
}

export type OfflineDb = IDBPDatabase<Schema>;

export function openOfflineDb(name = 'serveos-offline'): Promise<OfflineDb> {
  return openDB<Schema>(name, 1, {
    upgrade(db) {
      db.createObjectStore('queue', { keyPath: 'opId' }).createIndex('byCreated', 'createdAt');
      db.createObjectStore('catalog', { keyPath: 'outletId' });
      db.createObjectStore('meta', { keyPath: 'key' });
    },
  });
}

// ── Menu cache ──

export async function saveCatalog(db: OfflineDb, outletId: string, catalog: Catalog): Promise<void> {
  await db.put('catalog', { outletId, savedAt: new Date().toISOString(), catalog });
}

export async function loadCatalog(db: OfflineDb, outletId: string): Promise<{ savedAt: string; catalog: Catalog } | null> {
  return (await db.get('catalog', outletId)) ?? null;
}

// ── Queue ──

export interface NewOfflineOrder {
  outletId: string;
  userId: string;
  userName: string;
  payload: CreateOrderInput;
  summary: QueuedOrder['summary'];
  cashTenderedMinor: number | null;
}

export async function enqueueOrder(db: OfflineDb, input: NewOfflineOrder): Promise<QueuedOrder> {
  const tx = db.transaction(['queue', 'meta'], 'readwrite');
  const counter = ((await tx.objectStore('meta').get('localRef'))?.value ?? 0) + 1;
  await tx.objectStore('meta').put({ key: 'localRef', value: counter });
  const createdAt = new Date().toISOString();
  const op: QueuedOrder = {
    ...input,
    opId: `offline-${crypto.randomUUID()}`,
    seq: counter,
    localRef: `OFF-${String(counter).padStart(4, '0')}`,
    createdAt,
    payload: { ...input.payload, action: 'PLACE', source: 'POS_OFFLINE', clientCreatedAt: createdAt },
    expectedTotalMinor: input.summary.totalMinor,
    status: 'queued',
    attempts: 0,
    lastError: null,
    paymentRecorded: false,
  };
  await tx.objectStore('queue').put(op);
  await tx.done;
  return op;
}

export async function listOps(db: OfflineDb): Promise<QueuedOrder[]> {
  // Newest first for display; syncQueue reverses this to send the oldest first.
  return (await db.getAll('queue')).sort((a, b) => b.seq - a.seq);
}

export function countOps(ops: QueuedOrder[]): Record<OpStatus, number> {
  const counts: Record<OpStatus, number> = { queued: 0, syncing: 0, synced: 0, conflict: 0, discarded: 0 };
  for (const op of ops) counts[op.status] += 1;
  return counts;
}

async function update(db: OfflineDb, opId: string, change: (op: QueuedOrder) => QueuedOrder): Promise<QueuedOrder> {
  const tx = db.transaction('queue', 'readwrite');
  const current = await tx.store.get(opId);
  if (!current) throw new Error('Queued operation not found');
  const next = change(current);
  await tx.store.put(next);
  await tx.done;
  return next;
}

/** What the queue needs from the network. Errors must expose `status`, `code`, `message`, `details`. */
export interface SyncTransport {
  createOrder(op: QueuedOrder): Promise<{ id: string; orderNumber: string; totalMinor: number }>;
  recordCash(orderId: string, amountMinor: number, tenderedMinor: number, idempotencyKey: string): Promise<void>;
}

interface TransportError {
  status?: number;
  code?: string;
  message?: string;
  details?: unknown;
}
const isTransient = (e: TransportError): boolean => e.code === 'NETWORK' || e.status === 0 || e.status === 401 || e.status === 429 || (e.status ?? 0) >= 500;

/**
 * Sends everything that is waiting, oldest first. Stops at the first sign that the server
 * is unreachable (the rest stay queued). Returns how many orders were confirmed.
 */
export async function syncQueue(db: OfflineDb, transport: SyncTransport, current: { userId: string; outletId: string }): Promise<{ synced: number; stoppedOffline: boolean }> {
  const waiting = (await listOps(db)).filter((op) => (op.status === 'queued' || op.status === 'syncing') && op.userId === current.userId && op.outletId === current.outletId).reverse();
  let synced = 0;
  for (const queued of waiting) {
    let op = await update(db, queued.opId, (o) => ({ ...o, status: 'syncing', attempts: o.attempts + 1 }));
    try {
      // Safe to repeat: the server recognises the operation id and returns the same order.
      const order = await transport.createOrder(op);
      op = await update(db, op.opId, (o) => ({ ...o, orderId: order.id, orderNumber: order.orderNumber, serverTotalMinor: order.totalMinor }));
      if (op.cashTenderedMinor != null && !op.paymentRecorded && order.totalMinor > 0) {
        await transport.recordCash(order.id, order.totalMinor, op.cashTenderedMinor, `${op.opId}-pay`);
        op = await update(db, op.opId, (o) => ({ ...o, paymentRecorded: true }));
      }
      await update(db, op.opId, (o) => ({ ...o, status: 'synced', lastError: null, syncedAt: new Date().toISOString() }));
      synced += 1;
    } catch (err) {
      const e = err as TransportError;
      const lastError = { code: e.code ?? 'UNKNOWN', message: e.message ?? 'Unknown error', details: e.details };
      if (isTransient(e)) {
        await update(db, op.opId, (o) => ({ ...o, status: 'queued', lastError }));
        return { synced, stoppedOffline: true };
      }
      // The server understood the request and refused it: a person has to decide what to do.
      await update(db, op.opId, (o) => ({ ...o, status: 'conflict', lastError }));
    }
  }
  return { synced, stoppedOffline: false };
}

// ── Operator resolutions ──

/** Try again as it is (for example after opening a cash shift or re-enabling an item). */
export const retryOp = (db: OfflineDb, opId: string): Promise<QueuedOrder> => update(db, opId, (o) => (o.status === 'conflict' ? { ...o, status: 'queued', lastError: null } : o));

/** Accept the total the server calculated instead of the one quoted offline. */
export function acceptServerTotal(db: OfflineDb, opId: string): Promise<QueuedOrder> {
  return update(db, opId, (o) => {
    const actual = (o.lastError?.details as { actualTotalMinor?: number } | undefined)?.actualTotalMinor;
    if (o.status !== 'conflict' || o.lastError?.code !== 'PRICE_CONFLICT' || actual == null) return o;
    return { ...o, status: 'queued', expectedTotalMinor: actual, payload: { ...o.payload, expectedTotalMinor: actual }, lastError: null };
  });
}

/** Send the order without the offline cash note; the bill is then settled normally from the Orders screen. */
export const dropOfflinePayment = (db: OfflineDb, opId: string): Promise<QueuedOrder> =>
  update(db, opId, (o) => (o.status === 'conflict' ? { ...o, status: 'queued', cashTenderedMinor: null, lastError: null } : o));

/** Remove lines the server refused (item no longer available) and try again with the rest. */
export function removeLines(db: OfflineDb, opId: string, productId: string): Promise<QueuedOrder> {
  return update(db, opId, (o) => {
    if (o.status !== 'conflict') return o;
    const items = o.payload.items.filter((i) => i.productId !== productId);
    if (items.length === 0) return o;
    // The total is now unknown: let the server price what is left.
    const { expectedTotalMinor: _dropped, ...payload } = { ...o.payload, items };
    return { ...o, status: 'queued', payload, lastError: null };
  });
}

/** Give up on an operation. It is kept, marked discarded with the reason, so there is a record. */
export function discardOp(db: OfflineDb, opId: string, reason: string): Promise<QueuedOrder> {
  if (reason.trim().length < 3) throw new Error('A reason is required to discard an offline order');
  return update(db, opId, (o) => (o.status === 'synced' ? o : { ...o, status: 'discarded', discardReason: reason.trim() }));
}

/** Clears confirmed and discarded records older than `days`. Waiting and conflicting ones are never removed. */
export async function purgeFinished(db: OfflineDb, days = 7): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const tx = db.transaction('queue', 'readwrite');
  let removed = 0;
  for (const op of await tx.store.getAll()) {
    if ((op.status === 'synced' || op.status === 'discarded') && op.createdAt < cutoff) {
      await tx.store.delete(op.opId);
      removed += 1;
    }
  }
  await tx.done;
  return removed;
}
