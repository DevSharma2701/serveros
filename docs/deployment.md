# Going to production

This is the plan for one restaurant, using the services chosen for this project. **None of it
has been carried out yet**: the code side is built and tested, but no account has been created
and nothing has been deployed. Treat each step as "to do", and expect small corrections when
you meet each provider's current screens and limits.

## The setup

| Piece | Service | Cost | Address (example) |
|---|---|---|---|
| Web app + guest QR page | Render static site | Free | `app.serveros.me` |
| Kitchen display | Render static site | Free | `kitchen.serveros.me` |
| API | Render web service, smallest **paid** instance | A few dollars a month | `api.serveros.me` |
| Database | Neon PostgreSQL | Free tier to start | — |
| Email | Resend, from your domain | Free tier to start | `no-reply@serveros.me` |
| Payments | Razorpay | Per-transaction fee | — |

Why the API is not on a free plan: free web services sleep when idle and take up to a minute
to wake. For a till, that means a hung first order after a quiet spell, a disconnected kitchen
screen, missed payment confirmations, and the job that expires unpaid QR orders not running.
Free tiers and their terms change; check each provider's current limits before relying on them
(in particular, how long Neon keeps backups on its free plan).

All three addresses must be on **your own domain**. The sign-in cookie is only sent between
addresses on the same site, so `app.serveros.me` talking to an `onrender.com` address will
not keep you signed in.

## What you need to create (accounts)

1. A private GitHub repository, with this code pushed to it.
2. (No separate front-end host: the web app and kitchen display are Render static sites.)
3. Render account with a payment method.
4. Neon account.
5. Resend account; add your domain and the DNS records it gives you.
6. Razorpay account. Test keys are available immediately; live keys need business KYC, so
   start that early.

Never paste keys or passwords into chat or commit them. They go into each service's
environment settings (or your local `.env`, which git ignores).

## Step by step

### 1. Database (Neon)
- Create a project in a region near you (Singapore or Mumbai if offered).
- Copy two connection strings: the **pooled** one → `DATABASE_URL`, the **direct** one → `DIRECT_URL`.

### 2. API (Render)
- New → **Blueprint** → pick the repository. Render reads `render.yaml`, which already holds the
  build and start commands, the health check, production mode and database image storage.
- It then asks for the values below (the two JWT secrets are generated for you):

  | Variable | Value |
  |---|---|
  | `NODE_ENV` | `production` |
  | `DATABASE_URL`, `DIRECT_URL` | from Neon |
  | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | two different random strings, 48+ bytes each |
  | `WEB_URL` | `https://app.serveros.me` |
  | `API_URL` | `https://api.serveros.me` |
  | `CORS_ORIGINS` | `https://app.serveros.me,https://kitchen.serveros.me` |
  | `EMAIL_PROVIDER` / `EMAIL_API_KEY` / `EMAIL_FROM` | `resend` / key from Resend / `Your Restaurant <no-reply@serveros.me>` |
  | `PAYMENT_PROVIDER` | `none` for the pilot, `razorpay` when ready |
  | `PAYMENT_API_KEY` / `PAYMENT_API_SECRET` / `PAYMENT_WEBHOOK_SECRET` | from Razorpay (see step 6) |

- Add the custom domain `api.serveros.me`.
- The blueprint has not been deployed yet; expect to adjust small things on first use.
- The API validates its configuration when it starts and stops with the name of anything wrong.

### 3. Create your restaurant
Run once, from your computer, with `DATABASE_URL`/`DIRECT_URL` temporarily pointing at Neon and
the same email settings as production (or use Render's shell):

```
pnpm --filter @serveos/api create-restaurant -- --name "Your Restaurant" --legal-name "Your Company Pvt Ltd" --owner-name "Your Name" --owner-email you@serveros.me --outlet "Main" --code MAIN --state 29 --city Bengaluru
```

You receive an email with a link to choose your password (or, with no email provider yet, the
link is printed for you). `db:seed`, `db:seed:orders`, `db:reset` and `db:migrate` refuse to
run against any database that is not on your own computer.

### 4. Web app and kitchen display (Render static sites)
Both are defined in `render.yaml` (`serveos-web` and `serveos-kitchen`), so Render creates and
rebuilds them from the same blueprint as the API. Static sites are free and do not sleep.
For each, add one CNAME record at Namecheap (Advanced DNS):

| Host | Value |
|---|---|
| `app` | the `.onrender.com` address of `serveos-web` |
| `kitchen` | the `.onrender.com` address of `serveos-kitchen` |

The blueprint sends every unknown path to the app, so page reloads and QR links (`/t/...`) work.
`VITE_` values are public and baked in at build time: never put a secret in one.

### 5. Set up the restaurant in the back office
Sign in, then: tax categories → menu → kitchen stations → tables → cash registers → staff
invitations → recipes and opening stock (optional to start). Have your accountant check a few
sample invoices before the first real sale.

### 6. Razorpay (when you are ready for online payment)
1. Dashboard → Account & Settings → API Keys: generate **test** keys. Set `PAYMENT_API_KEY`
   and `PAYMENT_API_SECRET`, and `PAYMENT_PROVIDER=razorpay`.
2. Dashboard → Webhooks → add `https://api.serveros.me/api/v1/payments/webhooks/razorpay`,
   choose a secret (16+ characters) and put the same value in `PAYMENT_WEBHOOK_SECRET`.
   Select the events **order.paid** and **payment.captured**.
3. Make sure payments are set to capture automatically (Razorpay's default for most accounts).
4. Test with Razorpay's test cards/UPI: a successful payment, a failed one, closing the
   payment window half-way, and a refund from the Orders screen.
5. Only then swap in the **live** keys and a live-mode webhook.

How ServeOS treats Razorpay payments: the server creates the Razorpay order for the exact bill;
the guest pays inside Razorpay's own window; the order goes to the kitchen only after the
server has verified Razorpay's signature (from the page's return, the webhook, or — if both
are lost — a check with Razorpay every minute). Card and UPI details never reach ServeOS.

## Still to do before real customers

- **Razorpay has only been tested against a fake Razorpay** inside the test suite (signatures,
  webhooks, reconciliation, refunds). It has not yet talked to the real service: that needs
  your test keys.
- **Resend has not been exercised** for the same reason.
- **Product images** are stored in the database in production (`STORAGE_PROVIDER=database`), so
  they survive deploys and are in your backups. Fine for one restaurant; a large chain would
  move them to object storage.
- **One API instance only.** Rate limiting and live updates keep state in memory.
- **Backups:** confirm what your Neon plan keeps. For your own copy, run `pnpm db:backup` with
  `DIRECT_URL` set to the Neon direct string (writes a file under `backups/`). Practise one restore.
- **Monitoring:** add an uptime check on `/api/v1/health/ready` and error alerting.
- **Mobile app:** not yet run on a device or published.
- **Tax review** by a qualified professional (see `docs/hardware.md`).
- **Privacy policy and terms**, since customer phone numbers are stored.
- **Dependency audit:** `pnpm audit --prod` reports advisories in indirect framework dependencies.
- Not load-tested. The CI workflow (`.github/workflows/ci.yml`) runs for the first time when the code is pushed.

## Updating later

Push to GitHub. Render rebuilds the API (applying database migrations on start) and both
front ends. Migrations are forward-only, so take a database backup before a
release that changes the schema.
