# Offline mode (web POS)

Restaurants lose internet. The POS keeps taking orders, with strict limits on what it will
claim while it cannot reach the server.

## What works offline

| Works | Needs a connection |
|---|---|
| Opening the POS (the app shell is cached by the service worker in a production build) | Signing in for the first time on a device |
| Browsing the menu last downloaded on this device | Dine-in orders and anything about tables |
| Taking takeaway, pickup and delivery orders | Card, UPI, gateway and loyalty payments |
| Noting cash collected for an order | Discounts and coupons |
| Seeing every captured order and its sync status | Holding orders, customers, refunds, voids, shifts |
| | The kitchen display — tell the kitchen directly |

Sensitive actions are simply unavailable offline; being offline never bypasses a permission.

## What an offline order is — and is not

An order captured offline gets a local reference such as `OFF-0007`. It is **not** a confirmed
transaction: it has no order number, no invoice and has not reached the kitchen display. The
total shown is an estimate from the saved menu. Cash noted as collected is recorded as a
payment only after the order has synchronised.

## How it works

- Storage: IndexedDB database `serveos-offline` (`apps/web/src/offline/queue.ts`) with the
  cached menu per outlet and the order queue.
- Every captured order gets a permanent operation id which is also its `Idempotency-Key`.
  Sending it twice cannot create two orders; the cash payment uses `<operation id>-pay`.
- When the server is reachable again (`/health` probe), the queue is sent oldest first, only
  under the login of the person who captured each order.
- The order is sent with the total the operator quoted (`expectedTotalMinor`). If the server
  calculates a different total, it refuses rather than guessing.

## Statuses

| Status | Meaning |
|---|---|
| Waiting to send | Stored on the device; retried automatically |
| Sending | In progress |
| Synchronised | Confirmed by the server; shows the real order number |
| Needs attention | The server refused it; a person must decide |
| Discarded | A person gave up on it, with a reason (kept as a record) |

Network errors, server errors and expired sessions keep an order *waiting*. Nothing waiting or
needing attention is ever deleted automatically; only synchronised and discarded records older
than 7 days are cleared.

## Resolving conflicts (POS → "Offline orders")

| Problem | Choices |
|---|---|
| The total changed (prices or tax changed) | Accept new total · Discard |
| An item is no longer available | Remove item and send · Discard |
| Not enough stock | Try again after fixing stock · Discard |
| Order created but cash not recorded (no open shift, or cash less than the bill) | Open a shift and try again · Settle later from Orders |

## Limits to know

- The device must have opened the POS online at least once to have a menu saved.
- Offline orders live in one browser on one device. Clearing site data before they sync loses them.
- The session survives offline using a cached profile (name and permissions only, no
  credentials); the server re-checks everything at sync time.
- The service worker is only active in a production build (`pnpm --filter @serveos/web build`
  then `preview`), not in `pnpm dev:web`.

## Tested

`apps/web/src/offline/queue.test.ts` (14 tests) covers capture, ordering, retry with the same
id, payment after confirmation, each conflict resolution and the never-purge rule, and
`apps/api/src/test/orders.spec.ts` covers the server side (`PRICE_CONFLICT`, idempotent replay).
An end-to-end test that physically disconnects a browser has **not** been automated.
