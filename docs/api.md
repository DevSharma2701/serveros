# API guide

Base URL: `http://localhost:4000/api/v1`. The complete, always-current reference with request
schemas is the Swagger page at **http://localhost:4000/api/docs** (JSON: `/api/docs-json`).
This page explains the conventions and lists the endpoint groups.

## Conventions

| Topic | Rule |
|---|---|
| Authentication | `Authorization: Bearer <access token>` (15 minutes). Refresh with `POST /auth/refresh`. |
| Outlet | Outlet data needs `X-Outlet-Id: <id>`; the user must be assigned to that outlet. |
| Money | Integers in minor units (paise): `10500` = ₹105.00. Percentages in basis points: `500` = 5%. |
| Quantities | Stock quantities are decimal strings (`"2.5"`), with a `unitId`. |
| Retries | `Idempotency-Key` header on `POST /orders` (optional), `POST /orders/:id/payments` and `POST /payments/:id/refunds` (required). Same key → same result. |
| Unknown fields | Ignored. You cannot set totals, status, `restaurantId` etc. from a request. |
| Errors | `{ "error": { "code", "message", "details", "correlationId" } }`. `code` is stable; `correlationId` matches the `X-Request-Id` response header and the server log. |
| Lists | `?page=1&pageSize=50` → `{ items, page, pageSize, total }`. |
| Rate limit | 600 requests/minute per IP; 10/minute on sign-in and password endpoints. |

Common error codes: `VALIDATION_FAILED` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404, also for other tenants' records), and 409s that need a decision:
`TABLE_OCCUPIED`, `ITEM_UNAVAILABLE`, `INSUFFICIENT_STOCK`, `PRICE_CONFLICT`, `PAYMENT_DUE`,
`OVERPAYMENT`, `PARTIAL_PAYMENT_NOT_ALLOWED`, `NO_OPEN_SHIFT`, `REFUND_REQUIRED`,
`VARIANCE_NEEDS_APPROVAL`, `INVALID_TRANSITION`.

## A complete sale, step by step

```
POST /auth/login                      {email, password, client: "mobile"}     → accessToken (+ refreshToken)
GET  /auth/me                                                                  → outlets, permissions
GET  /menu/catalog                    (X-Outlet-Id)                            → products, modifiers, tax rules
POST /shifts/open                     {registerId, openingFloatMinor}          (needed before taking cash)
POST /orders        Idempotency-Key   {type:"TAKEAWAY", items:[{clientLineId, productId, variantId, quantity, modifierOptionIds}]}
                                                                               → order, status CONFIRMED, totals, kitchen tickets created
POST /orders/:id/payments  Idempotency-Key  {tenders:[{method:"CASH", amountMinor, tenderedMinor}]}
                                                                               → paid, invoice issued
PATCH /kitchen/tickets/:id            {status:"PREPARING"} then {status:"READY"}   → order becomes PREPARING, then READY
POST /orders/:id/complete                                                      → COMPLETED, stock and loyalty settled
GET  /orders/:id/receipt                                                       → invoice document + printable text
GET  /reports/dashboard?from=2026-10-10&to=2026-10-10                          → the sale appears in the figures
```

## Endpoint groups

| Group | Endpoints (prefix `/api/v1`) | Main permissions |
|---|---|---|
| Auth | `auth/login`, `refresh`, `logout`, `me`, `sessions`, `password/forgot`, `password/reset`, `password/change` | — |
| Restaurant & outlets | `restaurant`, `outlets`, `platform/restaurants` | `restaurant.manage`, `outlet.manage`, `platform.manage` |
| Staff | `staff`, `staff/:id/grants`, `roles`, `attendance`, `schedules`, `audit-events` | `staff.view`, `staff.manage`, `audit.view` |
| Menu | `menu/catalog`, `menu/categories`, `menu/products`, `menu/products/:id/availability`, `menu/modifier-groups`, `tax-categories`, `discounts`, `uploads/product-image` | `menu.view`, `menu.manage`, `menu.availability`, `discount.manage` |
| Floor | `floor`, `dining-areas`, `tables`, `reservations` | `table.view`, `table.manage`, `reservation.manage` |
| Orders | `orders`, `orders/quote`, `orders/:id` (+ `place`, `items`, `items/:itemId/void`, `discount`, `complete`, `cancel`, `transfer-table`, `attach-table`, `merge`, `split`, `waiter`, `receipt`) | `order.*`, `table.transfer`, `discount.*` |
| Kitchen | `kitchen/tickets`, `kitchen/tickets/:id`, `kitchen/tickets/:id/items/:itemId`, `kitchen/stations` | `kitchen.view`, `kitchen.update`, `kitchen.manage` |
| Payments | `orders/:id/payments`, `payments`, `payments/:id/refunds`, `payments/:id/cancel`, `payments/:id/dev-simulate`, `payments/webhooks/:provider` | `payment.record`, `payment.refund` |
| Invoices | `invoices`, `orders/:id/receipt` | `report.view`, `order.view` |
| Cash | `registers`, `shifts`, `shifts/current`, `shifts/open`, `shifts/:id/movements`, `shifts/:id/close` | `shift.operate`, `shift.manage`, `shift.approve_variance` |
| Inventory | `units`, `ingredients`, `inventory/stock`, `inventory/movements`, `inventory/adjustments`, `inventory/transfers`, `inventory/counts`, `recipes`, `suppliers`, `purchase-orders`, `goods-receipts` | `inventory.view`, `inventory.manage`, `recipe.manage`, `purchasing.manage` |
| Customers | `customers`, `customers/:id`, `customers/:id/loyalty/adjust` | `customer.*`, `loyalty.adjust` |
| Reports | `reports/dashboard`, `reports/export.csv` | `report.view`, `report.export` |
| Guest ordering (public, no login) | `public/tables/:token`, `public/tables/:token/quote`, `public/tables/:token/orders`, `public/orders/:guestToken` (+ `pay`, `dev-pay`, `receipt`) | none — addressed by secret tokens |
| QR codes | `qr-codes`, `qr-codes/:tableId/regenerate`, `orders/:id/accept` | `table.manage`, `order.create` |
| Health | `health`, `health/ready`, `dev/outbox` (development only) | public |

## Realtime (Socket.IO)

Connect to the API origin with `auth: { token: <access token> }`, then
`emit('subscribe', { outletId }, ack)`. Events: `order.changed`, `kitchen.ticket.changed`,
`floor.changed`, `menu.changed`. Treat them as "refetch now" hints, and refetch after every
reconnect.

## Payment webhooks

`POST /payments/webhooks/:provider` is authenticated by signature, not by a user session. The
development provider signs the raw body with HMAC-SHA256 using `PAYMENT_WEBHOOK_SECRET` in the
`X-ServeOS-Signature` header. Each event id is processed once.
