import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import { api } from '@/lib/api';
import { CustomerForm } from './CustomerForm';
import type { CustomerRow } from './types';

let permissions: string[] = [];
vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong'),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ can: (p: string) => permissions.includes(p) }),
}));

const mockedApi = vi.mocked(api);
const existing: CustomerRow = { id: 'c1', name: 'Ananya Sharma', phone: '••••••0001', email: 'a•••@x.test', gstin: '', stateCode: '', marketingSms: true, marketingEmail: false, marketingWhatsapp: false, consentUpdatedAt: null, loyaltyPoints: 42, createdAt: '2026-10-10T08:01:31.286Z' };

function renderForm(customer: CustomerRow | null = null) {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CustomerForm open onClose={onClose} customer={customer} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  permissions = ['customer.view', 'customer.view_contact', 'customer.manage', 'customer.notes'];
  mockedApi.mockReset();
});

describe('CustomerForm', () => {
  it('shows validation errors and does not call the API', async () => {
    renderForm();
    await userEvent.type(screen.getByLabelText('Phone'), '12ab');
    await userEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(await screen.findByText('Enter a valid phone number')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('creates a customer with the cleaned-up values', async () => {
    mockedApi.mockResolvedValue({ ...existing, id: 'c2', name: 'Rohan Mehta' });
    const { onClose } = renderForm();
    await userEvent.type(screen.getByLabelText('Name'), '  Rohan Mehta ');
    await userEvent.type(screen.getByLabelText('Phone'), '98111 00009');
    await userEvent.type(screen.getByLabelText('Notes'), 'Peanut allergy');
    await userEvent.click(screen.getByRole('checkbox', { name: 'WhatsApp' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add customer' }));

    await waitFor(() => expect(mockedApi).toHaveBeenCalledTimes(1));
    expect(mockedApi).toHaveBeenCalledWith('/customers', {
      method: 'POST',
      body: { name: 'Rohan Mehta', phone: '9811100009', email: '', gstin: '', stateCode: '', notes: 'Peanut allergy', marketingSms: false, marketingEmail: false, marketingWhatsapp: true },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('hides notes without customer.notes and never sends them', async () => {
    permissions = ['customer.view', 'customer.view_contact', 'customer.manage'];
    mockedApi.mockResolvedValue({ ...existing, name: 'Rohan Mehta' });
    renderForm();
    expect(screen.queryByLabelText('Notes')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), 'Rohan Mehta');
    await userEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledTimes(1));
    expect(mockedApi.mock.calls[0]![1]?.body).not.toHaveProperty('notes');
  });

  it('sends only changed fields on edit, and never the masked contact details', async () => {
    permissions = ['customer.view', 'customer.manage'];
    mockedApi.mockResolvedValue({ ...existing, marketingEmail: true });
    renderForm(existing);
    // Contact details arrive masked for this role, so they are not editable.
    expect(screen.queryByLabelText('Phone')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Email' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledTimes(1));
    expect(mockedApi).toHaveBeenCalledWith('/customers/c1', { method: 'PATCH', body: { marketingEmail: true } });
  });
});
