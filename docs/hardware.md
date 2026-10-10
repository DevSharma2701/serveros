# Hardware and external integrations

This page is deliberately blunt about what is real. Nothing below marked "not integrated" has
been built or tested.

| Area | Status | Detail |
|---|---|---|
| Receipt content | **Working** | The API renders every bill as structured data and as 42-column plain text (`renderReceiptText` in `apps/api/src/modules/billing.module.ts`), sized for an 80 mm roll. |
| Receipt printing | **Browser print only** | The Receipt dialog calls the browser's print dialog with an 80 mm print style. No thermal printer, ESC/POS, cash-drawer kick or auto-cut has been integrated or tested on a device. |
| Kitchen printing (KOT) | Not integrated | Kitchen tickets exist as data and on the kitchen display; they are not printed. |
| Barcode scanner | Not integrated | A USB scanner that types into the search box will find a product by SKU, but this was not tested with a device. |
| Card terminal | Not integrated | Card and UPI payments taken on a separate machine are recorded by the cashier and stored as `verification: MANUAL` (not gateway verified). |
| Payment gateway | **Razorpay adapter built, not yet run against Razorpay** | `PAYMENT_PROVIDER=razorpay` uses Razorpay Standard Checkout for guest QR orders (order creation, signature verification, webhooks, reconciliation, refunds). Tested against a fake Razorpay only; needs your test keys for a real trial. `PAYMENT_PROVIDER=dev` is a simulator that moves no money and is refused in production. |
| Card/UPI at the counter | Recorded by hand | Staff take the payment on their own device and record it (`verification: MANUAL`). |
| Email | **Resend adapter built, not yet exercised** | `EMAIL_PROVIDER=resend` sends invitations and password resets through Resend. With `dev`, nothing is sent; messages appear in the API log and at `GET /api/v1/dev/outbox`. |
| Push notifications | Not integrated | The mobile app contains a guarded registration helper only. |
| File storage | Local disk only | Product images are saved under `apps/api/uploads`. |
| Weighing scale, customer display | Not integrated | |

## Adding a thermal printer

The receipt text is already produced server-side, so a printer adapter only has to deliver it:

1. Fetch `GET /api/v1/orders/:id/receipt` and take `text` (or `document` for a custom layout).
2. Send it to the printer. Options, in rough order of effort: the OS print driver via the
   browser (today's behaviour); a small local print service that accepts the text and writes
   ESC/POS to a USB/network printer; WebUSB/Web Serial from the POS page (Chromium only).
3. Test with the actual printer model: character set (₹ is often missing from built-in fonts),
   paper width, cutter and drawer commands vary by device.

## Adding a real payment gateway

Implement the `PaymentGateway` interface in `apps/api/src/modules/payments.module.ts`:
`createPayment`, `parseWebhook` (must verify the provider's signature and throw if it is wrong)
and `refund`. The rest already exists: payments stay `PENDING` until a verified callback
arrives, each provider event is processed once, amounts are checked against the request, and
card data never touches ServeOS. Before going live: move the gateway call out of the database
transaction (the simulator is instant; a real HTTP call is not), add a reconciliation job for
payments left `PENDING`, and test with the provider's sandbox.

## Tax and invoices

Tax categories, rates, GSTIN, HSN/SAC codes, CGST/SGST/IGST split, invoice and credit-note
numbering are all configurable and tested for arithmetic. **That is not a statement of legal
compliance.** The demo rates are illustrations. Have a qualified tax professional confirm the
treatment, invoice format and numbering for your business before using ServeOS for real
billing. E-invoicing (IRN/QR) and GST return exports are not implemented.
