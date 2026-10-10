import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import { api } from '@/lib/api';
import type { StockRow, Unit } from '../types';
import { StockTab } from './StockTab';

const auth = vi.hoisted(() => ({ permissions: new Set<string>() }));

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong'),
}));
vi.mock('@/lib/auth', () => {
  const outlet = { id: 'outlet-1', name: 'Indiranagar', code: 'IND', timezone: 'Asia/Kolkata', city: 'Bengaluru', stateCode: '29' };
  const other = { ...outlet, id: 'outlet-2', name: 'Koramangala', code: 'KOR' };
  return {
    useAuth: () => ({ can: (permission: string) => auth.permissions.has(permission), outlet, me: { outlets: [outlet, other] } }),
    useOutlet: () => outlet,
  };
});

const mockedApi = vi.mocked(api);
const stock: StockRow[] = [
  { ingredientId: 'i1', name: 'Paneer', sku: 'ING-PANEER', unit: 'g', quantity: '750', lowStockThreshold: '2000', isLow: true, valueMinor: 30000, costPerBaseMinor: '40' },
  { ingredientId: 'i2', name: 'Basmati rice', sku: 'ING-RICE', unit: 'g', quantity: '25000.5', lowStockThreshold: '5000', isLow: false, valueMinor: 250005, costPerBaseMinor: '10' },
];
const units: Unit[] = [
  { id: 'u-g', code: 'g', name: 'Gram', dimension: 'MASS', toBaseFactor: '1' },
  { id: 'u-kg', code: 'kg', name: 'Kilogram', dimension: 'MASS', toBaseFactor: '1000' },
  { id: 'u-ml', code: 'ml', name: 'Millilitre', dimension: 'VOLUME', toBaseFactor: '1' },
];

function respond(overrides: Record<string, () => Promise<unknown>> = {}) {
  mockedApi.mockImplementation(((path: string) => {
    if (overrides[path]) return overrides[path]();
    if (path === '/inventory/stock') return Promise.resolve(stock);
    if (path === '/units') return Promise.resolve(units);
    return Promise.resolve([]);
  }) as typeof api);
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <StockTab />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('StockTab', () => {
  beforeEach(() => {
    mockedApi.mockReset();
    auth.permissions = new Set(['inventory.view']);
    respond();
  });

  it('says the figures are theoretical and flags low stock from the API response', async () => {
    renderTab();
    expect(screen.getByText('This is theoretical stock')).toBeInTheDocument();

    const paneer = (await screen.findByText('Paneer')).closest('tr')!;
    expect(within(paneer).getByText('Low stock')).toBeInTheDocument();
    expect(within(paneer).getByText('750')).toBeInTheDocument();

    const rice = screen.getByText('Basmati rice').closest('tr')!;
    expect(within(rice).queryByText('Low stock')).not.toBeInTheDocument();
    expect(within(rice).getByText('OK')).toBeInTheDocument();
    expect(within(rice).getByText('25000.5')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Theoretical stock' })).toBeInTheDocument();
  });

  it('hides the adjust and transfer actions without inventory.manage', async () => {
    renderTab();
    await screen.findByText('Paneer');
    expect(screen.queryByRole('button', { name: /^Adjust/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transfer stock' })).not.toBeInTheDocument();
  });

  it('offers adjust and transfer with inventory.manage, with units of the ingredient’s dimension only', async () => {
    auth.permissions.add('inventory.manage');
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Paneer');
    expect(screen.getByRole('button', { name: 'Transfer stock' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Adjust Paneer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Adjust Paneer' });
    const unit = within(dialog).getByLabelText('Unit');
    expect(within(unit).getAllByRole('option').map((o) => o.textContent)).toEqual(['g', 'kg']);

    // A reason is required: nothing is sent without one.
    await user.type(within(dialog).getByLabelText('Quantity'), '0.5');
    await user.selectOptions(unit, 'u-kg');
    await user.click(within(dialog).getByRole('button', { name: 'Record wastage' }));
    expect(await within(dialog).findByText('Give a reason of at least 3 characters')).toBeInTheDocument();
    expect(mockedApi.mock.calls.some(([path]) => path === '/inventory/adjustments')).toBe(false);
  });

  it('can filter to low stock only', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Paneer');
    await user.click(screen.getByLabelText('Low stock only'));
    expect(screen.queryByText('Basmati rice')).not.toBeInTheDocument();
    expect(screen.getByText('Paneer')).toBeInTheDocument();
  });

  it('shows an error state with retry when stock cannot be loaded', async () => {
    respond({ '/inventory/stock': () => Promise.reject(new Error('Server unavailable')) });
    renderTab();
    expect(await screen.findByText('Server unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
