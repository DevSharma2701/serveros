# ServeOS build checklist

Last updated 10 Oct 2026. **Done** means implemented with working backend logic and covered by
automated tests unless a note says otherwise. Anything not listed as done is not done.

Legend: ✅ done · 🟡 partly done (read the note) · ⬜ not done

## Phase 1 — Foundation
- ✅ pnpm monorepo: `apps/api`, `apps/web`, `apps/kds`, `apps/mobile`, `packages/shared`, `packages/config`
- ✅ PostgreSQL schema (60+ tables), migration, hand-written integrity constraints
- ✅ Environment validation at start-up; `.env.example`; secrets ignored by git
- ✅ Development seed (fictional restaurant, 2 outlets, menu, recipes, stock, users, sample orders)

## Phase 2 — Identity and tenancy
- ✅ Sign-in/out, Argon2id hashing, access + rotating refresh tokens, session list and revocation
- ✅ Password reset and staff invitations (🟡 Resend email adapter built but not yet exercised with a real key)
- ✅ Eight roles, permission catalogue, per-user and per-outlet grants, rank-based escalation rules
- ✅ Tenant and outlet isolation enforced in the API; audit log
- ✅ Account lockout, rate limiting, correlation ids, uniform errors
- ⬜ Custom roles (the tables support them; no API or screen)
- ⬜ Two-factor authentication, manager PIN override at the till

## Phase 3 — Menu, POS, orders
- ✅ Categories, products, variants, modifier groups, tax categories, outlet availability and prices, image upload
- ✅ POS: search, categories, favourites/popular, variants and add-ons, notes, cart, discounts, coupons, customer, hold/resume, keyboard shortcuts
- ✅ Server-authoritative pricing: tax (CGST/SGST/IGST), service and delivery charge, round-off
- ✅ Order lifecycle with explicit transitions, history, idempotent creation, void/cancel with reasons
- ⬜ Menu availability schedules (time-of-day menus)
- ⬜ Add-ons consuming stock (recipes are per product/variant only)

## Phase 4 — Kitchen and tables
- ✅ Kitchen tickets routed by station; item-level prepared state; order status derived from tickets
- ✅ Kitchen display app: live board, timers, overdue highlighting, filters, sound toggle, full screen, reconnect recovery
- ✅ Floor plan with derived table status; transfer, join, merge, split; reservations
- 🟡 Floor plan is a grid by area — tables are not drag-positioned on a drawn floor
- 🟡 Waiter assignment exists in the API; no screen to change it
- ⬜ Kitchen ticket printing

## Phase 5 — Cash, payments, receipts
- ✅ Registers, shifts, cash in/out, petty cash, expected vs counted, variance approval, closed shifts immutable
- ✅ Cash, manually recorded card/UPI, split tender, loyalty tender, refunds with credit notes
- ✅ Gateway abstraction with signed, idempotent webhooks, checkout verification and reconciliation (🟡 Razorpay adapter untested against the real service)
- ✅ Gap-free invoice numbering per outlet and financial year; immutable invoice snapshot; receipt text
- 🟡 Receipt printing through the browser only; "email receipt" not available
- ⬜ E-invoicing (IRN), GST return exports. **Tax output has not been reviewed by a tax professional.**

## Phase 6 — Inventory
- ✅ Ingredients, units and conversion, stock per outlet, movements ledger, low-stock flags
- ✅ Recipes with versions and costing; consumption on confirm or on complete; reversal rules; negative-stock control
- ✅ Wastage, adjustments, transfers, physical counts
- ✅ Suppliers, purchase orders, goods receipts (partial), weighted average cost
- 🟡 Supplier invoice details are fields on the goods receipt, not a separate payable ledger

## Phase 7 — Reports, customers, mobile
- ✅ Dashboard with defined metrics, breakdowns, trends, outlet comparison, cash variance, inventory alerts, CSV export
- ✅ Customers, consent flags, contact masking by role, loyalty ledger (earn, redeem, reverse, adjust)
- ✅ Staff list, invitations, schedules, attendance (clock in/out)
- 🟡 Mobile owner app: all screens built, 35 tests, bundles for Android/iOS — **never run on a device**
- ⬜ Push notifications (client scaffold only; no server sender)
- ⬜ Payroll (deliberately not built)

## Phase 8 — Offline and hardware
- ✅ Offline order capture with IndexedDB queue, idempotent sync, conflict resolution screen
- 🟡 Service worker (PWA) builds in production; not exercised in a real outage
- 🟡 Offline covers takeaway/pickup/delivery with cash only — by design
- ⬜ Thermal printer, cash drawer, scanner, card terminal, customer display

## Phase 10 — Guest ordering from table QR codes
- ✅ Per-table secret QR codes; print sheet; replace a code; switch per outlet
- ✅ Guest page (no login): menu, sizes and add-ons, cart, server-priced totals, order tracking, receipt
- ✅ Pay first, then straight to the kitchen; unpaid orders expire after 15 minutes
- ✅ Guest orders do not lock the table; shown on the floor plan, in Orders and on the kitchen display
- ✅ Paid-but-cannot-cook orders are held and flagged for staff (send or refund)
- 🟡 Razorpay adapter for guest payments: built and tested against a fake Razorpay (15 tests); **not yet run against real Razorpay** (needs test keys)
- 🟡 Tested in a desktop browser at phone size; not tried on a real phone over Wi-Fi
- ⬜ Guest loyalty/customer accounts, call-waiter, tips, sharing one order between payers

## Phase 9 — Hardening and release
- ✅ 291 automated tests passing (shared 14, API 150, web 69, KDS 23, mobile 35)
- ✅ Production builds: API, web, KDS
- ✅ Security checks in tests: IDOR, mass assignment, escalation, webhook forgery, CSV injection, upload type sniffing
- 🟡 `pnpm audit` reports advisories in indirect dependencies of framework tooling — not yet triaged
- ✅ One-time command to create a real restaurant and owner without demo data
- ✅ Product images stored in the database (survive redeploys, included in backups)
- ✅ Go-live checklist screen: shows which server settings are still on placeholders
- ✅ Development-only commands (reset, seed) refuse to run against a non-local database
- ✅ Backup command (`pnpm db:backup`); tried on the local database. Restore not yet rehearsed
- ✅ API boots in production mode with dev-only endpoints closed (rehearsed locally)
- ✅ API reference switched off in production by default; security headers for the hosted front ends
- 🟡 CI workflow and Render blueprint written, **not yet run** (need the GitHub repository and Render account)
- ⬜ Deployed anywhere (plan in docs/deployment.md; credentials list in docs/credentials.md)
- ⬜ Error alerting and uptime monitoring; load testing; linting; end-to-end browser suite checked into the repository

## Definition of done (section 25 of the brief)

| # | Requirement | State |
|---|---|---|
| 1 | Sign in and select an authorised outlet | ✅ |
| 2 | Create and manage menu items | ✅ |
| 3 | Open a POS session and create an order | ✅ |
| 4 | Select variants and modifiers | ✅ |
| 5 | Totals from authoritative backend rules | ✅ |
| 6 | Record a cash payment | ✅ |
| 7 | Generate an order receipt | ✅ (browser print) |
| 8 | Send the order to the kitchen | ✅ |
| 9 | Update to preparing and ready | ✅ |
| 10 | Complete with an auditable history | ✅ |
| 11 | Inventory consumption under the configured policy | ✅ |
| 12 | Transaction reflected in reports | ✅ |
| 13 | Same data from the mobile app | 🟡 verified at API level and in tests; app not run on a device |
| 14 | Permissions and tenant isolation throughout | ✅ |
