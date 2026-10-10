/**
 * What a guest sees after scanning a table's QR code: menu, cart, pay, then order progress.
 * No login. It talks only to the /public endpoints and shows only what they return; every
 * price and total on screen comes from the server.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChefHat, ChevronLeft, Clock, Leaf, Minus, Plus, ReceiptText, ShoppingBag, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { Badge, Button, cn, EmptyState, ErrorState, Field, Input, Notice, Skeleton, Spinner } from '@/components/ui';
import { API_URL } from '@/lib/api';
import { money } from '@/lib/format';
import type { Catalog, CatalogProduct } from '@/lib/types';
import { cartCount, cartReducer, emptyCart, lineUnitMinor, searchProducts } from '../pos/cart';
import { ProductOptionsDialog } from '../pos/dialogs';

interface GuestMenu {
  restaurant: string;
  outlet: string;
  table: string;
  currency: string;
  pricesIncludeTax: boolean;
  onlinePayment: string | null;
  categories: Catalog['categories'];
  products: Array<Omit<CatalogProduct, 'sku' | 'taxCategoryId'>>;
  modifierGroups: Catalog['modifierGroups'];
  popularProductIds: string[];
}
interface Quote {
  subtotalMinor: number;
  serviceChargeMinor: number;
  taxMinor: number;
  roundOffMinor: number;
  totalMinor: number;
  taxLines: Array<{ name: string; amountMinor: number }>;
}
export interface GuestOrder {
  guestToken: string;
  orderNumber: string;
  status: 'PLACED' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED';
  table: string;
  currency: string;
  items: Array<{ name: string; variant: string; quantity: number; modifiers: string[]; notes: string; amountMinor: number }>;
  subtotalMinor: number;
  serviceChargeMinor: number;
  taxLines: Array<{ name: string; amountMinor: number }>;
  roundOffMinor: number;
  totalMinor: number;
  refundedMinor: number;
  payment: { state: 'UNPAID' | 'PENDING' | 'PAID'; provider: string | null; lastFailure: string | null; payBy: string | null; checkout?: RazorpayCheckout | null };
  kitchen: { tickets: number; ready: number };
  needsStaff: boolean;
  cancelReason: string | null;
  onlinePayment: string | null;
}

/** Public values the server gives the page so it can open Razorpay's checkout. No secrets. */
interface RazorpayCheckout {
  provider: 'razorpay';
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
}
type RazorpayResult = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open(): void };
  }
}

let razorpayScript: Promise<void> | null = null;
/** Loads Razorpay's checkout script once. Card and UPI details are typed into Razorpay's window, never into ours. */
function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  razorpayScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => {
      razorpayScript = null;
      reject(new Error('Could not load the payment page. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return razorpayScript;
}

class GuestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/** Calls a public endpoint. Deliberately separate from the staff API client: it sends no credentials. */
async function guestApi<T>(path: string, init: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1/public${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.key ? { 'Idempotency-Key': init.key } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new GuestError(0, 'NETWORK', 'Cannot reach the restaurant right now. Check your connection and try again.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new GuestError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? 'Something went wrong. Please ask a member of staff.');
  return body as T;
}
const message = (err: unknown): string => (err instanceof Error ? err.message : 'Something went wrong');

/** The orders placed from this phone at this table (tokens only), so a refresh does not lose them. */
function useMyOrders(tableToken: string): [string[], (token: string) => void] {
  const storageKey = `serveos.guest.${tableToken}`;
  const [tokens, setTokens] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(saved) ? saved.filter((t) => typeof t === 'string') : [];
    } catch {
      return [];
    }
  });
  const add = (token: string) =>
    setTokens((current) => {
      const next = [token, ...current.filter((t) => t !== token)].slice(0, 20);
      localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  return [tokens, add];
}

const STEPS = [
  { key: 'CONFIRMED', label: 'Received' },
  { key: 'PREPARING', label: 'Being prepared' },
  { key: 'READY', label: 'Ready' },
  { key: 'COMPLETED', label: 'Served' },
] as const;

function OrderStatus({ guestToken, onBack }: { guestToken: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const order = useQuery({
    queryKey: ['guest-order', guestToken],
    queryFn: () => guestApi<GuestOrder>(`/orders/${guestToken}`),
    // Keep checking while something can still change.
    refetchInterval: (q) => (q.state.data && ['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(q.state.data.status) ? false : 4000),
  });
  const act = useMutation({
    mutationFn: (step: 'pay' | 'success' | 'failure') =>
      step === 'pay' ? guestApi<GuestOrder>(`/orders/${guestToken}/pay`, { method: 'POST', body: { method: 'UPI' } }) : guestApi<GuestOrder>(`/orders/${guestToken}/dev-pay`, { method: 'POST', body: { outcome: step } }),
    onSuccess: (data) => {
      setError(null);
      queryClient.setQueryData(['guest-order', guestToken], data);
      if (data.payment.checkout?.provider === 'razorpay') void openRazorpay(data.payment.checkout, data.orderNumber);
    },
    onError: (err) => {
      setError(message(err));
      void order.refetch();
    },
  });
  // Razorpay's checkout hands back a signed result. The server verifies that signature before
  // anything is treated as paid; if this request is lost, the webhook and reconciliation still settle it.
  const [confirming, setConfirming] = useState(false);
  const confirmPayment = useMutation({
    mutationFn: (result: RazorpayResult) => guestApi<GuestOrder>(`/orders/${guestToken}/confirm`, { method: 'POST', body: result }),
    onSuccess: (data) => {
      setError(null);
      queryClient.setQueryData(['guest-order', guestToken], data);
    },
    onError: () => setError('We are still confirming your payment. This page will update by itself; please do not pay again.'),
    onSettled: () => setConfirming(false),
  });
  const openRazorpay = async (checkout: RazorpayCheckout, orderNumber: string) => {
    try {
      setError(null);
      await loadRazorpay();
      new window.Razorpay!({
        key: checkout.keyId,
        order_id: checkout.orderId,
        amount: checkout.amountMinor,
        currency: checkout.currency,
        name: 'Table order',
        description: `Order ${orderNumber}`,
        theme: { color: '#c2410c' },
        handler: (result: RazorpayResult) => {
          setConfirming(true);
          confirmPayment.mutate(result);
        },
      }).open();
    } catch (err) {
      setError(message(err));
    }
  };

  const showReceipt = useMutation({
    mutationFn: () => guestApi<{ text: string }>(`/orders/${guestToken}/receipt`),
    onSuccess: (r) => setReceipt(r.text),
    onError: (err) => setError(message(err)),
  });

  if (order.isPending) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  if (order.isError) return <ErrorState message={message(order.error)} onRetry={() => void order.refetch()} />;
  const o = order.data;
  const stepIndex = STEPS.findIndex((s) => s.key === o.status);
  const waitingToPay = o.status === 'PLACED' && o.payment.state !== 'PAID';

  return (
    <div className="flex flex-col gap-4 p-4">
      <button type="button" onClick={onBack} className="flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-brand">
        <ChevronLeft className="h-4 w-4" aria-hidden /> Menu
      </button>
      <div>
        <h1 className="text-2xl font-bold text-ink">Order {o.orderNumber}</h1>
        <p className="text-sm text-ink-soft">Table {o.table}</p>
      </div>

      {o.status === 'CANCELLED' ? (
        <Notice tone="bad" title="This order was cancelled">
          {o.cancelReason}
          {o.refundedMinor > 0 ? ` ${money(o.refundedMinor, o.currency)} has been refunded.` : ''}
        </Notice>
      ) : o.needsStaff ? (
        <Notice tone="warn" title="Paid — a member of staff will be with you">
          Your payment went through, but we could not send your order to the kitchen automatically. Staff have been told and will either prepare it or refund you.
        </Notice>
      ) : waitingToPay ? (
        <div className="rounded-card border border-line bg-surface p-4 shadow-card">
          <p className="text-sm text-ink-soft">To pay</p>
          <p className="tabular text-3xl font-bold text-ink">{money(o.totalMinor, o.currency)}</p>
          <p className="mt-1 text-sm text-ink-soft">Your order goes to the kitchen as soon as it is paid.</p>
          {o.payment.lastFailure ? (
            <Notice tone="bad" className="mt-3" title="The payment did not go through">
              {o.payment.lastFailure}. Nothing was charged. You can try again.
            </Notice>
          ) : null}
          {error ? <Notice tone="bad" className="mt-3">{error}</Notice> : null}
          {o.onlinePayment === null ? (
            <Notice tone="info" className="mt-3">Online payment is not available here. Please pay at the counter and mention order {o.orderNumber}.</Notice>
          ) : o.payment.state === 'PENDING' ? (
            o.payment.provider === 'dev' ? (
              <div className="mt-3 rounded-control border border-warn/40 bg-warn-soft p-3">
                <p className="text-sm font-semibold text-warn">Payment simulator (development)</p>
                <p className="mt-1 text-sm text-ink">No real payment provider is connected yet, so no money moves. Choose how the payment should turn out:</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button variant="success" size="lg" loading={act.isPending && act.variables === 'success'} disabled={act.isPending} onClick={() => act.mutate('success')}>
                    Payment succeeds
                  </Button>
                  <Button size="lg" disabled={act.isPending} onClick={() => act.mutate('failure')}>
                    Payment fails
                  </Button>
                </div>
              </div>
            ) : confirming ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
                <Spinner /> Confirming your payment…
              </p>
            ) : o.payment.checkout?.provider === 'razorpay' ? (
              <>
                <Button variant="primary" size="lg" className="mt-3 w-full" onClick={() => void openRazorpay(o.payment.checkout!, o.orderNumber)}>
                  Pay {money(o.totalMinor, o.currency)}
                </Button>
                <p className="mt-2 text-center text-xs text-ink-faint">Secure payment by Razorpay (UPI, cards, netbanking). If you have already paid, this page updates within a minute or two.</p>
              </>
            ) : (
              <p className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
                <Spinner /> Waiting for your payment to be confirmed…
              </p>
            )
          ) : (
            <Button variant="primary" size="lg" className="mt-3 w-full" loading={act.isPending} onClick={() => act.mutate('pay')}>
              Pay {money(o.totalMinor, o.currency)}
            </Button>
          )}
          {o.payment.payBy ? (
            <p className="mt-3 flex items-center gap-1 text-xs text-ink-faint">
              <Clock className="h-3.5 w-3.5" aria-hidden /> Unpaid orders are cancelled at {new Date(o.payment.payBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="rounded-card border border-line bg-surface p-4 shadow-card">
          <p className="flex items-center gap-2 font-semibold text-ok">
            <CheckCircle2 className="h-5 w-5" aria-hidden /> Paid {money(o.totalMinor, o.currency)}
          </p>
          <ol className="mt-4 flex flex-col gap-3" aria-label="Order progress">
            {STEPS.map((step, i) => (
              <li key={step.key} className={cn('flex items-center gap-3 text-sm', i <= stepIndex ? 'font-semibold text-ink' : 'text-ink-faint')} aria-current={i === stepIndex ? 'step' : undefined}>
                <span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold', i <= stepIndex ? 'bg-ok text-white' : 'bg-sunken')}>{i + 1}</span>
                {step.label}
                {step.key === 'PREPARING' && o.status === 'PREPARING' && o.kitchen.tickets > 1 ? <span className="font-normal text-ink-soft">({o.kitchen.ready} of {o.kitchen.tickets} parts ready)</span> : null}
              </li>
            ))}
          </ol>
        </div>
      )}

      <section className="rounded-card border border-line bg-surface p-4">
        <h2 className="mb-2 font-semibold text-ink">Your items</h2>
        <ul className="divide-y divide-line">
          {o.items.map((i, index) => (
            <li key={index} className="flex justify-between gap-3 py-2 text-sm">
              <span>
                {i.quantity} × {i.name}
                {i.variant !== 'Regular' ? ` (${i.variant})` : ''}
                {i.modifiers.length ? <span className="block text-ink-faint">{i.modifiers.join(', ')}</span> : null}
                {i.notes ? <span className="block italic text-ink-faint">“{i.notes}”</span> : null}
              </span>
              <span className="tabular">{money(i.amountMinor, o.currency)}</span>
            </li>
          ))}
        </ul>
        <Totals currency={o.currency} subtotalMinor={o.subtotalMinor} serviceChargeMinor={o.serviceChargeMinor} taxLines={o.taxLines} roundOffMinor={o.roundOffMinor} totalMinor={o.totalMinor} />
      </section>

      {o.payment.state === 'PAID' ? (
        <Button onClick={() => (receipt ? setReceipt(null) : showReceipt.mutate())} loading={showReceipt.isPending}>
          <ReceiptText className="h-4 w-4" aria-hidden /> {receipt ? 'Hide receipt' : 'View receipt'}
        </Button>
      ) : null}
      {receipt ? <pre className="overflow-x-auto rounded-control border border-line bg-sunken p-3 font-mono text-[0.6875rem] leading-5 text-ink">{receipt}</pre> : null}
      <Button variant="ghost" onClick={onBack}>
        Order something else
      </Button>
    </div>
  );
}

function Totals({ currency, subtotalMinor, serviceChargeMinor, taxLines, roundOffMinor, totalMinor }: { currency: string; subtotalMinor: number; serviceChargeMinor: number; taxLines: Array<{ name: string; amountMinor: number }>; roundOffMinor: number; totalMinor: number }) {
  const row = (label: string, value: number) => (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd>{money(value, currency)}</dd>
    </div>
  );
  return (
    <dl className="tabular mt-3 space-y-1 border-t border-line pt-3 text-sm text-ink-soft">
      {row('Subtotal', subtotalMinor)}
      {serviceChargeMinor > 0 ? row('Service charge', serviceChargeMinor) : null}
      {taxLines.map((t) => (
        <div key={t.name} className="flex justify-between">
          <dt>{t.name}</dt>
          <dd>{money(t.amountMinor, currency)}</dd>
        </div>
      ))}
      {roundOffMinor !== 0 ? row('Round off', roundOffMinor) : null}
      <div className="flex justify-between border-t border-line pt-2 text-base font-bold text-ink">
        <dt>Total</dt>
        <dd>{money(totalMinor, currency)}</dd>
      </div>
    </dl>
  );
}

export function GuestPage({ tableToken }: { tableToken: string }) {
  const [cart, dispatch] = useReducer(cartReducer, undefined, () => emptyCart('DINE_IN'));
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<CatalogProduct | null>(null);
  const [screen, setScreen] = useState<'menu' | 'cart'>('menu');
  const [viewing, setViewing] = useState<string | null>(null);
  const [guestName, setGuestName] = useState('');
  const [myOrders, rememberOrder] = useMyOrders(tableToken);

  const menu = useQuery({ queryKey: ['guest-menu', tableToken], queryFn: () => guestApi<GuestMenu>(`/tables/${tableToken}`), staleTime: 60_000, retry: false });

  // The POS option chooser and cart are reused; they only need the menu in the POS's shape.
  const catalog = useMemo<Catalog | null>(() => {
    if (!menu.data) return null;
    const m = menu.data;
    return {
      generatedAt: '',
      settings: { currency: m.currency, pricesIncludeTax: m.pricesIncludeTax, roundOffMode: 'NONE', serviceChargeBps: 0, serviceChargeTaxRules: [], deliveryChargeMinor: 0, deliveryChargeTaxRules: [], discountApprovalThresholdBps: 0, outletStateCode: '' },
      categories: m.categories,
      products: m.products.map((p) => ({ ...p, sku: '', taxCategoryId: null })),
      modifierGroups: m.modifierGroups,
      taxCategories: [],
      stations: [],
      popularProductIds: m.popularProductIds,
    };
  }, [menu.data]);

  const items = useMemo(() => cart.lines.map((l) => ({ clientLineId: l.lineId, productId: l.productId, variantId: l.variantId, quantity: l.quantity, modifierOptionIds: l.modifiers.map((x) => x.id), notes: l.notes })), [cart.lines]);
  // Tax and the final total are calculated by the restaurant's server, not on this phone.
  const quote = useQuery({
    queryKey: ['guest-quote', tableToken, items],
    queryFn: () => guestApi<Quote>(`/tables/${tableToken}/quote`, { method: 'POST', body: { items } }),
    enabled: screen === 'cart' && items.length > 0,
    retry: false,
  });
  const place = useMutation({
    mutationFn: () => guestApi<GuestOrder>(`/tables/${tableToken}/orders`, { method: 'POST', key: cart.attemptKey, body: { items, guestName: guestName.trim(), notes: cart.notes } }),
    onSuccess: (order) => {
      rememberOrder(order.guestToken);
      dispatch({ kind: 'reset', type: 'DINE_IN' });
      setScreen('menu');
      setViewing(order.guestToken);
    },
  });

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen, viewing]);

  if (menu.isPending) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3 p-4" role="status" aria-label="Loading menu">
        <Skeleton className="h-16" />
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }
  if (menu.isError || !catalog) {
    const gone = menu.error instanceof GuestError && menu.error.status === 404;
    return (
      <div className="mx-auto max-w-xl p-6">
        {gone ? <EmptyState title="This QR code is not active" description="Ordering from the table may be switched off, or this code has been replaced. Please ask a member of staff." /> : <ErrorState message={message(menu.error)} onRetry={() => void menu.refetch()} />}
      </div>
    );
  }
  const m = menu.data;

  const header = (
    <header className="bg-sidebar px-4 py-4 text-sidebar-ink">
      <div className="mx-auto flex max-w-xl items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-control bg-brand text-white">
          <ChefHat className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="truncate font-bold leading-tight">{m.restaurant}</p>
          <p className="truncate text-sm text-sidebar-faint">
            {m.outlet} · Table {m.table}
          </p>
        </div>
      </div>
    </header>
  );

  if (viewing) {
    return (
      <div className="min-h-dvh bg-canvas">
        {header}
        <div className="mx-auto max-w-xl">
          <OrderStatus guestToken={viewing} onBack={() => setViewing(null)} />
        </div>
      </div>
    );
  }

  if (screen === 'cart') {
    return (
      <div className="min-h-dvh bg-canvas">
        {header}
        <div className="mx-auto flex max-w-xl flex-col gap-4 p-4">
          <button type="button" onClick={() => setScreen('menu')} className="flex min-h-11 items-center gap-1 self-start text-sm font-semibold text-brand">
            <ChevronLeft className="h-4 w-4" aria-hidden /> Add more
          </button>
          <h1 className="text-2xl font-bold text-ink">Your order</h1>
          {cart.lines.length === 0 ? (
            <EmptyState icon={<ShoppingBag className="h-6 w-6" aria-hidden />} title="Nothing here yet" action={<Button onClick={() => setScreen('menu')}>Back to menu</Button>} />
          ) : (
            <>
              <ul className="divide-y divide-line rounded-card border border-line bg-surface">
                {cart.lines.map((line) => (
                  <li key={line.lineId} className="p-3">
                    <div className="flex justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-ink">
                          {line.name}
                          {line.variantName !== 'Regular' ? <span className="text-ink-soft"> · {line.variantName}</span> : null}
                        </p>
                        {line.modifiers.length ? <p className="text-sm text-ink-soft">{line.modifiers.map((x) => x.name).join(', ')}</p> : null}
                        {line.notes ? <p className="text-sm italic text-ink-faint">“{line.notes}”</p> : null}
                      </div>
                      <p className="tabular shrink-0 font-semibold">{money(lineUnitMinor(line) * line.quantity, m.currency)}</p>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button size="icon" aria-label={`Decrease ${line.name}`} onClick={() => dispatch({ kind: 'setQuantity', lineId: line.lineId, quantity: line.quantity - 1 })}>
                        {line.quantity === 1 ? <Trash2 className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                      </Button>
                      <span className="tabular w-8 text-center font-bold">{line.quantity}</span>
                      <Button size="icon" aria-label={`Increase ${line.name}`} disabled={line.quantity >= 20} onClick={() => dispatch({ kind: 'setQuantity', lineId: line.lineId, quantity: line.quantity + 1 })}>
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <Field label="Your name (optional)" hint="So staff know who the order is for.">
                {(p) => <Input {...p} value={guestName} maxLength={60} autoComplete="given-name" onChange={(e) => setGuestName(e.target.value)} />}
              </Field>
              <Field label="Note for the kitchen (optional)" hint="Allergies or special requests.">
                {(p) => <Input {...p} value={cart.notes} maxLength={200} onChange={(e) => dispatch({ kind: 'patch', fields: { notes: e.target.value } })} />}
              </Field>
              <div className="rounded-card border border-line bg-surface p-4">
                {quote.isPending ? (
                  <Skeleton className="h-24" />
                ) : quote.isError ? (
                  <Notice tone="bad">{message(quote.error)}</Notice>
                ) : (
                  <Totals currency={m.currency} {...quote.data} />
                )}
              </div>
              {place.isError ? <Notice tone="bad">{message(place.error)}</Notice> : null}
              <Button variant="primary" size="lg" disabled={!quote.data} loading={place.isPending} onClick={() => place.mutate()}>
                Place order{quote.data ? ` · ${money(quote.data.totalMinor, m.currency)}` : ''}
              </Button>
              <p className="text-center text-xs text-ink-faint">You pay on the next screen. The kitchen starts once payment is confirmed.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  let products = catalog.products;
  if (category !== 'all') {
    const ids = new Set([category, ...catalog.categories.filter((c) => c.parentId === category).map((c) => c.id)]);
    products = products.filter((p) => ids.has(p.categoryId));
  }
  products = searchProducts(products, search);
  const count = cartCount(cart);
  const estimate = cart.lines.reduce((a, l) => a + lineUnitMinor(l) * l.quantity, 0);
  const pick = (product: CatalogProduct) => {
    if (product.variants.length > 1 || product.modifierGroupIds.length > 0) return setOptions(product);
    const variant = product.variants[0]!;
    dispatch({ kind: 'add', line: { productId: product.id, variantId: variant.id, name: product.name, variantName: variant.name, quantity: 1, unitPriceMinor: variant.priceMinor, modifiers: [], notes: '' } });
  };

  return (
    <div className="min-h-dvh bg-canvas pb-28">
      {header}
      <div className="mx-auto max-w-xl">
        {myOrders.length > 0 ? (
          <div className="flex gap-2 overflow-x-auto px-4 pt-3">
            {myOrders.slice(0, 5).map((token, i) => (
              <Button key={token} size="sm" onClick={() => setViewing(token)}>
                <ReceiptText className="h-4 w-4" aria-hidden /> {i === 0 ? 'My latest order' : `Earlier order ${i}`}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="px-4 pt-3">
          <Input type="search" aria-label="Search the menu" placeholder="Search the menu" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <nav aria-label="Categories" className="sticky top-0 z-10 flex gap-2 overflow-x-auto bg-canvas px-4 py-3">
          {[{ id: 'all', name: 'All' }, ...catalog.categories.filter((c) => !c.parentId)].map((c) => (
            <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(c.id)} className={cn('h-11 shrink-0 rounded-full px-4 text-sm font-semibold', category === c.id ? 'bg-ink text-white' : 'bg-sunken text-ink-soft')}>
              {c.name}
            </button>
          ))}
        </nav>
        {products.length === 0 ? (
          <EmptyState title="Nothing matches" description="Try another category or search." />
        ) : (
          <ul className="flex flex-col gap-2 px-4">
            {products.map((p) => {
              const from = Math.min(...p.variants.map((v) => v.priceMinor));
              return (
                <li key={p.id} className={cn('flex items-center justify-between gap-3 rounded-card border border-line bg-surface p-3 shadow-card', !p.isAvailable && 'opacity-60')}>
                  <div className="min-w-0">
                    <p className="flex items-start gap-1.5 font-semibold text-ink">
                      {p.isVeg != null ? <Leaf className={cn('mt-1 h-3.5 w-3.5 shrink-0', p.isVeg ? 'text-ok' : 'text-bad')} aria-label={p.isVeg ? 'Vegetarian' : 'Non-vegetarian'} /> : null}
                      {p.name}
                    </p>
                    {p.description ? <p className="mt-0.5 line-clamp-2 text-sm text-ink-soft">{p.description}</p> : null}
                    <p className="tabular mt-1 text-sm font-bold text-ink">
                      {p.variants.length > 1 ? 'from ' : ''}
                      {money(from, m.currency)}
                    </p>
                  </div>
                  {p.isAvailable ? (
                    <Button variant="primary" aria-label={`Add ${p.name}`} onClick={() => pick(p)}>
                      <Plus className="h-4 w-4" aria-hidden /> Add
                    </Button>
                  ) : (
                    <Badge tone="bad">Sold out</Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="px-4 pt-4 text-center text-xs text-ink-faint">{m.pricesIncludeTax ? 'Prices include taxes.' : 'Taxes are added at checkout.'}</p>
      </div>

      {count > 0 ? (
        <div className="fixed inset-x-0 bottom-0 border-t border-line bg-surface p-3">
          <Button variant="primary" size="lg" className="mx-auto flex w-full max-w-xl justify-between" onClick={() => setScreen('cart')}>
            <span>
              View order ({count} {count === 1 ? 'item' : 'items'})
            </span>
            <span className="tabular">{money(estimate, m.currency)}</span>
          </Button>
        </div>
      ) : null}
      <ProductOptionsDialog product={options} catalog={catalog} onClose={() => setOptions(null)} onAdd={(line) => dispatch({ kind: 'add', line })} />
    </div>
  );
}
