import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import { api } from '@/lib/api';
import type { Category, Product } from '../types';
import { ProductForm } from './ProductForm';

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong'),
  assetUrl: (path: string | null) => path ?? undefined,
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ can: () => true, outlet: { id: 'outlet-1', name: 'Main' }, me: null }),
  useOutlet: () => ({ id: 'outlet-1', name: 'Main' }),
}));

const mockedApi = vi.mocked(api);
const CATEGORY_ID = '3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b';
const VARIANT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const categories: Category[] = [{ id: CATEGORY_ID, parentId: null, name: 'Starters', sortOrder: 0, isActive: true, _count: { products: 0 } }];
const lookups = { categories, taxCategories: [], modifierGroups: [], stations: [] };

function renderForm(product?: Product) {
  const onSaved = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ProductForm product={product} lookups={lookups} onSaved={onSaved} onCancel={vi.fn()} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onSaved };
}

describe('ProductForm', () => {
  beforeEach(() => mockedApi.mockReset());

  it('asks for a name, SKU, category and a price before saving', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: 'Create product' }));

    expect(await screen.findByText('Some fields need attention. Check the messages above.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('This is required');
    expect(screen.getByLabelText('SKU')).toHaveAccessibleDescription('This is required');
    expect(screen.getByLabelText('Category')).toHaveAccessibleDescription('Choose one');
    expect(screen.getByLabelText('Price (₹)')).toHaveAccessibleDescription('Enter an amount');
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('needs at least one variant', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Name'), 'Paneer Tikka');
    await user.type(screen.getByLabelText('SKU'), 'PT-01');
    await user.selectOptions(screen.getByLabelText('Category'), CATEGORY_ID);
    await user.click(screen.getByRole('button', { name: 'Remove Regular' }));
    await user.click(screen.getByRole('button', { name: 'Create product' }));

    expect(await screen.findByText('Add at least one variant')).toBeInTheDocument();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('rejects a price that is not an amount', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Price (₹)'), 'twelve');
    await user.click(screen.getByRole('button', { name: 'Create product' }));

    await waitFor(() => expect(screen.getByLabelText('Price (₹)')).toHaveAccessibleDescription('Enter an amount like 120 or 120.50'));
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('creates the product with prices in minor units', async () => {
    const user = userEvent.setup();
    mockedApi.mockResolvedValue({ id: 'new', name: 'Paneer Tikka' });
    const { onSaved } = renderForm();

    await user.type(screen.getByLabelText('Name'), 'Paneer Tikka');
    await user.type(screen.getByLabelText('SKU'), 'PT-01');
    await user.selectOptions(screen.getByLabelText('Category'), CATEGORY_ID);
    await user.selectOptions(screen.getByLabelText('Food type'), 'veg');
    await user.type(screen.getByLabelText('Price (₹)'), '120.50');
    await user.click(screen.getByRole('button', { name: 'Add variant' }));
    const second = screen.getAllByRole('listitem')[1]!;
    await user.type(within(second).getByLabelText('Variant name'), 'Large');
    await user.type(within(second).getByLabelText('Price (₹)'), '1,180');
    await user.click(screen.getByRole('button', { name: 'Create product' }));

    await waitFor(() => expect(mockedApi).toHaveBeenCalledTimes(1));
    const [path, options] = mockedApi.mock.calls[0]!;
    expect(path).toBe('/menu/products');
    expect(options?.method).toBe('POST');
    expect(options?.body).toMatchObject({
      name: 'Paneer Tikka',
      sku: 'PT-01',
      categoryId: CATEGORY_ID,
      isVeg: true,
      taxCategoryId: null,
      stationKey: null,
      variants: [
        { name: 'Regular', priceMinor: 12050, isDefault: true, isActive: true },
        { name: 'Large', priceMinor: 118000, isDefault: false, isActive: true },
      ],
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('keeps variant ids when editing and refuses to leave every variant inactive', async () => {
    const user = userEvent.setup();
    mockedApi.mockResolvedValue({ id: 'p1', name: 'Masala Chai' });
    const product: Product = {
      id: 'p1', categoryId: CATEGORY_ID, taxCategoryId: null, name: 'Masala Chai', sku: 'CH-01', description: '', imageUrl: null, isVeg: true, isActive: true, isFavorite: false, stationKey: null,
      variants: [{ id: VARIANT_ID, productId: 'p1', name: 'Cup', priceMinor: 4000, isDefault: true, isActive: true, sortOrder: 0 }],
      modifierGroups: [],
      category: { id: CATEGORY_ID, name: 'Starters' },
    };
    renderForm(product);
    expect(screen.getByLabelText('Price (₹)')).toHaveValue('40.00');

    const row = screen.getAllByRole('listitem')[0]!;
    await user.click(within(row).getByLabelText('Active'));
    await user.click(screen.getByRole('button', { name: 'Save product' }));
    expect(await screen.findByText('At least one variant must be active')).toBeInTheDocument();
    expect(mockedApi).not.toHaveBeenCalled();

    await user.click(within(row).getByLabelText('Active'));
    await user.clear(screen.getByLabelText('Price (₹)'));
    await user.type(screen.getByLabelText('Price (₹)'), '45');
    await user.click(screen.getByRole('button', { name: 'Save product' }));

    await waitFor(() => expect(mockedApi).toHaveBeenCalledTimes(1));
    const [path, options] = mockedApi.mock.calls[0]!;
    expect(path).toBe('/menu/products/p1');
    expect(options?.method).toBe('PATCH');
    expect(options?.body).toMatchObject({ variants: [{ id: VARIANT_ID, name: 'Cup', priceMinor: 4500 }] });
  });
});
