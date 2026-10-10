# Setup and daily use

Written for someone new to this. Run every command from the project folder
(`D:\CLAUDE\ServerOS`) in a terminal.

## What you need installed

- Node.js 20 or newer, and pnpm 10 (`npm install -g pnpm`)
- PostgreSQL 15 or newer (only the program files are used; ServeOS runs its own private
  database on port 5433 so it does not disturb anything else on your machine)

## This machine: already set up

The database, the `.env` file with secrets, and the demo data already exist here. To start work:

```
pnpm db:start        # start the database (needed after every reboot)
pnpm dev:api         # terminal 1: the API on http://localhost:4000
pnpm dev:web         # terminal 2: the POS and back office on http://localhost:5173
pnpm dev:kds         # terminal 3 (optional): the kitchen display on http://localhost:5174
pnpm dev:mobile      # terminal 4 (optional): the phone app (see apps/mobile/README.md)
```

Open http://localhost:5173 and sign in.

| Email | Role | What to try |
|---|---|---|
| `owner@saffrontable.test` | Owner | Everything, both outlets |
| `manager@saffrontable.test` | Outlet manager | Refunds, voids, big discounts, closing shifts |
| `cashier@saffrontable.test` | Cashier | POS, payments, own cash shift |
| `waiter@saffrontable.test` | Waiter | Tables and orders; cannot take payment |
| `kitchen@saffrontable.test` | Kitchen staff | Sign in at the kitchen display (port 5174) |
| `inventory@saffrontable.test` | Inventory manager | Stock, recipes, purchasing |
| `owner@bluelotus.test` | Owner of another restaurant | Proves restaurants cannot see each other |
| `platform@serveos.test` | Platform admin | Only creates restaurants |

The password for all of them is the value of `SEED_DEMO_PASSWORD` in the `.env` file. It was
generated randomly on this machine; these accounts exist only in the development database.

Invitation and password-reset emails are not really sent in development. Read them at
http://localhost:4000/api/v1/dev/outbox.

## A new machine

```
pnpm install
pnpm db:init         # creates the private database, and .env with fresh secrets
pnpm build:shared
pnpm db:deploy       # creates the tables
pnpm db:seed         # demo restaurant, menu, stock, users
pnpm db:seed:orders  # a week of sample orders (optional)
```

`pnpm db:init` refuses to run if a database or `.env` already exists, so it cannot overwrite
your work. On macOS/Linux, or with Docker, create a PostgreSQL database yourself and copy
`.env.example` to `.env` instead.

## Useful commands

| Command | What it does |
|---|---|
| `pnpm db:start` / `pnpm db:stop` | Start / stop the private database |
| `pnpm db:migrate` | After editing `prisma/schema.prisma`: create and apply a migration |
| `pnpm db:studio` | Browse the database in a browser |
| `pnpm db:reset` | **Erases all development data** and re-creates the tables. Then seed again. Refuses to touch a database that is not on this computer. |
| `pnpm db:backup` | Saves a full backup of the database to `backups/` |
| `pnpm create-restaurant -- --name ... ` | Creates a real restaurant and owner (see `docs/deployment.md`) |
| `pnpm test` | Run every automated test |
| `pnpm typecheck` | Check types in every package |
| `pnpm build` | Production builds of shared, API, web and KDS |

After changing anything in `packages/shared`, run `pnpm build:shared` (the apps use its built output).

## A first walk-through

1. Sign in as the cashier. Go to **Cash shift**, choose *Counter 1*, enter an opening float, open the shift.
2. **Point of sale**: tap items. Items with sizes or add-ons open a chooser. Press **Pay**, enter the cash received, record the payment. Open the receipt.
3. Open the **kitchen display** (http://localhost:5174) as the kitchen user: the ticket is there. Press **Start**, then **Ready**.
4. Back in the web app, **Orders** → open the order → **Complete order**.
5. Sign in as the owner: **Reports** shows the sale; **Inventory → Movements** shows the ingredients it used; **Audit log** shows who did what.

## POS keyboard shortcuts

| Key | Action |
|---|---|
| `F2` or `/` | Jump to product search |
| `F4` | Choose a customer |
| `F6` | Hold the current order |
| `F7` | Open held orders |
| `F8` | Send to kitchen |
| `F9` | Pay (or save offline when there is no connection) |
| `Esc` | Close a dialog; clear the search box |

Shortcuts are ignored while a dialog is open.

## Troubleshooting

| Symptom | Fix |
|---|---|
| API says "Invalid environment configuration" | The message names the setting. Compare `.env` with `.env.example`. |
| API cannot connect to the database | Run `pnpm db:start`. |
| "Port 4000/5173 is already in use" | Another copy is still running. Close that terminal. |
| Web page says it cannot reach the server | Start the API (`pnpm dev:api`). |
| Cash payment refused with "Open a cash shift" | Open a shift on the Cash shift page first. |
| Phone app cannot connect | A phone cannot use `localhost`; see `apps/mobile/README.md`. |
