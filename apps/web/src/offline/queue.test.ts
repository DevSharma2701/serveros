import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptServerTotal, countOps, discardOp, dropOfflinePayment, enqueueOrder, listOps, openOfflineDb, purgeFinished, removeLines, retryOp, syncQueue, type NewOfflineOrder, type OfflineDb, type SyncTransport } from './queue';

let db: OfflineDb;
let n = 0;
const me = { userId: 'user-1', outletId: 'outlet-1' };

const input = (overrides: Partial<NewOfflineOrder> = {}): NewOfflineOrder => ({
  outletId: me.outletId,
  userId: me.userId,
  userName: 'Rohan',
  payload: { type: 'TAKEAWAY', items: [{ clientLineId: 'l1', productId: 'tea', variantId: 'tea-regular', quantity: 2 }, { clientLineId: 'l2', productId: 'naan', variantId: 'naan-regular', quantity: 1 }] },
  summary: { lines: [{ name: 'Tea', quantity: 2, totalMinor: 21_000 }], totalMinor: 21_000 },
  cashTenderedMinor: null,
  ...overrides,
});

const error = (status: number, code: string, details?: unknown) => Object.assign(new Error(code), { status, code, details });
const transport = (overrides: Partial<SyncTransport> = {}): SyncTransport & { createOrder: ReturnType<typeof vi.fn>; recordCash: ReturnType<typeof vi.fn> } => ({
  createOrder: vi.fn(async (op) => ({ id: `order-${op.opId}`, orderNumber: '261010-0001', totalMinor: op.expectedTotalMinor })),
  recordCash: vi.fn(async () => undefined),
  ...overrides,
}) as never;

beforeEach(async () => {
  db = await openOfflineDb(`test-${++n}`);
});

describe('capturing orders offline', () => {
  it('stores the order with a stable id and a local reference, marked as offline', async () => {
    const first = await enqueueOrder(db, input());
    const second = await enqueueOrder(db, input());
    expect(first.localRef).toBe('OFF-0001');
    expect(second.localRef).toBe('OFF-0002');
    expect(first.opId).not.toBe(second.opId);
    expect(first).toMatchObject({ status: 'queued', attempts: 0, paymentRecorded: false, expectedTotalMinor: 21_000 });
    expect(first.payload).toMatchObject({ action: 'PLACE', source: 'POS_OFFLINE' });
    expect(countOps(await listOps(db))).toMatchObject({ queued: 2, synced: 0 });
  });

  it('survives a reload: the queue is read back from IndexedDB', async () => {
    const name = `persist-${n}`;
    const one = await openOfflineDb(name);
    const op = await enqueueOrder(one, input());
    one.close();
    const reopened = await openOfflineDb(name);
    expect((await listOps(reopened)).map((o) => o.opId)).toEqual([op.opId]);
  });
});

describe('synchronising', () => {
  it('sends queued orders oldest first, using the operation id as the idempotency key', async () => {
    const a = await enqueueOrder(db, input());
    const b = await enqueueOrder(db, input());
    const t = transport();
    expect(await syncQueue(db, t, me)).toEqual({ synced: 2, stoppedOffline: false });
    expect(t.createOrder.mock.calls.map((c) => c[0].opId)).toEqual([a.opId, b.opId]);
    const ops = await listOps(db);
    expect(ops.every((o) => o.status === 'synced' && o.orderNumber === '261010-0001' && o.syncedAt)).toBe(true);
    // Nothing left to send: a second run does not touch the server.
    await syncQueue(db, t, me);
    expect(t.createOrder).toHaveBeenCalledTimes(2);
  });

  it('keeps everything queued when the server is unreachable, and retries with the same id later', async () => {
    const a = await enqueueOrder(db, input());
    await enqueueOrder(db, input());
    const down = transport({ createOrder: vi.fn(async () => Promise.reject(error(0, 'NETWORK'))) });
    expect(await syncQueue(db, down, me)).toEqual({ synced: 0, stoppedOffline: true });
    expect(down.createOrder).toHaveBeenCalledTimes(1); // stopped at the first failure
    expect(countOps(await listOps(db))).toMatchObject({ queued: 2, conflict: 0 });

    const up = transport();
    expect((await syncQueue(db, up, me)).synced).toBe(2);
    expect(up.createOrder.mock.calls[0]![0].opId).toBe(a.opId);
    expect((await listOps(db)).find((o) => o.opId === a.opId)!.attempts).toBe(2);
  });

  it('treats server errors and expired sessions as temporary, never as a reason to drop an order', async () => {
    await enqueueOrder(db, input());
    for (const failure of [error(500, 'INTERNAL_ERROR'), error(401, 'UNAUTHENTICATED'), error(429, 'RATE_LIMITED')]) {
      const result = await syncQueue(db, transport({ createOrder: vi.fn(async () => Promise.reject(failure)) }), me);
      expect(result.stoppedOffline).toBe(true);
      expect((await listOps(db))[0]!.status).toBe('queued');
    }
  });

  it('records offline cash only after the order is confirmed, with its own idempotency key', async () => {
    const op = await enqueueOrder(db, input({ cashTenderedMinor: 50_000 }));
    const t = transport();
    await syncQueue(db, t, me);
    expect(t.recordCash).toHaveBeenCalledWith(`order-${op.opId}`, 21_000, 50_000, `${op.opId}-pay`);
    expect((await listOps(db))[0]).toMatchObject({ status: 'synced', paymentRecorded: true });
  });

  it('if the payment step fails for lack of connection, the retry repeats safely and pays once', async () => {
    await enqueueOrder(db, input({ cashTenderedMinor: 21_000 }));
    const flaky = transport({ recordCash: vi.fn().mockRejectedValueOnce(error(0, 'NETWORK')).mockResolvedValue(undefined) });
    expect((await syncQueue(db, flaky, me)).stoppedOffline).toBe(true);
    expect((await listOps(db))[0]).toMatchObject({ status: 'queued', paymentRecorded: false, orderNumber: '261010-0001' });
    await syncQueue(db, flaky, me);
    expect((await listOps(db))[0]).toMatchObject({ status: 'synced', paymentRecorded: true });
    expect(flaky.recordCash.mock.calls.map((c) => c[3])).toEqual([expect.stringMatching(/-pay$/), expect.stringMatching(/-pay$/)]);
    expect(flaky.recordCash.mock.calls[0]![3]).toBe(flaky.recordCash.mock.calls[1]![3]);
  });

  it("does not send another cashier's orders under the current login", async () => {
    await enqueueOrder(db, input({ userId: 'someone-else' }));
    const t = transport();
    expect((await syncQueue(db, t, me)).synced).toBe(0);
    expect(t.createOrder).not.toHaveBeenCalled();
    expect((await listOps(db))[0]!.status).toBe('queued');
  });
});

describe('conflicts need a person', () => {
  const conflict = async (code: string, details?: unknown, extra: Partial<NewOfflineOrder> = {}) => {
    const op = await enqueueOrder(db, input(extra));
    await syncQueue(db, transport({ createOrder: vi.fn(async () => Promise.reject(error(409, code, details))) }), me);
    return op;
  };

  it('a changed price stops the sync and continues with other orders', async () => {
    const stuck = await conflict('PRICE_CONFLICT', { expectedTotalMinor: 21_000, actualTotalMinor: 23_100 });
    const fine = await enqueueOrder(db, input());
    const t = transport();
    await syncQueue(db, t, me);
    const ops = await listOps(db);
    expect(ops.find((o) => o.opId === stuck.opId)).toMatchObject({ status: 'conflict', lastError: { code: 'PRICE_CONFLICT' } });
    expect(ops.find((o) => o.opId === fine.opId)!.status).toBe('synced');
    expect(t.createOrder).toHaveBeenCalledTimes(1); // the conflicting one is not retried on its own
  });

  it('accepting the server total re-queues the order with that total', async () => {
    const op = await conflict('PRICE_CONFLICT', { expectedTotalMinor: 21_000, actualTotalMinor: 23_100 });
    const accepted = await acceptServerTotal(db, op.opId);
    expect(accepted).toMatchObject({ status: 'queued', expectedTotalMinor: 23_100, lastError: null });
    expect(accepted.payload.expectedTotalMinor).toBe(23_100);
    const t = transport();
    await syncQueue(db, t, me);
    expect(t.createOrder.mock.calls[0]![0].opId).toBe(op.opId); // same idempotency key
    expect((await listOps(db))[0]!.status).toBe('synced');
  });

  it('an unavailable item can be removed and the rest sent', async () => {
    const op = await conflict('ITEM_UNAVAILABLE', { productId: 'naan', name: 'Naan' });
    const edited = await removeLines(db, op.opId, 'naan');
    expect(edited.status).toBe('queued');
    expect(edited.payload.items.map((i) => i.productId)).toEqual(['tea']);
    expect(edited.payload.expectedTotalMinor).toBeUndefined();
    // Removing the only remaining item is refused: discard the order instead.
    await syncQueue(db, transport({ createOrder: vi.fn(async () => Promise.reject(error(409, 'ITEM_UNAVAILABLE', { productId: 'tea' }))) }), me);
    expect((await removeLines(db, op.opId, 'tea')).status).toBe('conflict');
  });

  it('a payment problem leaves the confirmed order and offers to settle it normally', async () => {
    const op = await enqueueOrder(db, input({ cashTenderedMinor: 21_000 }));
    const noShift = transport({ recordCash: vi.fn(async () => Promise.reject(error(409, 'NO_OPEN_SHIFT'))) });
    await syncQueue(db, noShift, me);
    expect((await listOps(db))[0]).toMatchObject({ status: 'conflict', orderNumber: '261010-0001', paymentRecorded: false, lastError: { code: 'NO_OPEN_SHIFT' } });

    await retryOp(db, op.opId); // after opening a shift
    await syncQueue(db, noShift, me);
    expect((await listOps(db))[0]!.status).toBe('conflict');

    const dropped = await dropOfflinePayment(db, op.opId);
    expect(dropped).toMatchObject({ status: 'queued', cashTenderedMinor: null });
    await syncQueue(db, transport(), me);
    expect((await listOps(db))[0]).toMatchObject({ status: 'synced', paymentRecorded: false });
  });

  it('discarding needs a reason and keeps a record; a confirmed order cannot be discarded', async () => {
    const op = await conflict('INSUFFICIENT_STOCK');
    expect(() => discardOp(db, op.opId, ' ')).toThrow();
    expect(await discardOp(db, op.opId, 'Guest had already left')).toMatchObject({ status: 'discarded', discardReason: 'Guest had already left' });
    expect(await listOps(db)).toHaveLength(1);

    const done = await enqueueOrder(db, input());
    await syncQueue(db, transport(), me);
    expect((await discardOp(db, done.opId, 'changed my mind')).status).toBe('synced');
  });

  it('never purges waiting or conflicting orders, however old', async () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const age = async (opId: string) => db.put('queue', { ...(await db.get('queue', opId))!, createdAt: old });
    const waiting = await enqueueOrder(db, input());
    const stuck = await conflict('PRICE_CONFLICT', { actualTotalMinor: 1 });
    const finished = await enqueueOrder(db, input({ userId: 'x' }));
    await db.put('queue', { ...(await db.get('queue', finished.opId))!, status: 'synced' });
    for (const id of [waiting.opId, stuck.opId, finished.opId]) await age(id);
    expect(await purgeFinished(db)).toBe(1);
    expect((await listOps(db)).map((o) => o.opId).sort()).toEqual([waiting.opId, stuck.opId].sort());
  });
});
