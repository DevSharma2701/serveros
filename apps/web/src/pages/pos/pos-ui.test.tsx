import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavigation } from '@/components/AppShell';
import { CheckoutDialog } from '@/components/checkout';
import { StatusBadge, ToastProvider } from '@/components/ui';
import type { Order } from '@/lib/types';
import { catalog } from './fixtures';
import { ProductOptionsDialog } from './dialogs';

const auth = vi.hoisted(() => ({ permissions: new Set<string>(), restaurant: { allowPartialPayment: false, loyaltyEnabled: false, loyaltyPointValueMinor: 100, discountApprovalThresholdBps: 1500 } }));
const apiMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ me: { user: { id: 'u1', name: 'Rohan', role: { key: 'CASHIER', name: 'Cashier', rank: 30 } }, restaurant: auth.restaurant, outlets: [], paymentGateway: 'none' }, outlet: { id: 'o1', name: 'Main', timezone: 'Asia/Kolkata' }, can: (p: string) => auth.permissions.has(p), offlineSession: false }),
  useOutlet: () => ({ id: 'o1', name: 'Main', timezone: 'Asia/Kolkata' }),
}));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: apiMock }));
// The back-office pages are not under test here.
vi.mock('@/pages/admin/routes', async () => {
  const { BarChart3, Users } = await import('lucide-react');
  return {
    adminRoutes: [
      { path: 'reports', label: 'Reports', icon: BarChart3, group: 'Insights', permission: 'report.view', element: null },
      { path: 'staff', label: 'Staff', icon: Users, group: 'People', permission: 'staff.view', element: null },
    ],
  };
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <ToastProvider>{children}</ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>
);

const order = (overrides: Partial<Order> = {}): Order =>
  ({
    id: 'ord-1', orderNumber: '261010-0007', type: 'TAKEAWAY', status: 'CONFIRMED', currency: 'INR', tableLabel: '', totalMinor: 21_000, paidMinor: 0, refundedMinor: 0, dueMinor: 21_000,
    paymentStatus: 'UNPAID', customer: null, payments: [], refunds: [], items: [], events: [], taxLines: [], tables: [], invoice: null, ...overrides,
  }) as Order;

beforeEach(() => {
  apiMock.mockReset();
  auth.permissions = new Set(['order.create', 'order.view', 'payment.record', 'shift.operate', 'table.view']);
});

describe('role-based navigation', () => {
  const labels = () => renderHook(() => useNavigation(), { wrapper }).result.current.flatMap((g) => g.items.map((i) => i.label));

  it('shows a cashier the tills and nothing from the back office', () => {
    expect(labels()).toEqual(['Point of sale', 'Tables', 'Orders', 'Cash shift']);
  });

  it('shows a waiter no cash screen', () => {
    auth.permissions = new Set(['order.create', 'order.view', 'table.view']);
    expect(labels()).toEqual(['Point of sale', 'Tables', 'Orders']);
  });

  it('adds back-office sections only for the permissions held', () => {
    auth.permissions = new Set(['order.view', 'report.view']);
    const groups = renderHook(() => useNavigation(), { wrapper }).result.current;
    expect(groups.map((g) => g.group)).toEqual(['Operations', 'Insights']);
    expect(groups[1]!.items.map((i) => i.label)).toEqual(['Reports']);
  });

  it('shows kitchen staff nothing here (they use the kitchen display)', () => {
    auth.permissions = new Set(['kitchen.view', 'kitchen.update']);
    expect(labels()).toEqual([]);
  });
});

describe('order status display', () => {
  it('labels every status in words, not only by colour', () => {
    render(
      <>
        <StatusBadge status="PREPARING" />
        <StatusBadge status="PARTIALLY_REFUNDED" />
      </>,
    );
    expect(screen.getByText('preparing')).toBeInTheDocument();
    expect(screen.getByText('partially refunded')).toBeInTheDocument();
  });
});

describe('choosing a product with options', () => {
  const curry = catalog.products.find((p) => p.id === 'curry')!;

  it('blocks adding until required choices are made, then adds the priced selection', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<ProductOptionsDialog product={curry} catalog={catalog} onClose={() => undefined} onAdd={onAdd} />, { wrapper });

    const add = screen.getByRole('button', { name: /^Add/ });
    expect(add).toBeDisabled();
    expect(screen.getByText('Choose one from Spice level')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Full/ }));
    await user.click(screen.getByRole('radio', { name: 'Mild' }));
    await user.click(screen.getByRole('radio', { name: 'Hot' })); // replaces Mild: single choice
    await user.click(screen.getByRole('checkbox', { name: /Butter/ }));
    await user.click(screen.getByRole('checkbox', { name: /Cheese/ }));
    expect(add).toBeEnabled();
    expect(add).toHaveTextContent('₹350.00');

    await user.click(screen.getByRole('checkbox', { name: /Egg/ })); // a third extra exceeds the limit of 2
    expect(add).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Egg/ }));

    await user.click(screen.getByRole('button', { name: 'Increase quantity' }));
    await user.type(screen.getByLabelText(/Preparation note/), 'no onion');
    await user.click(add);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ productId: 'curry', variantId: 'curry-f', quantity: 2, unitPriceMinor: 30_000, notes: 'no onion' }));
    expect(onAdd.mock.calls[0]![0].modifiers.map((m: { id: string }) => m.id)).toEqual(['hot', 'butter', 'cheese']);
  });
});

describe('checkout', () => {
  const open = (o: Order) => {
    apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'POST') return { payments: [] };
      if (path === '/orders/ord-1') return o;
      throw new Error(`unexpected call ${path}`);
    });
    render(<CheckoutDialog orderId="ord-1" open onClose={() => undefined} />, { wrapper });
  };
  const payButton = () => screen.getByRole('button', { name: /Record payment/ });

  it('shows the amount the server says is due and pre-fills exact cash', async () => {
    open(order());
    expect(await screen.findByText('₹210.00', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('210.00');
    expect(payButton()).toBeEnabled();
  });

  it('refuses over-payment, part payment and too little cash', async () => {
    const user = userEvent.setup();
    open(order());
    const amount = await screen.findByLabelText('Amount');

    await user.clear(amount);
    await user.type(amount, '250');
    expect(screen.getByText(/Over by ₹40.00/)).toBeInTheDocument();
    expect(payButton()).toBeDisabled();

    await user.clear(amount);
    await user.type(amount, '100');
    expect(screen.getByText(/₹110.00 still to pay/)).toBeInTheDocument();
    expect(payButton()).toBeDisabled(); // part payment is off for this restaurant

    await user.clear(amount);
    await user.type(amount, '210');
    await user.type(screen.getByLabelText('Cash received'), '200');
    expect(screen.getByText('Less than the amount')).toBeInTheDocument();
    expect(payButton()).toBeDisabled();

    await user.clear(screen.getByLabelText('Cash received'));
    await user.type(screen.getByLabelText('Cash received'), '500');
    expect(screen.getByText('Change ₹290.00')).toBeInTheDocument();
    expect(payButton()).toBeEnabled();
  });

  it('sends a split payment as one request with an idempotency key and no totals', async () => {
    const user = userEvent.setup();
    open(order());
    const amount = await screen.findByLabelText('Amount');
    await user.clear(amount);
    await user.type(amount, '100');
    await user.click(screen.getByRole('button', { name: /Split payment/ }));
    expect(screen.getAllByLabelText('Amount')[1]).toHaveValue('110.00'); // the remainder is suggested
    expect(screen.getByText('Covers the full amount')).toBeInTheDocument();
    await user.click(payButton());

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/orders/ord-1/payments', expect.objectContaining({ method: 'POST' })));
    const [, request] = apiMock.mock.calls.find(([path]) => path === '/orders/ord-1/payments')!;
    expect(request.idempotencyKey).toMatch(/^pay-/);
    expect(request.body).toEqual({ tenders: [{ method: 'CASH', amountMinor: 10_000, mode: 'MANUAL', reference: '' }, { method: 'UPI', amountMinor: 11_000, mode: 'MANUAL', reference: '' }] });
  });

  it('does not treat a pending gateway payment as paid', async () => {
    open(order({ payments: [{ id: 'p1', orderId: 'ord-1', method: 'UPI', provider: 'dev', state: 'PENDING', verification: 'GATEWAY', amountMinor: 21_000, tenderedMinor: null, changeMinor: 0, refundedMinor: 0, reference: '', failureReason: '', createdAt: '' }] }));
    expect(await screen.findByText(/waiting for confirmation/)).toBeInTheDocument();
    expect(screen.queryByText(/^Paid/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record payment/ })).not.toBeInTheDocument(); // nothing left to tender while it is reserved
    expect(screen.getByRole('button', { name: 'Simulate success' })).toBeInTheDocument();
  });

  it('confirms a settled bill and shows the change to return', async () => {
    open(order({ dueMinor: 0, paidMinor: 21_000, paymentStatus: 'PAID', invoice: { id: 'i1', invoiceNumber: 'MAIN/2627/00012', issuedAt: '' }, payments: [{ id: 'p1', orderId: 'ord-1', method: 'CASH', provider: 'cash', state: 'SUCCEEDED', verification: 'NOT_REQUIRED', amountMinor: 21_000, tenderedMinor: 50_000, changeMinor: 29_000, refundedMinor: 0, reference: '', failureReason: '', createdAt: '' }] }));
    expect(await screen.findByText('Paid ₹210.00')).toBeInTheDocument();
    expect(screen.getByText('Change to return: ₹290.00')).toBeInTheDocument();
    expect(screen.getByText('Invoice MAIN/2627/00012')).toBeInTheDocument();
  });
});
