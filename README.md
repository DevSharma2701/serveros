# ServeOS

A restaurant operating system: point of sale, tables, kitchen display, menu, inventory and
recipes, purchasing, cash shifts, customers and loyalty, reports, guest ordering from table
QR codes, and an owner mobile app —
all on one backend, for restaurants with one or many outlets.

> **Status: working development build.** The core flow — sign in, take an order, pay, cook,
> complete, see it in stock and reports — works end to end and is covered by 291 automated
> tests. It has not been deployed, has no real payment gateway, email or printer integration,
> and its tax output has not been reviewed by a tax professional. See
> [docs/CHECKLIST.md](docs/CHECKLIST.md) for exactly what is and is not done.

## Start here

```
pnpm db:start     # database (after every reboot)
pnpm dev:api      # API            http://localhost:4000   (docs: /api/docs)
pnpm dev:web      # POS + office   http://localhost:5173
pnpm dev:kds      # kitchen screen http://localhost:5174
```

Sign in with `cashier@saffrontable.test` (or `owner@…`, `manager@…`, `kitchen@…`); the password
is `SEED_DEMO_PASSWORD` in your `.env` file. Full instructions, all demo accounts and a first
walk-through are in **[docs/setup.md](docs/setup.md)**.

## What is in the box

| App | Folder | For |
|---|---|---|
| API | `apps/api` | Every rule about money, stock and permissions (NestJS, Prisma, PostgreSQL) |
| Web | `apps/web` | Cashiers, waiters, managers, owners: POS, tables, orders, cash, back office |
| Kitchen display | `apps/kds` | Kitchen screens |
| Mobile | `apps/mobile` | Owners and managers on the move (Expo) |
| Shared | `packages/shared` | Pricing engine, request contracts, permission list |

## Documentation

| | |
|---|---|
| [Handbook](HANDBOOK.md) | Start here: the whole project, the live setup, every setting and key, how to change things |
| [Setup and daily use](docs/setup.md) | Install, run, demo logins, shortcuts, troubleshooting |
| [Checklist](docs/CHECKLIST.md) | Honest status of every feature |
| [Credentials](docs/credentials.md) | Every key and setting you must provide, where to get it, where to put it |
| [Architecture](docs/architecture.md) | How it fits together and why |
| [API guide](docs/api.md) | Conventions, endpoint groups, a sale step by step |
| [QR table ordering](docs/qr-ordering.md) | Guests order and pay from their phone; how to set it up |
| [Offline mode](docs/offline-mode.md) | What works without internet and what does not |
| [Hardware and integrations](docs/hardware.md) | Printers, payments, email, tax — what is real |
| [Testing](docs/testing.md) | What is tested, how to run it, what is not tested |
| [Deployment](docs/deployment.md) | Step-by-step plan for going live |

## Principles the code follows

- Money is whole paise; the server calculates every total and never trusts a price from a client.
- Financial records are never deleted — they are voided, cancelled, refunded or adjusted, with a reason and an audit entry.
- Every restaurant's data is isolated in the API, not just hidden in the screens.
- Retried requests cannot create duplicate orders, payments, refunds or stock movements.
- Nothing is described as working unless it has been built and tested.
