# Architecture

ServeOS is one backend with several front ends. The backend owns every rule about money,
stock and permissions; the front ends show data and collect input.

```
apps/web  (POS + back office)  ─┐
apps/kds  (kitchen display)    ─┼─ HTTPS (REST /api/v1) + Socket.IO ─▶ apps/api (NestJS) ─▶ PostgreSQL
apps/mobile (owner app, Expo)  ─┘
                 packages/shared: request contracts (Zod), pricing engine, permission list
```

## Repository layout

| Path | What it is |
|---|---|
| `apps/api` | NestJS 11 REST API, Prisma 6, Socket.IO gateway. One file per feature in `src/modules/*.module.ts` (DTOs, service, controller, module). |
| `apps/web` | React 19 + Vite. POS (`src/pages/pos`), Tables, Orders, Cash shift, and the back office (`src/pages/admin`). Installable PWA. |
| `apps/kds` | React + Vite kitchen display. |
| `apps/mobile` | Expo / React Native app for owners and managers. |
| `packages/shared` | Code used by every app: `contracts.ts` (request schemas), `pricing.ts` (totals and tax), `access.ts` (permissions and roles), `orders.ts` (statuses and allowed transitions). |
| `packages/config` | Shared TypeScript config and design tokens (`tokens.css`). |
| `prisma` | `schema.prisma`, migrations, `integrity.sql` (hand-written constraints), `seed.ts`. |

## Key decisions

**Money is integers.** Every amount is stored in minor units (paise) in columns ending in
`Minor`; percentages are basis points (`Bps`). No floating point touches money. Stock quantities
are exact decimals (`numeric(18,4)`) in the ingredient's base unit.

**One pricing engine, server authoritative.** `packages/shared/src/pricing.ts` is a pure
function. The API calls it with prices and tax rules read from the database; the POS calls the
same function only to preview a cart. Requests never carry prices or totals (the Zod schemas
strip unknown fields), and the amount to pay always comes from the stored order.

**An order is one record with an append-only history.** `Order` holds the current state;
`OrderEvent` records every change with the actor. Allowed status changes and the permission
each needs are a single table, `ORDER_TRANSITIONS` in `packages/shared/src/orders.ts`:

```
DRAFT → PLACED → CONFIRMED → PREPARING → READY → COMPLETED → REFUNDED
           └────────┴────────────┴─────────┴──→ CANCELLED
CONFIRMED / PREPARING → COMPLETED is also allowed (outlets that do not use the kitchen display).
```

Financial rows are never deleted: mistakes are corrected with void, cancel, refund (with a
credit note) or stock adjustment rows.

**Snapshots.** Order lines copy the product name, price, tax rules and HSN/SAC at the time of
sale, and an issued invoice stores the full printed document, so later menu or tax edits cannot
change an old bill.

**Tenancy.** Every restaurant-owned table has `restaurantId`; outlet data also has `outletId`.
`AuthGuard` (`apps/api/src/common/access.service.ts`) builds a `RequestContext` from the
database on every request (session, role, permissions, assigned outlets) — nothing about
identity is trusted from the request body. Services always filter by `ctx.restaurantId` (and
`ctx.outletId`), and a record from another tenant answers 404, the same as a missing one.

**Roles.** Eight built-in roles with a numeric rank. You may only assign roles ranked below
your own, outlets you have yourself, and permissions you hold. Extra permissions can be granted
per user, optionally for a single outlet.

**Idempotency.** Creating an order, recording a payment and refunding take an
`Idempotency-Key`; the key is stored under a unique index, so a retry returns the first result.
Stock deduction, loyalty accrual, coupon use and webhook events each have their own
once-only guard (a guarded `UPDATE` or unique key).

**Concurrency.** Things that must not race are enforced by the database, not by application
checks: partial unique indexes (one open order per table, one open shift per register, one
active recipe per variant), row locks (`SELECT … FOR UPDATE` on the order while it is changed),
conditional updates (stock cannot go below zero; a refund cannot exceed the payment), and
per-outlet counters for order, invoice and credit-note numbers.

**Realtime is a hint, never the source of truth.** Socket.IO events only say "something about
order X changed"; clients re-read over REST, and re-read everything after each reconnect. A
dropped socket cannot lose an order.

**Inventory.** Ingredients, not menu items, are stocked. A sale consumes its recipe when the
order is confirmed (default), when it is completed, or never — a restaurant setting. Cancelling
or voiding returns stock only for items the kitchen had not started; refunds never return
stock. Theoretical stock (`InventoryBalance`, the sum of movements) is kept apart from physical
counts (`StockCount`), which correct it through explicit `COUNT_CORRECTION` movements.

**Integrations are ports with development adapters.** Payments (`PaymentGateway`), email
(`EmailService`) and file storage each have one clearly labelled development implementation.
See `docs/hardware.md` for what is and is not integrated.

## Where to look

| Question | File |
|---|---|
| How is a bill calculated? | `packages/shared/src/pricing.ts` |
| Who may do what? | `packages/shared/src/access.ts` |
| What happens when an order is placed, paid, completed, cancelled? | `apps/api/src/modules/orders.module.ts`, `payments.module.ts` |
| How does stock move? | `apps/api/src/modules/inventory.module.ts` (`applyMovement`) |
| How is a report number defined? | `METRIC_DEFINITIONS` in `apps/api/src/modules/reports.module.ts` |
| How does offline work? | `docs/offline-mode.md`, `apps/web/src/offline/queue.ts` |
