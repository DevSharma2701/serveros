# Ordering from the table QR code

A guest scans the code on their table, orders on their own phone, pays online, and the order
goes straight to the kitchen. No app and no login.

> **Payment depends on your settings.** With `PAYMENT_PROVIDER=dev` (the default on this
> computer) guests see a simulator and no money moves. With `PAYMENT_PROVIDER=razorpay` they pay
> in Razorpay's checkout. The Razorpay adapter is built and tested against a fake Razorpay, but
> it has not yet been run against the real service: do that with test keys first
> (`docs/deployment.md`, step 6).

## How it works

1. **Scan.** Each table's code opens `<your web address>/t/<secret>`. The secret is 32 random
   characters, not the table number, so codes cannot be guessed.
2. **Order.** The guest sees the outlet's live menu (same availability, sizes and add-ons as the
   POS), builds a cart and places the order. The server calculates the price and tax.
3. **Pay.** The order is saved but held back from the kitchen. The guest pays the full amount.
4. **Cook.** The moment the payment is confirmed, the order is sent to the kitchen display,
   stock is deducted and the tax invoice is issued. Nobody on staff has to accept it.
5. **Track.** The guest's page shows Received → Being prepared → Ready → Served, and the receipt.
6. **Serve.** Staff complete the order as usual once it has been handed over.

## Rules worth knowing

| Rule | Why |
|---|---|
| Pay first, then kitchen | Payment is what stops someone with a photo of the code from sending orders to your kitchen. |
| Unpaid orders are cancelled after 15 minutes | Abandoned carts do not pile up. They never reach the kitchen or touch stock. |
| At most 5 unpaid orders per table at once | Limits nuisance from one code. |
| Each guest order is its own prepaid bill | Several people at a table can each order and pay separately. |
| A guest order does not lock the table | A waiter can still run a normal bill on the same table. The floor plan shows "n QR orders". |
| Paid at the counter also works | If a guest would rather pay staff, taking payment on that order releases it to the kitchen the same way. |
| No discounts, coupons or loyalty | Kept off the public page on purpose. |
| Up to 20 of one item and 30 lines per order | A guard against mistakes and abuse. |

## When something goes wrong

- **Payment declined:** the order stays unpaid and uncooked; the guest can try again.
- **Paid, but the kitchen cannot take it** (for example an ingredient ran out in the minute
  between ordering and paying, and negative stock is not allowed): the payment is recorded, the
  order is held, the guest is told staff will come, and staff see a warning on the order in
  **Orders**. Either fix the cause and press **Send to kitchen**, or refund the payment and
  cancel the order.
- **A code is copied or misused:** *Table QR codes → Replace* gives the table a new code; every
  printed copy of the old one stops working immediately.

## Setting it up

1. Sign in as the owner. Open **Setup → Table QR codes**.
2. Tick **Let guests order from QR codes at this outlet** (needs the "manage outlets" permission).
3. Check **Address guests' phones will open** — it is baked into every code.
4. **Print all**, cut out the cards and put one on each table.

Switching the tick off makes every code at that outlet show "This QR code is not active".

### Trying it on your own phone (same Wi-Fi)

`localhost` only means "this computer", so a phone cannot open it. Three things have to point
at your computer's network address instead (find it with `ipconfig`, e.g. `192.168.1.20`):

1. Create `apps/web/.env.local` containing `VITE_API_URL=http://192.168.1.20:4000`
2. In `.env`, add `http://192.168.1.20:5173` to `CORS_ORIGINS` (comma separated), then restart the API.
3. Start the web app so other devices can reach it: `pnpm --filter @serveos/web dev --host`

Then on the QR page set the address to `http://192.168.1.20:5173`, and scan a code with your
phone. Windows may ask to allow Node through the firewall — allow it on private networks.
This phone-on-Wi-Fi path has not been tried by the developer of this build; the same page was
tested in a desktop browser at phone size.

## What staff see

- **Orders:** guest orders carry a **QR** tag and the guest's name. Unpaid ones say they are
  waiting for payment.
- **Tables:** a table with paid guest orders in progress shows as occupied with "n QR orders".
- **Kitchen display:** tickets appear like any other dine-in ticket, with the table name.
- **Reports and invoices:** included like any other completed, paid order.

## Security summary

The guest endpoints (`/api/v1/public/...`) need no login, so they are deliberately narrow:

- They expose only the menu and a guest's own order, addressed by unguessable tokens. Unknown,
  inactive and switched-off codes all answer the same "not found".
- Prices, totals, status and payment state can never be set by the phone.
- They are rate-limited per network address more tightly than the staff API.
- A guest token cannot reach any staff endpoint, another guest's order, or another table.

Covered by 17 API tests (`apps/api/src/test/guest-ordering.spec.ts`) and 5 page tests
(`apps/web/src/pages/guest/GuestPage.test.tsx`).

## Online payment with Razorpay

Set up in `docs/deployment.md` (step 6). What happens:

1. The guest taps Pay. The server creates a Razorpay order for the exact bill.
2. Razorpay's own window opens for UPI, card or netbanking. Those details never reach ServeOS.
3. The order is released to the kitchen only after the server has verified Razorpay's signature.
   That proof can arrive three ways, and any one is enough: the page returning from checkout,
   Razorpay's webhook, or a once-a-minute check with Razorpay for payments still waiting.
4. A failed attempt is not final; the guest can try again in the same window.
5. A guest who is in the middle of paying gets extra time (45 minutes instead of 15) before the
   order expires. If money still arrives after an order expired, it is recorded and flagged on
   the order so staff can refund it.
6. Refunds made in the Orders screen are sent to Razorpay.

At the counter, staff still record card/UPI taken on their own machine by hand; Razorpay is
used for guest QR orders only.

Not built yet: letting a guest add a customer account or loyalty points, calling a waiter from
the page, tips, and splitting one guest order between several payers.
