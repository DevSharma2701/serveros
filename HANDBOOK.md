# ServeOS Handbook

The one document to read before touching this project: what it is, how it is put together,
how to run it on a new computer, how the live system is set up, every setting and key it
needs, and how to change things safely.

Last updated: 11 October 2026.

> **This repository is public.** No real password or key appears in this file, and none may
> ever be committed. Section 7 lists every key by name, says where its real value lives, and
> where to get a new one.

## Contents

1. [What ServeOS is](#1-what-serveos-is)
2. [Current status](#2-current-status)
3. [How it is built](#3-how-it-is-built)
4. [Folder map](#4-folder-map)
5. [Run it on a new computer](#5-run-it-on-a-new-computer)
6. [The live system](#6-the-live-system)
7. [Settings and keys](#7-settings-and-keys)
8. [Accounts: how each was set up](#8-accounts-how-each-was-set-up)
9. [Everyday commands](#9-everyday-commands)
10. [How to change things](#10-how-to-change-things)
11. [Releasing a change](#11-releasing-a-change)
12. [Rules the code must keep](#12-rules-the-code-must-keep)
13. [Decisions and why](#13-decisions-and-why)
14. [Known gaps](#14-known-gaps)
15. [Troubleshooting](#15-troubleshooting)
16. [Where to read more](#16-where-to-read-more)

---

## 1. What ServeOS is

A restaurant operating system for one restaurant with one or more outlets. One backend serves
several screens:

| Who | Uses | For |
|---|---|---|
| Guest | Their own phone, no login | Scan the table QR code, order, pay online, track the order |
| Waiter, cashier | Web app | Point of sale, tables, orders, payments, cash shift |
| Kitchen staff | Kitchen display | Tickets by station: start, ready |
| Inventory manager | Web app back office | Ingredients, recipes, stock, purchasing |
| Manager, owner | Web app back office, mobile app | Menu, staff, reports, refunds, settings |

One order flows through all of them: created (by staff or a guest) → priced by the server →
sent to the kitchen → paid → completed → stock, reports, loyalty and the audit log update.

## 2. Current status

**Live, in test mode.** The system runs at the owner's domain and a full guest order has been
placed and paid through Razorpay's test mode. It has not yet served a real customer.

| Area | State |
|---|---|
| Code, 292 automated tests, CI on every push | Working |
| Hosting, database, domain, HTTPS | Live |
| Email (Resend) | Configured; delivery to the inbox was not confirmed by the owner yet |
| Online payment (Razorpay) | Working with **test** keys; live keys need Razorpay's business verification |
| Mobile app | Built and tested, **never run on a phone** |
| Thermal printer, cash drawer, card terminal | Not integrated (receipts print through the browser) |
| Tax output | Arithmetically tested; **not reviewed by a tax professional** |

The honest feature-by-feature list is `docs/CHECKLIST.md`. In the app, **Setup → Go-live
checklist** shows what is still on a placeholder.

## 3. How it is built

```
Guest phone ─┐
Web app      ─┼─ HTTPS (REST /api/v1) + Socket.IO ─▶ API (NestJS) ─▶ PostgreSQL
Kitchen      ─┤                                        │
Mobile app   ─┘                                        ├─▶ Razorpay (payments)
                                                       └─▶ Resend (email)
packages/shared: request contracts, pricing engine, permission list (used by every app)
```

| Piece | Technology |
|---|---|
| API | Node.js, NestJS 11, Prisma 6, PostgreSQL 17, Socket.IO, Zod 4, TypeScript 5.9 |
| Web app, kitchen display | React 19, Vite 7, Tailwind CSS 4, TanStack Query, React Router 7 |
| Mobile | Expo SDK 57, React Native 0.86, Expo Router |
| Tests | Jest + Supertest (API, against a real PostgreSQL), Vitest + Testing Library (web, kitchen), jest-expo (mobile) |
| Tooling | pnpm 10 workspaces, GitHub Actions |

Ideas that explain most of the code:

- **Money is whole paise.** Columns ending `Minor` are integers in paise; `Bps` are basis points
  (500 = 5%). No decimals touch money.
- **The server decides every price.** `packages/shared/src/pricing.ts` is one pure function. The
  API runs it on prices read from the database; screens run the same function only to preview.
  Requests never carry prices, and unknown fields in a request are dropped.
- **An order is one record plus an append-only history** (`Order`, `OrderEvent`). Allowed status
  changes and the permission each needs are one table: `ORDER_TRANSITIONS` in
  `packages/shared/src/orders.ts`.
- **Nothing financial is deleted.** Mistakes are corrected with void, cancel, refund or
  adjustment rows, each with a reason and an audit entry.
- **Every restaurant's data is isolated in the API.** Each request's identity, restaurant,
  outlets and permissions are loaded from the database by `AuthGuard`
  (`apps/api/src/common/access.service.ts`); services filter by them.
- **Retries are safe.** Creating an order, paying and refunding take an `Idempotency-Key`.
- **Live updates are hints.** Socket messages only say "something changed"; screens re-read
  from the API, and again after every reconnect.
- **Guest orders are pay-first.** A QR order reaches the kitchen only after its payment is
  verified by the server.

## 4. Folder map

| Path | What is in it |
|---|---|
| `apps/api/src/modules/*.module.ts` | One file per feature: request types, service (the logic), controller (the URLs), module |
| `apps/api/src/modules/gateways.ts` | Payment provider adapters (Razorpay, development simulator) |
| `apps/api/src/common/` | Sign-in guard, errors, database client, audit, email, live updates, helpers |
| `apps/api/src/config/env.ts` | Every setting the API reads, validated at start-up |
| `apps/api/src/test/` | API tests and the test harness |
| `apps/api/src/create-restaurant.ts`, `seed-orders.ts` | One-off commands |
| `apps/web/src/pages/pos/` | Point of sale (cart logic in `cart.ts`) |
| `apps/web/src/pages/guest/` | Guest QR ordering page |
| `apps/web/src/pages/admin/` | Back office, in `insights`, `catalogue`, `stock`, `people`, `setup` |
| `apps/web/src/pages/` | `Floor.tsx` (tables), `Orders.tsx`, `Shift.tsx`, `Login.tsx` |
| `apps/web/src/components/ui.tsx` | Design-system components (buttons, dialogs, tables...) |
| `apps/web/src/offline/` | Offline order queue (IndexedDB) |
| `apps/web/src/lib/` | API client, sign-in state, formatting, live updates |
| `apps/kds/` | Kitchen display |
| `apps/mobile/` | Owner/manager phone app |
| `packages/shared/src/` | `contracts.ts`, `pricing.ts`, `access.ts`, `orders.ts` |
| `packages/config/` | Shared TypeScript config and design tokens (`tokens.css`) |
| `prisma/schema.prisma` | The database design |
| `prisma/migrations/` | Database changes, in order |
| `prisma/integrity.sql` | Hand-written safety rules that were added to the first migration |
| `prisma/seed.ts` | Demo data for development only |
| `scripts/` | Local database start/stop/init, backup, the guard that protects real databases |
| `render.yaml` | Defines the live API and web site on Render |
| `.github/workflows/ci.yml` | Automatic checks on every push |
| `docs/` | Detailed guides (section 16) |

## 5. Run it on a new computer

### What to install

| Tool | Version | Note |
|---|---|---|
| Node.js | 20 or newer (22 recommended) | nodejs.org |
| pnpm | 10 | `npm install -g pnpm` |
| Git | any recent | |
| PostgreSQL | 15 or newer | Only its programs are used; ServeOS runs its own private database on port 5433 |

### Windows

```
git clone https://github.com/DevSharma2701/serveros.git
cd serveros
pnpm install
pnpm db:init          # creates the private database and a .env with fresh secrets
pnpm build:shared
pnpm db:deploy        # creates the tables
pnpm db:seed          # demo restaurant, menu, stock, users
pnpm db:seed:orders   # optional: a week of sample orders
```

`pnpm db:init` writes a complete `.env` for development. **No external key is needed to
develop**: payments use a simulator and emails go to a local outbox. It refuses to run if a
database or `.env` already exists, so it cannot overwrite anything.

### macOS or Linux

The `db:start`, `db:stop` and `db:init` scripts are Windows PowerShell scripts. Instead:

1. Start PostgreSQL yourself and create two databases, `serveos_dev` and `serveos_test`.
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `DIRECT_URL`,
   `TEST_DATABASE_URL`, two different JWT secrets, a 32+ character `PAYMENT_WEBHOOK_SECRET`
   and a `SEED_DEMO_PASSWORD` of 10+ characters. The file explains how to generate each.
3. Continue from `pnpm build:shared` above.

### Start working

```
pnpm db:start     # Windows: start the database (after every reboot)
pnpm dev:api      # terminal 1: API            http://localhost:4000  (reference at /api/docs)
pnpm dev:web      # terminal 2: web app        http://localhost:5173
pnpm dev:kds      # terminal 3: kitchen screen http://localhost:5174
pnpm dev:mobile   # terminal 4: phone app (see apps/mobile/README.md)
```

Demo sign-ins (development database only). The password for all of them is the value of
`SEED_DEMO_PASSWORD` in your `.env`:

| Email | Role |
|---|---|
| `owner@saffrontable.test` | Owner, both demo outlets |
| `manager@saffrontable.test` | Outlet manager |
| `cashier@saffrontable.test` | Cashier |
| `waiter@saffrontable.test` | Waiter |
| `kitchen@saffrontable.test` | Kitchen staff (sign in at the kitchen display) |
| `inventory@saffrontable.test` | Inventory manager |

Invitation and reset emails are not sent in development; read them at
`http://localhost:4000/api/v1/dev/outbox`.

### Moving your existing setup to another computer

Development data is disposable, so the simplest move is a fresh setup as above. To keep your
exact local settings instead, copy your `.env` file to the new machine yourself (USB or a
password manager, never email, chat or git) and skip `pnpm db:init`.

The live system does not depend on any computer: it runs on Render and Neon.

## 6. The live system

| Piece | Where | Address |
|---|---|---|
| Web app, guest QR page | Render static site `serveos-web` | `https://app.serveros.me` |
| Kitchen display | Same site, in a folder | `https://app.serveros.me/kitchen/` |
| Guest ordering link | Same site | `https://app.serveros.me/t/<table code>` |
| API | Render web service `serveos-api` (free plan, Singapore) | `https://api.serveros.me` |
| Database | Neon project `serveros`, PostgreSQL 17, Singapore | — |
| DNS | Namecheap (Advanced DNS) | `serveros.me` |
| Email | Resend, sending as `no-reply@serveros.me` | — |
| Payments | Razorpay (test mode) | — |
| Code and checks | GitHub `DevSharma2701/serveros` (public), GitHub Actions | — |

**How a release reaches it:** push to the `main` branch on GitHub. GitHub runs the checks;
Render rebuilds the API (applying database migrations when it starts) and the web site.
`render.yaml` is the source of truth for both services.

**DNS records at Namecheap** (keep all of these):

| Type | Host | Points to | Purpose |
|---|---|---|---|
| CNAME | `api` | `serveos-api-qx2c.onrender.com` | API |
| CNAME | `app` | `serveos-web.onrender.com` | Web app and kitchen display |
| TXT | `resend._domainkey` | key from Resend | Email signing |
| CNAME | `rsend` | value from Resend | Email |
| CNAME | `send` | value from Resend | Email |
| TXT | `_dmarc` | `v=DMARC1; p=none;` | Email policy |
| A ×4, CNAME `www` | `@`, `www` | GitHub Pages addresses | Not used by ServeOS; harmless |

Leftovers that can be deleted: the Render site `serveos-kitchen` and the Namecheap CNAME
`kitchen` (the kitchen display moved to `/kitchen/`).

**The restaurant in production** was created with `pnpm create-restaurant` (outlet code `TBO`,
so invoices are numbered `TBO/<financial year>/00001`...). It contains test data from the first
payment trial; see section 14.

## 7. Settings and keys

### Where real values live

| For | Real values are kept in | How to change |
|---|---|---|
| Development on a computer | The file `.env` in the project folder (git ignores it) | Edit, then restart `pnpm dev:api` |
| The live API | Render → `serveos-api` → **Environment** | Edit, **Save changes**; Render restarts the API |
| The live web app's addresses | `render.yaml` (they are public) | Edit, push |
| Mobile app | `apps/mobile/.env.local` | Edit, restart Expo |

**Never** put a secret in `render.yaml`, in a `VITE_...` or `EXPO_PUBLIC_...` value (those are
visible to everyone), in this file, in chat or in email. The API checks its settings when it
starts and stops with the name of anything wrong, without printing values.

### Every setting

"Secret" means: treat like a password.

| Setting | Secret | Development value | Live value | Get it from |
|---|---|---|---|---|
| `NODE_ENV` | no | `development` | `production` | — |
| `PORT` | no | `4000` | set by Render | — |
| `DATABASE_URL` | **yes** | local database, port 5433 | Neon **pooled** connection string | Neon → project → Connect |
| `DIRECT_URL` | **yes** | same as above | Neon **direct** connection string | Neon → project → Connect |
| `TEST_DATABASE_URL` | yes | local `serveos_test` | not used | — |
| `JWT_ACCESS_SECRET` | **yes** | generated by `db:init` | generated by Render | see command below |
| `JWT_REFRESH_SECRET` | **yes** | generated by `db:init` | generated by Render | must differ from the access secret |
| `WEB_URL` | no | `http://localhost:5173` | `https://app.serveros.me` | — |
| `API_URL` | no | `http://localhost:4000` | `https://api.serveros.me` | — |
| `CORS_ORIGINS` | no | localhost addresses | `https://app.serveros.me` | browser addresses allowed to call the API |
| `PAYMENT_PROVIDER` | no | `dev` (simulator) | `razorpay` | `none`, `dev` or `razorpay` |
| `PAYMENT_API_KEY` | no | empty | Razorpay **Key Id** (`rzp_test_...` / `rzp_live_...`) | Razorpay → Account & Settings → API Keys |
| `PAYMENT_API_SECRET` | **yes** | empty | Razorpay **Key Secret** | same place; shown once |
| `PAYMENT_WEBHOOK_SECRET` | **yes** | generated by `db:init` | the secret typed into the Razorpay webhook | you invent it |
| `STORAGE_PROVIDER` | no | `local` | `database` | where product images are kept |
| `EMAIL_PROVIDER` | no | `dev` (nothing sent) | `resend` | — |
| `EMAIL_API_KEY` | **yes** | empty | Resend key (`re_...`) | Resend → API Keys |
| `EMAIL_FROM` | no | placeholder | `Your Restaurant <no-reply@serveros.me>` | must be on the verified domain |
| `API_DOCS` | no | not set (on) | not set (off) | `on` shows the API reference in production |
| `SEED_DEMO_PASSWORD` | yes | generated by `db:init` | **never set** | demo users only |
| `VITE_API_URL` | no (public) | not set (localhost) | `https://api.serveros.me` | in `render.yaml` |
| `VITE_KDS_URL` | no (public) | not set (localhost) | `https://app.serveros.me/kitchen/` | in `render.yaml` |
| `EXPO_PUBLIC_API_URL` | no (public) | computer's network address | `https://api.serveros.me` | `apps/mobile/.env.local` |
| `PROD_DATABASE_URL`, `PROD_DIRECT_URL` | **yes** | optional lines in a developer's `.env` | — | only used to run one-off commands against Neon |

Generate a random secret:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### What `.env` looks like (placeholders only)

```
NODE_ENV=development
PORT=4000
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5433/serveos_dev?schema=public
DIRECT_URL=postgresql://USER:PASSWORD@localhost:5433/serveos_dev?schema=public
TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5433/serveos_test?schema=public
JWT_ACCESS_SECRET=<random, 48+ bytes>
JWT_REFRESH_SECRET=<a different random value>
WEB_URL=http://localhost:5173
API_URL=http://localhost:4000
CORS_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:8081
PAYMENT_PROVIDER=dev
PAYMENT_API_KEY=
PAYMENT_API_SECRET=
PAYMENT_WEBHOOK_SECRET=<random, 32+ characters>
STORAGE_PROVIDER=local
EMAIL_PROVIDER=dev
EMAIL_API_KEY=
EMAIL_FROM=ServeOS <no-reply@serveos.local>
SEED_DEMO_PASSWORD=<10+ characters>
```

To try Razorpay or Resend from a development computer, fill in the empty keys and switch the
two `..._PROVIDER` lines. Razorpay cannot reach `localhost`, so its webhooks will not arrive;
payments still complete through the page's signed return and the once-a-minute check.

### If a secret leaks

| Secret | What to do |
|---|---|
| Razorpay key secret | Razorpay → regenerate the key → update Render |
| Razorpay webhook secret | Edit the webhook's secret in Razorpay → update Render |
| Resend key | Delete it in Resend, create another → update Render |
| Database password | Neon → reset the role's password → update both connection strings in Render |
| JWT secrets | Put new values in Render; everyone has to sign in again |
| A table's QR code | App → Setup → Table QR codes → Replace; reprint that code |

## 8. Accounts: how each was set up

The same steps recreate the whole live system from nothing. `docs/credentials.md` and
`docs/deployment.md` have more detail.

### GitHub (code)
1. Create a repository. Push the code: `git remote add origin <address>`, `git push -u origin main`.
2. Nothing else: `.github/workflows/ci.yml` runs the checks on every push.

### Neon (database)
1. neon.tech → new project: PostgreSQL 17, region Singapore. Only "Postgres database" is needed.
2. **Connect** → copy two strings: with "Pooled connection" on (`DATABASE_URL`) and off (`DIRECT_URL`).
3. Tables are created automatically the first time the API starts on Render. To do it by hand:
   run `pnpm db:deploy` with those two values set.

### Render (API and web site)
1. render.com → sign in with GitHub → **New → Blueprint** → choose the repository.
2. It reads `render.yaml` and asks for two values: `DATABASE_URL` and `DIRECT_URL` from Neon.
3. It creates `serveos-api` (the API) and `serveos-web` (web app plus kitchen display).
4. `serveos-api` → **Settings → Custom Domains** → add `api.serveros.me`. The web site's domain
   `app.serveros.me` is declared in the blueprint.
5. Add the email and payment values later under `serveos-api` → **Environment** (see below).

### Namecheap (domain)
1. Domain List → the domain → **Advanced DNS** → add the records in section 6.
2. Type only the short name in **Host** (`api`, not `api.serveros.me`), and click the green tick
   to save each record. Certificates are issued by Render a few minutes after a record appears.

### Create the restaurant (once)
With `DATABASE_URL` and `DIRECT_URL` pointing at Neon, and `WEB_URL=https://app.serveros.me`:

```
pnpm create-restaurant -- --name "Restaurant Name" --legal-name "Legal Name" --owner-name "Owner" --owner-email owner@example.com --outlet "Outlet Name" --code ABC --state 09 --city Noida
```

`--code` is 2 to 5 capital letters or digits, appears in every invoice number and cannot change
after the first order. `--state` is the GST state code. The command emails the owner a link to
choose a password, or prints the link if email is not configured yet.

### Resend (email)
1. resend.com → **Domains → Add Domain** → `serveros.me`.
2. Add the DNS records it shows to Namecheap (the "Go to Namecheap" button can do it for you).
3. When the domain shows **Verified**: **API Keys → Create** with "Sending access".
4. Render → `serveos-api` → Environment: `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY=<key>`,
   `EMAIL_FROM=Your Restaurant <no-reply@serveros.me>`.

### Razorpay (online payment)
1. razorpay.com → sign up. Keep **Test Mode** on until you are ready for real money.
2. **Account & Settings → API Keys → Generate Test Key**: note the Key Id and Key Secret.
3. **Account & Settings → Webhooks → Add New Webhook**:
   - URL `https://api.serveros.me/api/v1/payments/webhooks/razorpay`
   - Secret: a random string of 16+ characters that you invent
   - Events: `order.paid` and `payment.captured`
4. Render → `serveos-api` → Environment: `PAYMENT_PROVIDER=razorpay`, `PAYMENT_API_KEY`,
   `PAYMENT_API_SECRET`, `PAYMENT_WEBHOOK_SECRET`.
5. Test payments: in Razorpay's test window use **Netbanking → any bank → Success**. The card
   `4111 1111 1111 1111` is refused as international.
6. **Going live:** finish Razorpay's business verification, generate live keys, add a second
   webhook in live mode with the same URL, replace the three values in Render.

### Mobile (later)
Expo account, Apple Developer and Google Play accounts. See `apps/mobile/README.md`.

## 9. Everyday commands

Run from the project folder.

| Command | What it does |
|---|---|
| `pnpm db:start` / `pnpm db:stop` | Start / stop the private development database (Windows) |
| `pnpm dev:api`, `dev:web`, `dev:kds`, `dev:mobile` | Run each app for development |
| `pnpm build:shared` | Rebuild `packages/shared`. **Run after changing anything in it** |
| `pnpm test` | Every test (the database must be running) |
| `pnpm test:api` | API tests only |
| `pnpm typecheck` | Type-check every package |
| `pnpm build` | Production builds of shared, API, web, kitchen |
| `pnpm db:migrate` | After editing `prisma/schema.prisma`: create and apply a migration (local only) |
| `pnpm db:deploy` | Apply existing migrations to the database in `DATABASE_URL` |
| `pnpm db:generate` | Regenerate the database client |
| `pnpm db:studio` | Browse the database in a browser |
| `pnpm db:seed`, `pnpm db:seed:orders` | Demo data (local only) |
| `pnpm db:reset` | **Erase the development database** and recreate the tables (local only) |
| `pnpm db:backup` | Save a backup file under `backups/` |
| `pnpm create-restaurant -- ...` | Create a real restaurant and owner |

`db:migrate`, `db:seed`, `db:seed:orders` and `db:reset` refuse to run unless the database is on
your own computer. That guard (`scripts/guard-local-db.mjs`) is what keeps them away from Neon.

## 10. How to change things

### Something on a screen
Find the page under `apps/web/src/pages/` (section 4). Build from the components in
`apps/web/src/components/ui.tsx`; colours and spacing come from `packages/config/tokens.css`.

### A price, tax or discount rule
`packages/shared/src/pricing.ts`, with its tests in `pricing.test.ts`. Then
`pnpm build:shared`. Both the API and the POS preview pick it up.

### Who may do what
`packages/shared/src/access.ts`: the permission list and what each role gets. The API writes
these to the database every time it starts. Then `pnpm build:shared`.

### What an order may do next
`ORDER_TRANSITIONS` in `packages/shared/src/orders.ts`; the behaviour of each step is in
`apps/api/src/modules/orders.module.ts`.

### A new field on something
1. Add it to `prisma/schema.prisma`.
2. `pnpm db:migrate` and give the migration a short name. Commit the new folder under
   `prisma/migrations/`.
3. Add it to the request schema in `packages/shared/src/contracts.ts` if clients send it, then
   `pnpm build:shared`.
4. Use it in the feature's `*.module.ts` and on the screen.
5. On release, Render applies the migration automatically before the API starts.

If `pnpm db:migrate` says it needs an interactive terminal, generate the migration from a diff
instead, as was done for `qr_ordering` and `stored_files`:
`prisma migrate diff --from-url "<local DATABASE_URL>" --to-schema-datamodel prisma/schema.prisma --script`
into a new `prisma/migrations/<timestamp>_<name>/migration.sql`, then `pnpm db:deploy`.

### A new API address
In the feature's `*.module.ts`: add a request class from a Zod schema, a service method, and a
controller method with `@RequirePermissions(...)` (and `@OutletScoped()` for outlet data).
Always filter by `ctx.restaurantId` (and `ctx.outletId`). Add a test in `apps/api/src/test/`.

### A new back-office page
Create the page in the right folder under `apps/web/src/pages/admin/` and add one line to that
folder's `routes.tsx` (path, label, icon, permission). The sidebar and routing follow.

### Another payment provider
Implement the `PaymentGateway` interface in `apps/api/src/modules/gateways.ts`, add it to
`createGateway()`, and add its name to `PAYMENT_PROVIDER` in `apps/api/src/config/env.ts`.
Copy the pattern of `apps/api/src/test/razorpay.spec.ts`, which tests against a fake provider.

### Email wording
`apps/api/src/modules/auth.module.ts` (`sendInvite`, `forgotPassword`).

### Receipt layout
`renderReceiptText` in `apps/api/src/modules/billing.module.ts` (42 characters wide).

### A setting
Add it to `apps/api/src/config/env.ts`, to `.env.example`, to `render.yaml` if it is not a
secret, and to the table in section 7.

## 11. Releasing a change

1. Make the change. Add or update a test.
2. `pnpm build:shared` if you touched `packages/shared`.
3. `pnpm typecheck` and `pnpm test`.
4. Commit and `git push`. GitHub runs the same checks on a clean machine.
5. Render deploys by itself in two to three minutes. Check
   `https://api.serveros.me/api/v1/health/ready` and open the app.

Before a release that changes the database, take a backup: run `pnpm db:backup` with
`DIRECT_URL` set to Neon's direct string. Migrations only go forward.

## 12. Rules the code must keep

Breaking one of these is a bug even if every screen still works.

1. Money is integer paise; never accept a price, total, tax or payment status from a client.
2. Never delete an order, payment, refund, invoice, cash movement or stock movement. Correct
   with a new row, a reason and an audit entry.
3. Every query for restaurant data filters by the caller's restaurant, and by outlet where the
   data belongs to one. A record from another restaurant answers "not found".
4. Permissions are enforced in the API. Hiding a button is only tidiness.
5. Anything a retry could duplicate (order, payment, refund, stock deduction, loyalty points,
   webhook) has its own once-only guard.
6. Things that must not race are enforced by the database: unique indexes, row locks,
   conditional updates. `prisma/integrity.sql` holds the hand-written ones.
7. A gateway payment counts only after the server verifies the provider's signature.
8. Guest (public) endpoints expose the menu and the guest's own order, nothing else, and are
   addressed by unguessable codes.
9. No secret in the repository, in logs, or in an error shown to a user.
10. Do not describe something as working unless it was run.

## 13. Decisions and why

| Decision | Why |
|---|---|
| NestJS 11, TypeScript 5.9, Vite 7, Prisma 6 instead of the newest majors | When the project started, the libraries joining them had not caught up with the newest releases |
| Private PostgreSQL on port 5433 for development | The machine's existing PostgreSQL needed a password that was not available; this also keeps development isolated |
| No Redis | Nothing needs it with one API instance. Add it for rate limiting and live updates if you ever run two |
| Hosting on Render, not Vercel | Vercel's free plan forbids commercial use, and it cannot run a long-lived API |
| Hosting on Render, not Cloudflare Pages | Cloudflare's current setup needed extra configuration and moving DNS; Render already hosted the API |
| Kitchen display at `/kitchen/`, not its own subdomain | Render's free workspace would not attach a third custom domain |
| The web app and API share one domain | The sign-in cookie is only sent between addresses on the same site |
| Product images stored in the database | Render wipes the server's disk on every deploy; this needs no extra service and is included in backups |
| Guest orders are pay-first, with no staff approval | Payment is what stops someone with a photo of a QR code from sending orders to the kitchen |
| Each guest order is its own prepaid bill and does not lock the table | Several guests can order and pay separately; a waiter can still run a bill there |
| Card and UPI at the counter are recorded by hand | Staff take them on their own device; Razorpay is used for guest QR orders only |
| Unpaid guest orders expire after 15 minutes (45 if a payment is in progress) | Clears abandoned carts without cancelling under someone who is paying |
| DNS stays at Namecheap | Only subdomains are needed; no reason to move the domain |

## 14. Known gaps

Before real customers:

- **Razorpay is in test mode.** Live keys need Razorpay's business verification.
- **Test data in production.** The live database holds a test order and has used invoice
  number 00001. Clear it before the first real sale so numbering starts clean. This must be
  done deliberately, with a backup first.
- **The API is on Render's free plan and sleeps** after 15 idle minutes; the first request then
  takes about a minute. Change `plan: free` to `plan: starter` in `render.yaml` (a paid plan).
- **Email delivery was not confirmed.** Check the Go-live checklist's Email line and that a
  reset email arrives. The sender name in Render's `EMAIL_FROM` should match the restaurant.
- **Tax review** by a qualified professional; **privacy notice**, since customer phone numbers
  are stored.
- **Backups:** confirm what the Neon plan keeps, and practise one restore.
- **No error alerting or uptime monitoring.**

Not built or not verified:

- Mobile app never run on a phone; not published. Push notifications are a scaffold only.
- Thermal printer, kitchen ticket printing, cash drawer, barcode scanner, card terminal.
- Offline mode has not been tried in a real outage. It covers takeaway, pickup and delivery
  with cash only, by design.
- Custom roles, time-of-day menus, payroll, e-invoicing and GST return exports.
- Guest accounts and loyalty on the QR page, call-waiter, tips.
- No linter, no end-to-end browser tests in the repository, no load testing.
- `pnpm audit` reports advisories in indirect framework dependencies that were not triaged.

## 15. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| API stops with "Invalid environment configuration" | The message names the setting. Compare with section 7 |
| API cannot reach the database (development) | `pnpm db:start` |
| "Port 4000 / 5173 is already in use" | Another copy is running; close that terminal |
| `prisma generate` fails with EPERM on Windows | A running API has the file open. Stop `pnpm dev:api`, run it again |
| Changed `packages/shared` and nothing happened | `pnpm build:shared` |
| Signed in, but a reload signs you out (live) | The web app and API are not on the same domain, or `CORS_ORIGINS` lacks the web address |
| Browser says a request was blocked by CORS | Add that exact web address to `CORS_ORIGINS` in Render |
| First request to the live app takes a minute | The free API plan was asleep (section 14) |
| A custom domain has no certificate after 20 minutes | Check the CNAME at Namecheap; Render's free workspace attaches only two custom domains |
| Guest page says "This QR code is not active" | QR ordering is off for the outlet, or the code was replaced |
| Guest paid but the order is not in the kitchen | Open it in Orders: a warning explains why (usually stock). Send it or refund it |
| Razorpay window says international cards are not supported | Use Netbanking → Success in test mode |
| Cash payment refused: "Open a cash shift" | Open a shift on the Cash shift page |
| Staff never receive invitations | Email is not configured, or went to spam. Check the Go-live checklist |
| Render deploy failed | Read the last lines of the deploy log; a bad setting is named there |

## 16. Where to read more

| File | Covers |
|---|---|
| `README.md` | Short introduction |
| `docs/setup.md` | Running locally, demo accounts, first walk-through, POS keyboard shortcuts |
| `docs/CHECKLIST.md` | Honest status of every feature |
| `docs/architecture.md` | Design in more depth |
| `docs/api.md` | API conventions, endpoint groups, a sale step by step |
| `docs/credentials.md` | Each credential in detail |
| `docs/deployment.md` | Deployment steps and what is still to do |
| `docs/qr-ordering.md` | Guest ordering and Razorpay behaviour |
| `docs/offline-mode.md` | What works without internet |
| `docs/hardware.md` | Printers, payments, email, tax: what is real |
| `docs/testing.md` | What is tested and what is not |
| `apps/mobile/README.md` | Running the phone app |
