import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import { catalog } from '../pos/fixtures';
import { GuestPage, type GuestOrder } from './GuestPage';

const TOKEN = 'table-secret-token-0123456789';
const menu = {
  restaurant: 'Saffron Table', outlet: 'Indiranagar', table: 'T4', currency: 'INR', pricesIncludeTax: false, onlinePayment: 'dev',
  categories: catalog.categories, modifierGroups: catalog.modifierGroups, popularProductIds: [],
  products: catalog.products.map(({ sku: _sku, taxCategoryId: _tax, ...p }) => p),
};
const order = (overrides: Partial<GuestOrder> = {}): GuestOrder => ({
  guestToken: 'guest-order-token-0123456789', orderNumber: '261010-0060', status: 'PLACED', table: 'T4', currency: 'INR',
  items: [{ name: 'Masala Chai', variant: 'Regular', quantity: 2, modifiers: [], notes: '', amountMinor: 20_000 }],
  subtotalMinor: 20_000, serviceChargeMinor: 0, taxLines: [{ name: 'CGST 2.5%', amountMinor: 500 }, { name: 'SGST 2.5%', amountMinor: 500 }], roundOffMinor: 0, totalMinor: 21_000, refundedMinor: 0,
  payment: { state: 'UNPAID', provider: null, lastFailure: null, payBy: new Date(Date.now() + 900_000).toISOString() },
  kitchen: { tickets: 0, ready: 0 }, needsStaff: false, cancelReason: null, onlinePayment: 'dev', ...overrides,
});

let current: GuestOrder;
const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
const respond = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  current = order();
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const path = url.replace(/^.*\/public/, '');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, method: init.method ?? 'GET', body, headers: (init.headers ?? {}) as Record<string, string> });
      if (path === `/tables/${TOKEN}`) return respond(menu);
      if (path === '/tables/dead-token-0123456789abcdef') return respond({ error: { code: 'NOT_FOUND', message: 'Table not found' } }, 404);
      if (path.endsWith('/quote')) return respond({ subtotalMinor: 20_000, serviceChargeMinor: 0, taxMinor: 1_000, roundOffMinor: 0, totalMinor: 21_000, taxLines: current.taxLines });
      if (path.endsWith('/orders') && init.method === 'POST') return respond(current, 201);
      if (path.endsWith('/pay')) return respond((current = order({ payment: { state: 'PENDING', provider: 'dev', lastFailure: null, payBy: null } })));
      if (path.endsWith('/dev-pay')) {
        current = body.outcome === 'success' ? order({ status: 'CONFIRMED', payment: { state: 'PAID', provider: null, lastFailure: null, payBy: null }, kitchen: { tickets: 1, ready: 0 } }) : order({ payment: { state: 'UNPAID', provider: null, lastFailure: 'Declined (simulated)', payBy: null } });
        return respond(current);
      }
      if (path.startsWith('/orders/')) return respond(current);
      return respond({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const show = (token = TOKEN) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <GuestPage tableToken={token} />
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('guest ordering page', () => {
  it('shows the table and menu without any sign-in, and marks sold-out items', async () => {
    show();
    expect(await screen.findByText('Indiranagar · Table T4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Masala Chai' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Add Butter Naan' })).not.toBeInTheDocument(); // unavailable in the fixture
    expect(screen.getByText('Sold out')).toBeInTheDocument();
    expect(calls[0]!.headers).not.toHaveProperty('Authorization');
  });

  it('explains an inactive QR code instead of showing an error page', async () => {
    show('dead-token-0123456789abcdef');
    expect(await screen.findByText('This QR code is not active')).toBeInTheDocument();
  });

  it('places the order with server totals, an idempotency key and no prices, then asks for payment', async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Add Masala Chai' }));
    await user.click(screen.getByRole('button', { name: 'Add Masala Chai' }));
    await user.click(screen.getByRole('button', { name: /View order \(2 items\)/ }));
    await user.type(screen.getByLabelText(/Your name/), 'Ananya');
    await user.click(await screen.findByRole('button', { name: /Place order · ₹210.00/ })); // the total comes from the quote

    expect(await screen.findByText('To pay')).toBeInTheDocument();
    expect(screen.getByText(/goes to the kitchen as soon as it is paid/)).toBeInTheDocument();
    expect(screen.queryByText(/^Paid/)).not.toBeInTheDocument();

    const placed = calls.find((c) => c.url === `/tables/${TOKEN}/orders`)!;
    expect(placed.headers['Idempotency-Key']).toMatch(/^order-/);
    expect(placed.body).toMatchObject({ guestName: 'Ananya', items: [{ productId: 'tea', variantId: 'tea-r', quantity: 2 }] });
    expect(JSON.stringify(placed.body)).not.toMatch(/Minor|price|total/i);
    expect(JSON.parse(localStorage.getItem(`serveos.guest.${TOKEN}`)!)).toEqual([current.guestToken]);
  });

  it('labels the payment simulator honestly, recovers from a failed payment, and shows progress once paid', async () => {
    const user = userEvent.setup();
    localStorage.setItem(`serveos.guest.${TOKEN}`, JSON.stringify([current.guestToken]));
    show();
    await user.click(await screen.findByRole('button', { name: 'My latest order' }));
    await user.click(await screen.findByRole('button', { name: 'Pay ₹210.00' }));

    expect(await screen.findByText('Payment simulator (development)')).toBeInTheDocument();
    expect(screen.getByText(/no money moves/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Payment fails' }));
    expect(await screen.findByText('The payment did not go through')).toBeInTheDocument();
    expect(screen.getByText(/Nothing was charged/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pay ₹210.00' }));
    await user.click(await screen.findByRole('button', { name: 'Payment succeeds' }));
    await waitFor(() => expect(screen.getByText('Received').closest('li')).toHaveAttribute('aria-current', 'step'));
    expect(screen.getByRole('button', { name: /View receipt/ })).toBeInTheDocument();
    expect(screen.queryByText('To pay')).not.toBeInTheDocument();
  });

  it("opens Razorpay's checkout with the server's values and sends its signed result back for verification", async () => {
    const user = userEvent.setup();
    const checkout = { provider: 'razorpay' as const, keyId: 'rzp_test_public', orderId: 'order_T1', amountMinor: 21_000, currency: 'INR' };
    const opened: Array<Record<string, unknown>> = [];
    // Stand-in for Razorpay's script: records the options and lets the test play the guest paying.
    window.Razorpay = class {
      constructor(options: Record<string, unknown>) {
        opened.push(options);
      }
      open() {}
    } as unknown as Window['Razorpay'];
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(((url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^.*\/public/, '');
      if (path.endsWith('/pay')) {
        calls.push({ url: path, method: 'POST', body: undefined, headers: {} });
        return respond((current = order({ onlinePayment: 'razorpay', payment: { state: 'PENDING', provider: 'razorpay', lastFailure: null, payBy: null, checkout } })));
      }
      if (path.endsWith('/confirm')) {
        calls.push({ url: path, method: 'POST', body: JSON.parse(String(init.body)), headers: {} });
        return respond((current = order({ status: 'CONFIRMED', onlinePayment: 'razorpay', payment: { state: 'PAID', provider: null, lastFailure: null, payBy: null }, kitchen: { tickets: 1, ready: 0 } })));
      }
      return base(url, init);
    }) as typeof fetch);
    current = order({ onlinePayment: 'razorpay' });
    localStorage.setItem(`serveos.guest.${TOKEN}`, JSON.stringify([current.guestToken]));

    show();
    await user.click(await screen.findByRole('button', { name: 'My latest order' }));
    await user.click(await screen.findByRole('button', { name: 'Pay ₹210.00' }));
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toMatchObject({ key: 'rzp_test_public', order_id: 'order_T1', amount: 21_000, currency: 'INR' });
    expect(screen.queryByText('Payment simulator (development)')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Paid/)).not.toBeInTheDocument(); // opening the checkout is not payment

    const result = { razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_T1', razorpay_signature: 'sig' };
    (opened[0]!.handler as (r: typeof result) => void)(result);
    await waitFor(() => expect(screen.getByText('Received').closest('li')).toHaveAttribute('aria-current', 'step'));
    expect(calls.find((x) => x.url.endsWith('/confirm'))!.body).toEqual(result);
    delete window.Razorpay;
  });

  it('tells a paid guest plainly when staff need to step in, and when an order was cancelled', async () => {
    const user = userEvent.setup();
    current = order({ payment: { state: 'PAID', provider: null, lastFailure: null, payBy: null }, needsStaff: true });
    localStorage.setItem(`serveos.guest.${TOKEN}`, JSON.stringify([current.guestToken]));
    const { unmount } = show();
    await user.click(await screen.findByRole('button', { name: 'My latest order' }));
    expect(await screen.findByText(/a member of staff will be with you/)).toBeInTheDocument();
    unmount();

    current = order({ status: 'CANCELLED', cancelReason: 'Out of stock', refundedMinor: 21_000, payment: { state: 'UNPAID', provider: null, lastFailure: null, payBy: null } });
    show();
    await user.click(await screen.findByRole('button', { name: 'My latest order' }));
    expect(await screen.findByText('This order was cancelled')).toBeInTheDocument();
    expect(screen.getByText(/₹210.00 has been refunded/)).toBeInTheDocument();
  });
});
