# Testing

## Running the tests

```
pnpm db:start     # the API tests need the database
pnpm test         # everything
```

| Package | Command | Tool | Last run (10 Oct 2026) |
|---|---|---|---|
| `packages/shared` | `pnpm --filter @serveos/shared test` | Vitest | 14 passed |
| `apps/api` | `pnpm test:api` | Jest + Supertest against a real PostgreSQL test database | 150 passed |
| `apps/web` | `pnpm --filter @serveos/web test` | Vitest + Testing Library (+ fake-indexeddb) | 69 passed |
| `apps/kds` | `pnpm --filter @serveos/kds test` | Vitest + Testing Library | 23 passed |
| `apps/mobile` | `pnpm --filter @serveos/mobile test` | jest-expo + React Native Testing Library | 35 passed |

The API tests use `TEST_DATABASE_URL` (database `serveos_test`), wipe it before each test file
and refuse to run if it is the same database as `DATABASE_URL`. They start the real application
and call it over HTTP, so they exercise guards, validation, transactions and SQL constraints —
nothing is mocked except the outside world (email, payment provider).

## What is covered

| Area | Where | Examples |
|---|---|---|
| Authentication | `api/src/test/auth-tenancy.spec.ts` | Wrong password, lockout, refresh rotation, logout, session revocation, password reset, invitations |
| Tenant isolation | same | Other restaurant's orders/products/customers/staff answer 404; foreign outlet 403; smuggled `restaurantId`/totals ignored |
| Privilege escalation | same | Cashier cannot grant itself roles or permissions; managers cannot assign equal or higher roles or outlets they lack |
| Pricing, tax, discounts | `shared/src/pricing.test.ts`, `api/src/test/orders.spec.ts` | Modifiers, inclusive/exclusive tax, IGST, discount thresholds, coupons, round-off, penny-exact allocation |
| Order creation and duplicates | `orders.spec.ts` | Same idempotency key 8× in parallel → one order; unique order numbers under concurrency |
| Order lifecycle | `orders.spec.ts` | Full place → pay → prepare → ready → complete history; cancel/void rules; menu changes do not alter old lines |
| Tables | `orders.spec.ts` | 6 parallel orders for one table → exactly one wins; transfer, join, merge, split |
| Kitchen | `api/src/test/kitchen.spec.ts`, `kds/src/pages/BoardPage.test.tsx` | Station routing, ticket states driving order status, live socket events, cross-tenant socket refusal, recovery after a dropped connection |
| Payments | `api/src/test/payments-cash.spec.ts` | Change, overpayment, split tender, retried payment charged once, forged/duplicate webhooks, failed-payment recovery, refunds never exceeding the payment under concurrency, sequential invoice numbers |
| Cash | same | Expected cash excludes digital payments; variance approval; closed shift is final |
| Inventory | `api/src/test/inventory.spec.ts` | Deducted once across status changes; policy options; reversal rules; 10 parallel orders for 3 units of stock → exactly 3 succeed; unit conversion; weighted cost; counts; transfers |
| Reports | `api/src/test/reports-customers.spec.ts` | Every headline figure from known orders; refunds and cancellations; an order at 00:30 local time lands on the right day; CSV permissions |
| Loyalty | same | Points earned once even if the event repeats; redemption as a tender; never negative |
| Guest QR ordering | `api/src/test/guest-ordering.spec.ts`, `web/src/pages/guest/GuestPage.test.tsx` | Nothing reaches the kitchen before payment; declined and repeated payments; token isolation; no data leaks; caps and expiry; held orders when stock runs out; replaced codes stop working |
| Production settings | `api/src/test/production.spec.ts`, `api/src/test/razorpay.spec.ts` | Images stored in the database and type-sniffed; go-live checklist leaks no secrets; API reference off; CORS; Razorpay signatures, webhooks, reconciliation and refunds against a fake Razorpay |
| POS interface | `web/src/pages/pos/*.test.ts(x)` | Product and modifier selection, cart totals, checkout validation, split payment request, status labels, role-based navigation |
| Offline queue | `web/src/offline/queue.test.ts` | Capture, retry with the same key, conflicts and each resolution, never dropping a failed order |
| Back office | `web/src/pages/admin/**/*.test.tsx` | Dashboard figures and empty state, export visibility, product form, stock table, customer form, settings |
| Mobile | `mobile/src/__tests__` | Login, token refresh and retry, outlet selection, dashboard data, network/403/500 states |

## Checked by hand in a real browser (headless Chromium, real API and database)

- POS: sign in → open shift → build an order with a size and add-ons → pay cash → change shown → tax invoice → order listed → table status.
- Guest ordering: staff switch it on and open a table code; at phone size a guest orders, pays through the simulator, sees progress and the invoice; the order appears in Orders and on the floor plan.
- Kitchen display: sign in, live tickets, filters, overdue marking, offline banner and recovery.
- Back office: every page loaded with real data; purchase order → partial and full receipt, stock count, transfer, wastage, recipe versions, product create with image, CSV download, schedule create/delete.

## Rehearsed by hand

- The built API started with `NODE_ENV=production`: health and database checks pass; the API reference, the dev outbox and the payment simulator endpoints all answer 404.
- `pnpm db:backup` wrote a backup of the local database. A restore has not been rehearsed.
- `create-restaurant` created a restaurant and owner in the test database.

## Not tested — know this before relying on it

- **The mobile app has never run on a phone or emulator.** It type-checks, passes its tests and
  bundles for Android and iOS; its API client was exercised against the live API. Screens are
  unseen on a device.
- **No thermal printer, scanner, card terminal or cash drawer** was connected. Printing is the
  browser's print dialog only.
- **Razorpay and Resend have never been called for real.** Both adapters are tested against stand-ins only; a real trial needs your keys.
- **Nothing has been deployed.** The CI workflow, the Render blueprint and the Cloudflare Pages settings are written but have not run.
- **QR ordering on a real phone** over Wi-Fi has not been tried (see `docs/qr-ordering.md`).
- **Offline mode** is unit-tested and its server side is integration-tested, but no automated
  test disconnects a real browser mid-sale; the service worker was built but not exercised.
- **Kitchen bump buttons and several back-office write actions** (staff invite/role change,
  customer create, loyalty adjust, outlet create) were verified through tests and API tests, not
  clicked in the browser, to keep the demo data intact.
- No load, performance, accessibility-audit or cross-browser testing. No end-to-end browser
  suite is checked into the repository (the browser checks above were one-off).
- No linter is configured; TypeScript strict mode is the only static check.
