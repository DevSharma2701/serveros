import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { ReportsPage } from './ReportsPage';
import type { DashboardResponse } from './types';

const outlet = { id: 'outlet-1', name: 'Indiranagar', code: 'BLR1', timezone: 'Asia/Kolkata', city: 'Bengaluru', stateCode: '29' };
const second = { ...outlet, id: 'outlet-2', name: 'Koramangala', code: 'BLR2' };
let permissions: string[] = [];

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong'),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ me: { user: { id: 'u1', name: 'Meera', email: 'm@x.test', role: { key: 'RESTAURANT_OWNER', name: 'Owner', rank: 90 } }, restaurant: { currency: 'INR' }, outlets: [outlet, second], permissions }, outlet, can: (p: string) => permissions.includes(p) }),
  useOutlet: () => outlet,
}));

const definitions = {
  scope: 'Sales figures cover orders COMPLETED in the period.',
  grossSales: 'Sum of item amounts at menu price before any discount.',
  discounts: 'Item-level plus order-level discounts.',
  netSales: 'Taxable value of those orders.',
  taxes: 'Tax recorded on those orders.',
  totalBilled: 'Grand total of those orders.',
  averageOrderValue: 'Total billed divided by the number of completed orders.',
  collected: 'Successful payments received in the period.',
  refunds: 'Refunds issued in the period.',
  netCollected: 'Collected minus refunds.',
  cashVariance: 'Counted cash minus expected cash for shifts closed in the period.',
};

const withSales: DashboardResponse = {
  range: { from: '2026-10-04', to: '2026-10-06' },
  outlets: [{ id: outlet.id, name: outlet.name, timezone: outlet.timezone }],
  definitions,
  summary: {
    orders: 49,
    grossSalesMinor: 4019000,
    discountsMinor: 12300,
    serviceChargeMinor: 0,
    deliveryChargeMinor: 40000,
    netSalesMinor: 4059000,
    taxesMinor: 204510,
    roundOffMinor: 190,
    totalBilledMinor: 4263700,
    averageOrderValueMinor: 87014,
    collectedMinor: 4263700,
    refundsMinor: 55500,
    netCollectedMinor: 4208200,
    cancelledOrders: 3,
    openOrders: 2,
    cashVarianceMinor: -2000,
  },
  paymentsByMethod: [
    { method: 'UPI', count: 26, amountMinor: 2266000, refundedMinor: 55500 },
    { method: 'CASH', count: 20, amountMinor: 1997700, refundedMinor: 0 },
  ],
  salesByType: [
    { type: 'DINE_IN', orders: 16, totalMinor: 1051100 },
    { type: 'TAKEAWAY', orders: 33, totalMinor: 3212600 },
  ],
  topProducts: [{ productId: 'p1', name: 'Tandoori Roti', quantity: 17, netSalesMinor: 68000 }],
  categories: [{ name: 'Mains', quantity: 39, netSalesMinor: 1273000 }],
  taxes: [],
  hourly: [
    { hour: 11, orders: 4, totalMinor: 163200 },
    { hour: 13, orders: 9, totalMinor: 801100 },
  ],
  daily: [
    { day: '2026-10-04', orders: 6, totalMinor: 338100, netSalesMinor: 321000 },
    { day: '2026-10-06', orders: 43, totalMinor: 3925600, netSalesMinor: 3738000 },
  ],
  outletComparison: [{ outletId: outlet.id, outlet: outlet.name, orders: 49, netSalesMinor: 4059000, totalBilledMinor: 4263700, cancelledOrders: 3 }],
  cashShifts: [{ id: 's1', openedByName: 'Meera Iyer', closedAt: '2026-10-06T08:01:55.608Z', expectedCashMinor: 1645400, countedCashMinor: 1643400, varianceMinor: -2000, register: 'Counter 2', outlet: outlet.name }],
  inventoryAlerts: [{ outletId: outlet.id, outlet: outlet.name, ingredientId: 'i1', name: 'Paneer', quantity: '1500', threshold: '2000', unit: 'g' }],
};

const zero = (o: DashboardResponse): DashboardResponse => ({
  ...o,
  summary: Object.fromEntries(Object.keys(o.summary).map((k) => [k, 0])) as unknown as DashboardResponse['summary'],
  paymentsByMethod: [],
  salesByType: [],
  topProducts: [],
  categories: [],
  hourly: [],
  daily: [],
  outletComparison: [{ outletId: outlet.id, outlet: outlet.name, orders: 0, netSalesMinor: 0, totalBilledMinor: 0, cancelledOrders: 0 }],
  cashShifts: [],
  inventoryAlerts: [],
});

const mockedApi = vi.mocked(api);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReportsPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The KPI tile (list item) whose label is `label`. */
const tile = (label: string) => {
  const list = screen.getByRole('list', { name: 'Headline figures' });
  const item = within(list).getByText(label).closest('li');
  if (!item) throw new Error(`No tile labelled ${label}`);
  return within(item);
};

beforeEach(() => {
  permissions = ['report.view'];
  mockedApi.mockReset();
});

describe('ReportsPage', () => {
  it('asks for the selected outlet and renders the figures the API returned', async () => {
    mockedApi.mockResolvedValue(withSales);
    renderPage();

    expect(await screen.findByRole('list', { name: 'Headline figures' })).toBeInTheDocument();
    const [path, options] = mockedApi.mock.calls[0]!;
    expect(path).toBe('/reports/dashboard');
    expect(options?.query).toMatchObject({ outletIds: outlet.id });
    expect(options?.query?.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(options?.query?.from).toBe(options?.query?.to); // default preset is Today

    const s = withSales.summary;
    expect(tile('Gross sales').getByText(money(s.grossSalesMinor))).toBeInTheDocument();
    expect(tile('Discounts').getByText(money(s.discountsMinor))).toBeInTheDocument();
    expect(tile('Net sales').getByText(money(s.netSalesMinor))).toBeInTheDocument();
    expect(tile('Taxes').getByText(money(s.taxesMinor))).toBeInTheDocument();
    expect(tile('Total billed').getByText(money(s.totalBilledMinor))).toBeInTheDocument();
    expect(tile('Completed orders').getByText('49')).toBeInTheDocument();
    expect(tile('Average order value').getByText(money(s.averageOrderValueMinor))).toBeInTheDocument();
    expect(tile('Collected').getByText(money(s.collectedMinor))).toBeInTheDocument();
    expect(tile('Refunds').getByText(money(s.refundsMinor))).toBeInTheDocument();
    expect(tile('Net collected').getByText(money(s.netCollectedMinor))).toBeInTheDocument();
    expect(tile('Cancelled orders').getByText('3')).toBeInTheDocument();
    expect(tile('Open orders').getByText('2')).toBeInTheDocument();
    expect(tile('Cash variance').getByText(`−${money(2000)}`)).toBeInTheDocument();
    expect(tile('Cash variance').getByText('Cash was short')).toBeInTheDocument();

    // Breakdowns print the API's own values.
    const payments = within(screen.getByRole('region', { name: 'Sales by payment method' }));
    expect(payments.getByText('Upi')).toBeInTheDocument();
    expect(payments.getByText(money(2266000))).toBeInTheDocument();
    expect(payments.getByText(new RegExp(`Refunded ${money(55500).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Sales by order type' })).getByText(money(3212600))).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Top-selling products' })).getByText('Tandoori Roti')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Category performance' })).getByText(money(1273000))).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Daily trend' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Hourly trend' })).toBeInTheDocument();
    expect(screen.getByText(`Short ${money(2000)}`)).toBeInTheDocument();
    expect(screen.getByText('Paneer')).toBeInTheDocument();
    expect(screen.queryByText('No sales in this period')).not.toBeInTheDocument();
  });

  it('shows each definition from the response when its info button is focused', async () => {
    mockedApi.mockResolvedValue(withSales);
    renderPage();
    const button = await screen.findByRole('button', { name: 'How gross sales is calculated' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent(definitions.grossSales);
  });

  it('gives the trend charts a table view with the same numbers', async () => {
    mockedApi.mockResolvedValue(withSales);
    renderPage();
    const daily = within(await screen.findByRole('region', { name: 'Daily trend' }));
    await userEvent.click(daily.getByRole('button', { name: 'View as table' }));
    // Three days in the range: the day with no orders is listed as a real zero.
    expect(daily.getAllByRole('row')).toHaveLength(4);
    expect(daily.getByText(money(3925600))).toBeInTheDocument();
  });

  it('shows an empty state instead of charts when there were no sales', async () => {
    mockedApi.mockResolvedValue(zero(withSales));
    renderPage();
    expect(await screen.findByText('No sales in this period')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Daily trend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Sales by payment method' })).not.toBeInTheDocument();
    expect(tile('Gross sales').getByText(money(0))).toBeInTheDocument();
    expect(screen.getByText('No shifts were closed')).toBeInTheDocument();
    expect(screen.getByText('No low stock')).toBeInTheDocument();
  });

  it('hides the export buttons without report.export', async () => {
    mockedApi.mockResolvedValue(withSales);
    renderPage();
    await screen.findByRole('list', { name: 'Headline figures' });
    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
  });

  it('exports the chosen dataset as CSV text with report.export', async () => {
    permissions = ['report.view', 'report.export'];
    mockedApi.mockImplementation(async (path) => (path === '/reports/export.csv' ? 'Outlet,Order\n' : withSales));
    const createObjectURL = vi.fn(() => 'blob:test');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderPage();
    await screen.findByRole('list', { name: 'Headline figures' });
    expect(screen.getByRole('button', { name: 'Export orders to CSV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export items to CSV' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Export payments to CSV' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const call = mockedApi.mock.calls.find(([path]) => path === '/reports/export.csv');
    expect(call?.[1]).toMatchObject({ asText: true, query: { dataset: 'payments', outletIds: outlet.id } });
  });

  it('adds a second outlet to the request when it is ticked', async () => {
    mockedApi.mockResolvedValue(withSales);
    renderPage();
    await screen.findByRole('list', { name: 'Headline figures' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Koramangala' }));
    await waitFor(() => expect(mockedApi.mock.calls.some(([, o]) => o?.query?.outletIds === 'outlet-1,outlet-2')).toBe(true));
  });
});
