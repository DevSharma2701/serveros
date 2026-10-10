import { fail, mockApi, ok } from '../../test/api-mock';
import { DASHBOARD, INDIRANAGAR, KORAMANGALA, MANAGER, OWNER, TOKENS } from '../../test/fixtures';
import { fireEvent, renderApp, resetClient, screen, seedSession, signIn, waitFor } from '../../test/render-app';
import { OUTLET_KEY, REFRESH_KEY, secureStoreData } from '../../test/secure-store';

beforeEach(resetClient);

describe('authentication', () => {
  it('signs in, stores the refresh token only in SecureStore and shows the app', async () => {
    const server = mockApi({
      'POST /auth/login': () => ok(TOKENS),
      'GET /auth/me': () => ok(MANAGER),
      'GET /reports/dashboard': () => ok(DASHBOARD),
    });
    await renderApp();

    await signIn('Manager@SaffronTable.test', 'correct horse battery');

    // The app (dashboard tab) replaces the login screen.
    await waitFor(() => expect(screen.getByTestId('stat-net-sales')).toBeTruthy());
    expect(screen.queryByTestId('login-submit')).toBeNull();

    expect(server.callsTo('POST /auth/login')[0]!.body).toEqual({ email: 'manager@saffrontable.test', password: 'correct horse battery', client: 'mobile' });
    expect(secureStoreData.get(REFRESH_KEY)).toBe('refresh-1');
    // The short-lived access token is never persisted.
    expect([...secureStoreData.values()]).not.toContain('access-1');
    expect(server.callsTo('GET /auth/me')[0]!.headers.Authorization).toBe('Bearer access-1');
  });

  it('shows the server message when the credentials are wrong and stays on the login screen', async () => {
    mockApi({ 'POST /auth/login': () => fail(401, 'UNAUTHENTICATED', 'Incorrect email or password') });
    await renderApp();

    await signIn('owner@saffrontable.test', 'wrong');

    await waitFor(() => expect(screen.getByText('Incorrect email or password')).toBeTruthy());
    expect(screen.getByTestId('login-submit')).toBeTruthy();
    expect(secureStoreData.has(REFRESH_KEY)).toBe(false);
  });

  it('validates the form before calling the server', async () => {
    const server = mockApi({});
    await renderApp();

    await signIn('not-an-email', '');

    await waitFor(() => expect(screen.getByText('Enter a valid email address')).toBeTruthy());
    expect(screen.getByText('Enter your password')).toBeTruthy();
    expect(server.calls).toHaveLength(0);
  });

  it('resumes a stored session without showing the login screen', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    const server = mockApi({
      'POST /auth/refresh': () => ok({ accessToken: 'access-2', expiresIn: 900, refreshToken: 'refresh-rotated' }),
      'GET /auth/me': () => ok(MANAGER),
      'GET /reports/dashboard': () => ok(DASHBOARD),
    });
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('stat-net-sales')).toBeTruthy());
    expect(server.callsTo('POST /auth/login')).toHaveLength(0);
    expect(server.callsTo('POST /auth/refresh')[0]!.body).toEqual({ refreshToken: 'refresh-stored' });
    expect(secureStoreData.get(REFRESH_KEY)).toBe('refresh-rotated');
  });

  it('refreshes and retries when the access token has expired, without the user noticing', async () => {
    seedSession('refresh-stored', INDIRANAGAR.id);
    let refreshes = 0;
    const server = mockApi({
      'POST /auth/refresh': () => {
        refreshes += 1;
        return ok({ accessToken: `access-${refreshes}`, expiresIn: 900, refreshToken: `refresh-${refreshes}` });
      },
      'GET /auth/me': () => ok(MANAGER),
      // The token issued at start-up has "expired" by the time the dashboard loads.
      'GET /reports/dashboard': (req) => (req.headers.Authorization === 'Bearer access-2' ? ok(DASHBOARD) : fail(401, 'UNAUTHENTICATED', 'Token expired')),
    });
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('stat-net-sales')).toBeTruthy());
    expect(refreshes).toBe(2);
    expect(server.callsTo('GET /reports/dashboard').map((c) => c.headers.Authorization)).toEqual(['Bearer access-1', 'Bearer access-2']);
    expect(secureStoreData.get(REFRESH_KEY)).toBe('refresh-2');
    expect(screen.queryByTestId('login-submit')).toBeNull();
  });

  it('returns to the login screen when the stored session is no longer valid', async () => {
    seedSession('refresh-revoked', INDIRANAGAR.id);
    mockApi({ 'POST /auth/refresh': () => fail(401, 'UNAUTHENTICATED', 'Not authenticated') });
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('login-submit')).toBeTruthy());
    expect(secureStoreData.has(REFRESH_KEY)).toBe(false);
  });
});

describe('outlet selection', () => {
  it('asks a multi-outlet owner to choose, then scopes requests to that outlet and remembers it', async () => {
    const server = mockApi({
      'POST /auth/login': () => ok(TOKENS),
      'GET /auth/me': () => ok(OWNER),
      'GET /reports/dashboard': () => ok(DASHBOARD),
    });
    await renderApp();
    await signIn('owner@saffrontable.test', 'correct horse battery');

    // Restaurant shown for context, both outlets offered, no data requested yet.
    await waitFor(() => expect(screen.getByText('Saffron Table')).toBeTruthy());
    expect(screen.getByTestId('outlet-BLR1')).toBeTruthy();
    expect(screen.getByTestId('outlet-BLR2')).toBeTruthy();
    expect(server.callsTo('GET /reports/dashboard')).toHaveLength(0);

    await fireEvent.press(screen.getByTestId('outlet-BLR2'));

    await waitFor(() => expect(screen.getByTestId('stat-net-sales')).toBeTruthy());
    expect(secureStoreData.get(OUTLET_KEY)).toBe(KORAMANGALA.id);
    expect(server.callsTo('GET /reports/dashboard')[0]!.query.outletIds).toBe(KORAMANGALA.id);
  });

  it('skips the selector for someone assigned to a single outlet', async () => {
    seedSession();
    const server = mockApi({
      'POST /auth/refresh': () => ok(TOKENS),
      'GET /auth/me': () => ok(MANAGER),
      'GET /reports/dashboard': () => ok(DASHBOARD),
    });
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('stat-net-sales')).toBeTruthy());
    expect(screen.queryByTestId('outlet-BLR1')).toBeNull();
    expect(server.callsTo('GET /reports/dashboard')[0]!.query.outletIds).toBe(INDIRANAGAR.id);
  });

  it('ignores a remembered outlet the user is no longer assigned to', async () => {
    seedSession('refresh-stored', 'outlet-that-was-removed');
    mockApi({ 'POST /auth/refresh': () => ok(TOKENS), 'GET /auth/me': () => ok(OWNER) });
    await renderApp();

    await waitFor(() => expect(screen.getByTestId('outlet-BLR1')).toBeTruthy());
  });
});
