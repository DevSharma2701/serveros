import { fail, mockApi, networkDown, ok } from '../../test/api-mock';
import { CASHIER, DASHBOARD, INDIRANAGAR, KORAMANGALA, MANAGER, OWNER, TOKENS } from '../../test/fixtures';
import { fireEvent, renderApp, resetClient, screen, seedSession, waitFor } from '../../test/render-app';
import { dayIn } from '../lib/format';

beforeEach(resetClient);

const session = (me: unknown) => ({
  'POST /auth/refresh': () => ok(TOKENS),
  'GET /auth/me': () => ok(me),
});

describe('dashboard', () => {
  it('renders the numbers returned by the API for today in the outlet time zone', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    const server = mockApi({ ...session(MANAGER), 'GET /reports/dashboard': () => ok(DASHBOARD) });
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('stat-net-sales')).toBeTruthy());

    // Money arrives in paise and is shown in rupees.
    expect(screen.getByLabelText('Net sales: ₹6,820.00. After discounts, before tax')).toBeTruthy();
    expect(screen.getByLabelText('Completed orders: 8')).toBeTruthy();
    expect(screen.getByLabelText('Average order: ₹895.13')).toBeTruthy();
    expect(screen.getByLabelText('Open orders now: 2')).toBeTruthy();
    expect(screen.getByLabelText('Cancelled orders: 1')).toBeTruthy();
    expect(screen.getByLabelText('Cash variance: -₹20.00. 1 shift closed')).toBeTruthy();
    expect(screen.getByLabelText('Low-stock items: 1')).toBeTruthy();

    // The request covers "today" on the outlet's wall clock, for the selected outlet, with no outlet header.
    const today = dayIn('Asia/Kolkata');
    const call = server.callsTo('GET /reports/dashboard')[0]!;
    expect(call.query).toEqual({ from: today, to: today, outletIds: INDIRANAGAR.id });
    expect(call.headers['X-Outlet-Id']).toBeUndefined();
  });

  it('refetches for another date range and for all outlets when the filters change', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    const server = mockApi({ ...session(OWNER), 'GET /reports/dashboard': () => ok(DASHBOARD) });
    await renderApp();
    await waitFor(() => expect(screen.getByTestId('stat-net-sales')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Date range: Last 7 days'));
    await waitFor(() => expect(server.callsTo('GET /reports/dashboard')).toHaveLength(2));
    expect(server.callsTo('GET /reports/dashboard')[1]!.query).toMatchObject({ from: dayIn('Asia/Kolkata', -6), to: dayIn('Asia/Kolkata') });

    await fireEvent.press(screen.getByLabelText('Outlet filter: all outlets'));
    await waitFor(() => expect(server.callsTo('GET /reports/dashboard')).toHaveLength(3));
    expect(server.callsTo('GET /reports/dashboard')[2]!.query.outletIds!.split(',').sort()).toEqual([INDIRANAGAR.id, KORAMANGALA.id].sort());
  });
});

describe('API error handling', () => {
  it('shows a no-connection state with a retry that recovers', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    const server = mockApi({ ...session(MANAGER), 'GET /reports/dashboard': networkDown });
    await renderApp();

    await waitFor(() => expect(screen.getByText('No connection')).toBeTruthy(), { timeout: 15_000 });
    expect(screen.getByText(/Cannot reach the server/)).toBeTruthy();
    expect(screen.queryByTestId('stat-net-sales')).toBeNull();

    server.on('GET /reports/dashboard', () => ok(DASHBOARD));
    await fireEvent.press(screen.getByLabelText('Try again'));

    await waitFor(() => expect(screen.getByTestId('stat-net-sales')).toBeTruthy());
    expect(screen.queryByText('No connection')).toBeNull();
  });

  it('shows the API message for a 403 and offers no pointless retry', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    const server = mockApi({ ...session(MANAGER), 'GET /reports/dashboard': () => fail(403, 'FORBIDDEN', 'You are not assigned to one of these outlets') });
    await renderApp();

    await waitFor(() => expect(screen.getByText('No access to reports')).toBeTruthy());
    expect(screen.getByText('You are not assigned to one of these outlets')).toBeTruthy();
    expect(screen.queryByLabelText('Try again')).toBeNull();
    // A 403 will not change on its own: it is not retried.
    expect(server.callsTo('GET /reports/dashboard')).toHaveLength(1);
  });

  it('shows the API message and a reference for a server error', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    mockApi({ ...session(MANAGER), 'GET /reports/dashboard': () => fail(500, 'INTERNAL', 'Something broke on our side') });
    await renderApp();

    await waitFor(() => expect(screen.getByText('Something broke on our side')).toBeTruthy(), { timeout: 15_000 });
    expect(screen.getByText('Reference: test-correlation')).toBeTruthy();
    expect(screen.getByLabelText('Try again')).toBeTruthy();
  });

  it('does not even request reports the role cannot see, and says so', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    const server = mockApi(session(CASHIER));
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('no-access')).toBeTruthy());
    expect(screen.getByText('No access to reports')).toBeTruthy();
    expect(server.callsTo('GET /reports/dashboard')).toHaveLength(0);
  });

  it('offers a retry when a stored session cannot be resumed because the server is unreachable', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    const server = mockApi({ 'POST /auth/refresh': networkDown });
    await renderApp();

    await waitFor(() => expect(screen.getByText('No connection')).toBeTruthy());
    expect(screen.queryByTestId('login-submit')).toBeNull();

    server.on('POST /auth/refresh', () => ok(TOKENS));
    server.on('GET /auth/me', () => ok(MANAGER));
    server.on('GET /reports/dashboard', () => ok(DASHBOARD));
    await fireEvent.press(screen.getByLabelText('Try again'));

    await waitFor(() => expect(screen.getByTestId('stat-net-sales')).toBeTruthy());
  });
});

describe('permissions and deep links', () => {
  const CATALOG = {
    categories: [{ id: 'c1', name: 'Starters', parentId: null, sortOrder: 1 }],
    products: [{ id: 'p1', name: 'Paneer Tikka', sku: 'STR-001', categoryId: 'c1', isVeg: true, isAvailable: true, variants: [{ id: 'v1', name: 'Regular', priceMinor: 28000, isDefault: true }] }],
  };

  it('lets a manager toggle availability and sends the change to the selected outlet', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    const server = mockApi({ ...session(MANAGER), 'GET /menu/catalog': () => ok(CATALOG), 'PUT /menu/products/p1/availability': (req) => ok({ id: 'p1', isAvailable: req.body.isAvailable }) });
    await renderApp('/availability');

    await waitFor(() => expect(screen.getByTestId('availability-STR-001')).toBeTruthy());
    expect(screen.getByTestId('availability-STR-001').props.disabled).toBeFalsy();
    await fireEvent(screen.getByTestId('availability-STR-001'), 'valueChange', false);

    await waitFor(() => expect(server.callsTo('PUT /menu/products/p1/availability')).toHaveLength(1));
    const call = server.callsTo('PUT /menu/products/p1/availability')[0]!;
    expect(call.body).toEqual({ isAvailable: false });
    expect(call.headers['X-Outlet-Id']).toBe(INDIRANAGAR.id);
  });

  it('disables the availability switch for a role without menu.availability', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    mockApi({ ...session(CASHIER), 'GET /menu/catalog': () => ok(CATALOG) });
    await renderApp('/availability');

    await waitFor(() => expect(screen.getByTestId('availability-STR-001')).toBeTruthy());
    expect(screen.getByTestId('availability-STR-001').props.disabled).toBe(true);
    expect(screen.getByText('You can see availability but your role cannot change it.')).toBeTruthy();
  });

  it('opens an order from a deep link (serveos://orders/<id>)', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    const order = {
      id: 'o1', orderNumber: '261010-0051', type: 'TAKEAWAY', status: 'CONFIRMED', isHeld: false, currency: 'INR', tableLabel: '', guestCount: 1, notes: '',
      deliveryName: '', deliveryPhone: '', deliveryAddress: '', customer: { id: 'c', name: 'Priya Pillai' },
      subtotalMinor: 42000, itemDiscountMinor: 0, orderDiscountMinor: 0, serviceChargeMinor: 0, deliveryChargeMinor: 0, taxMinor: 2100, roundOffMinor: 0, totalMinor: 44100,
      paidMinor: 0, refundedMinor: 0, paymentStatus: 'UNPAID', cancelReason: '', createdAt: '2026-10-10T08:01:55.692Z', placedAt: '2026-10-10T08:01:55.697Z', completedAt: null,
      items: [{ id: 'i1', productName: 'Paneer Tikka', variantName: 'Regular', quantity: 1, unitPriceMinor: 28000, modifiersMinor: 0, lineSubtotalMinor: 28000, discountMinor: 0, taxMinor: 1400, totalMinor: 29400, notes: '', status: 'ACTIVE', voidReason: '', modifiers: [{ id: 'm1', groupName: 'Spice level', optionName: 'Spicy', priceMinor: 0 }] }],
      events: [{ id: 'e1', type: 'PLACED', fromStatus: 'DRAFT', toStatus: 'CONFIRMED', actorName: 'Meera Iyer', message: '', createdAt: '2026-10-10T08:01:55.697Z' }],
      payments: [],
    };
    const server = mockApi({ ...session(MANAGER), 'GET /orders/o1': () => ok(order) });
    await renderApp('/orders/o1');

    await waitFor(() => expect(screen.getByText('1 × Paneer Tikka')).toBeTruthy());
    expect(screen.getByText('Spice level: Spicy')).toBeTruthy();
    expect(screen.getByLabelText('Total: ₹441.00')).toBeTruthy();
    expect(server.callsTo('GET /orders/o1')[0]!.headers['X-Outlet-Id']).toBe(INDIRANAGAR.id);
  });
});
