/**
 * Payment gateway port and its adapters.
 *
 * ServeOS never marks a payment successful because a browser said so. A gateway payment
 * becomes money only through one of three server-verified routes, all of which end in the
 * same idempotent settle step in PaymentsService:
 *   1. the provider's signed webhook,
 *   2. the signed result the provider's checkout hands back to the page (verified here), or
 *   3. asking the provider directly (reconciliation, for confirmations that never arrived).
 */
import { Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, unauthorized } from '../common/errors';
import { hmac } from '../common/util';
import { env } from '../config/env';

export interface GatewayEvent {
  /** Unique per provider event, so a repeated delivery is processed once. */
  eventId: string;
  /** The provider's id for our payment request (stored as Payment.providerRef). */
  providerRef: string;
  outcome: 'success' | 'failure';
  amountMinor: number;
  /** The provider's id for the money movement itself, needed later for refunds. */
  paymentRef?: string;
  /** How the customer actually paid, when the provider says. They choose inside the provider's checkout. */
  method?: 'UPI' | 'CARD' | 'WALLET' | 'OTHER';
  failureReason?: string;
}

export interface PaymentGateway {
  readonly name: string;
  /** HTTP header carrying the webhook signature. */
  readonly signatureHeader: string;
  /** True if staff can start a payment with this gateway from the POS. */
  readonly counterPayments: boolean;
  createPayment(input: { paymentId: string; amountMinor: number; currency: string; method: string; orderNumber: string }): Promise<{ providerRef: string }>;
  /** Verifies a webhook's signature (throws if wrong) and returns its meaning, or null for events we do not act on. */
  parseWebhook(rawBody: Buffer, signature: string, headers: Record<string, string | string[] | undefined>): GatewayEvent | null;
  /** What the guest's page needs to open the provider's checkout. Contains public values only. */
  checkout?(payment: { providerRef: string; amountMinor: number; currency: string }): Record<string, string | number>;
  /** Verifies the signed result the provider's checkout returned to the page. Throws if it is not genuine. */
  verifyCheckout?(fields: Record<string, string>): { providerRef: string; paymentRef: string };
  /** Asks the provider whether a payment request has been paid. */
  fetchStatus?(providerRef: string): Promise<{ paid: boolean; amountMinor: number; paymentRef?: string; method?: GatewayEvent['method'] }>;
  refund(input: { providerRef: string; paymentRef: string; amountMinor: number }): Promise<void>;
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ───────────── Development simulator ─────────────

/**
 * Simulated gateway for development and tests. It moves no money. It exists so the full
 * server-side flow (create request -> signed callback -> idempotent confirmation) is exercised.
 */
export class DevGateway implements PaymentGateway {
  readonly name = 'dev';
  readonly signatureHeader = 'x-serveos-signature';
  readonly counterPayments = true;

  async createPayment(): Promise<{ providerRef: string }> {
    return { providerRef: `devpay_${randomBytes(12).toString('hex')}` };
  }

  sign(rawBody: string): string {
    return hmac(env.PAYMENT_WEBHOOK_SECRET, rawBody);
  }

  parseWebhook(rawBody: Buffer, signature: string): GatewayEvent {
    if (!safeEqual(this.sign(rawBody.toString('utf8')), signature)) throw unauthorized('Invalid webhook signature');
    const parsed = z
      .object({ id: z.string().min(1).max(100), type: z.enum(['payment.succeeded', 'payment.failed']), data: z.object({ providerRef: z.string(), amountMinor: z.number().int() }) })
      .parse(JSON.parse(rawBody.toString('utf8')));
    return { eventId: parsed.id, providerRef: parsed.data.providerRef, outcome: parsed.type === 'payment.succeeded' ? 'success' : 'failure', amountMinor: parsed.data.amountMinor, failureReason: 'Declined (simulated)' };
  }

  async refund(): Promise<void> {
    /* nothing to do: no real money moved */
  }
}

// ───────────── Razorpay ─────────────

const razorpayWebhook = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: z.object({ id: z.string(), order_id: z.string().nullable().optional(), amount: z.number().int(), method: z.string().nullable().optional() }) }).optional(),
    order: z.object({ entity: z.object({ id: z.string(), amount: z.number().int(), amount_paid: z.number().int() }) }).optional(),
  }),
});

/** Razorpay's method names mapped to ours. Netbanking, EMI and anything new are recorded as OTHER. */
function razorpayMethod(method: string | null | undefined): GatewayEvent['method'] {
  if (!method) return undefined;
  return method === 'upi' ? 'UPI' : method === 'card' ? 'CARD' : method === 'wallet' ? 'WALLET' : 'OTHER';
}

type Fetch = typeof fetch;

/**
 * Razorpay Standard Checkout. The server creates a Razorpay Order for the exact amount; the
 * guest pays in Razorpay's own checkout (card and UPI details never touch ServeOS); Razorpay
 * confirms with a signed webhook and with a signed result returned to the page.
 *
 * Amounts are sent in paise, which is what ServeOS already stores.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';
  readonly signatureHeader = 'x-razorpay-signature';
  // At the counter, staff record card/UPI taken on their own device; online checkout is for guests.
  readonly counterPayments = false;
  private readonly base = 'https://api.razorpay.com/v1';
  private readonly logger = new Logger('Razorpay');

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
    private readonly http: Fetch = (...args) => fetch(...args),
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    let res: Response;
    try {
      res = await this.http(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AppError(502, 'GATEWAY_UNREACHABLE', 'The payment provider could not be reached. Please try again.');
    }
    const json = (await res.json().catch(() => null)) as { error?: { description?: string } } | null;
    if (!res.ok) {
      // The provider's message can describe our account, so it goes to the server log and not to the guest.
      this.logger.error({ path, status: res.status, provider: json?.error?.description }, 'Razorpay request failed');
      throw new AppError(502, 'GATEWAY_ERROR', 'The payment provider refused the request. Please try again or pay at the counter.');
    }
    return json as T;
  }

  async createPayment(input: { paymentId: string; amountMinor: number; currency: string; orderNumber: string }): Promise<{ providerRef: string }> {
    const order = await this.call<{ id: string }>('POST', '/orders', {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.orderNumber.slice(0, 40),
      notes: { serveosPaymentId: input.paymentId },
    });
    return { providerRef: order.id };
  }

  checkout(payment: { providerRef: string; amountMinor: number; currency: string }): Record<string, string | number> {
    // The key id is public by design (it identifies the merchant in the browser). The secret never leaves the server.
    return { provider: this.name, keyId: this.keyId, orderId: payment.providerRef, amountMinor: payment.amountMinor, currency: payment.currency };
  }

  verifyCheckout(fields: Record<string, string>): { providerRef: string; paymentRef: string } {
    const parsed = z.object({ razorpay_order_id: z.string().min(1).max(60), razorpay_payment_id: z.string().min(1).max(60), razorpay_signature: z.string().min(1).max(200) }).safeParse(fields);
    if (!parsed.success) throw unauthorized('Invalid payment confirmation');
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = parsed.data;
    const expected = createHmac('sha256', this.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    if (!safeEqual(expected, signature)) throw unauthorized('Invalid payment confirmation');
    return { providerRef: orderId, paymentRef: paymentId };
  }

  parseWebhook(rawBody: Buffer, signature: string, headers: Record<string, string | string[] | undefined>): GatewayEvent | null {
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    if (!safeEqual(expected, signature)) throw unauthorized('Invalid webhook signature');
    const parsed = razorpayWebhook.safeParse(JSON.parse(rawBody.toString('utf8')));
    if (!parsed.success) return null;
    const { event, payload } = parsed.data;
    const payment = payload.payment?.entity;
    const headerId = headers['x-razorpay-event-id'];
    const eventId = typeof headerId === 'string' && headerId ? headerId : `${event}:${payment?.id ?? payload.order?.entity.id ?? ''}`;

    // "order.paid" means the whole request was captured. A failed attempt is not final: the
    // guest can try again inside the same checkout, so it is not treated as a failure here.
    if (event === 'order.paid' && payload.order) {
      return { eventId, providerRef: payload.order.entity.id, outcome: 'success', amountMinor: payload.order.entity.amount_paid, paymentRef: payment?.id, method: razorpayMethod(payment?.method) };
    }
    if (event === 'payment.captured' && payment?.order_id) {
      return { eventId, providerRef: payment.order_id, outcome: 'success', amountMinor: payment.amount, paymentRef: payment.id, method: razorpayMethod(payment.method) };
    }
    return null;
  }

  async fetchStatus(providerRef: string): Promise<{ paid: boolean; amountMinor: number; paymentRef?: string; method?: GatewayEvent['method'] }> {
    const order = await this.call<{ status: string; amount_paid: number }>('GET', `/orders/${encodeURIComponent(providerRef)}`);
    if (order.status !== 'paid') return { paid: false, amountMinor: order.amount_paid };
    const payments = await this.call<{ items: Array<{ id: string; status: string; method?: string }> }>('GET', `/orders/${encodeURIComponent(providerRef)}/payments`);
    const captured = payments.items.find((p) => p.status === 'captured');
    return { paid: true, amountMinor: order.amount_paid, paymentRef: captured?.id, method: razorpayMethod(captured?.method) };
  }

  async refund(input: { providerRef: string; paymentRef: string; amountMinor: number }): Promise<void> {
    const paymentRef = input.paymentRef || (await this.fetchStatus(input.providerRef)).paymentRef;
    if (!paymentRef) throw new AppError(409, 'REFUND_NOT_POSSIBLE', 'The provider has no captured payment to refund for this order');
    await this.call('POST', `/payments/${encodeURIComponent(paymentRef)}/refund`, { amount: input.amountMinor });
  }
}

export function createGateway(): PaymentGateway | null {
  if (env.PAYMENT_PROVIDER === 'dev') return new DevGateway();
  if (env.PAYMENT_PROVIDER === 'razorpay') return new RazorpayGateway(env.PAYMENT_API_KEY, env.PAYMENT_API_SECRET, env.PAYMENT_WEBHOOK_SECRET);
  return null;
}
