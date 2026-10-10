import { fail, mockApi, networkDown, ok } from '../../test/api-mock';
import { REFRESH_KEY, secureStoreData } from '../../test/secure-store';
import { api, ApiError, errorMessage, getAccessToken, onSessionExpired, setAccessToken, setApiOutlet } from '../lib/api';

beforeEach(() => {
  setAccessToken(null);
  setApiOutlet(null);
  onSessionExpired(null);
});

describe('api client', () => {
  it('sends the bearer token and the selected outlet header', async () => {
    setAccessToken('access-1');
    setApiOutlet('outlet-1');
    const server = mockApi({ 'GET /orders': () => ok({ items: [] }) });

    await api('/orders', { query: { status: 'CONFIRMED,READY', page: 1, empty: '' } });

    const call = server.calls[0]!;
    expect(call.headers.Authorization).toBe('Bearer access-1');
    expect(call.headers['X-Outlet-Id']).toBe('outlet-1');
    expect(call.query).toEqual({ status: 'CONFIRMED,READY', page: '1' });
  });

  it('refreshes an expired access token once, saves the rotated refresh token and retries', async () => {
    setAccessToken('expired');
    secureStoreData.set(REFRESH_KEY, 'refresh-old');
    const server = mockApi({
      'GET /auth/me': (req) => (req.headers.Authorization === 'Bearer access-new' ? ok({ user: { name: 'Meera' } }) : fail(401, 'UNAUTHENTICATED', 'Token expired')),
      'POST /auth/refresh': () => ok({ accessToken: 'access-new', expiresIn: 900, refreshToken: 'refresh-new' }),
    });

    const me = await api<{ user: { name: string } }>('/auth/me');

    expect(me.user.name).toBe('Meera');
    expect(server.callsTo('POST /auth/refresh')).toHaveLength(1);
    expect(server.callsTo('POST /auth/refresh')[0]!.body).toEqual({ refreshToken: 'refresh-old' });
    expect(server.callsTo('GET /auth/me')).toHaveLength(2);
    expect(secureStoreData.get(REFRESH_KEY)).toBe('refresh-new');
    expect(getAccessToken()).toBe('access-new');
  });

  it('shares one refresh between requests that fail at the same time (single-flight)', async () => {
    setAccessToken('expired');
    secureStoreData.set(REFRESH_KEY, 'refresh-old');
    const server = mockApi({
      'GET /a': (req) => (req.headers.Authorization === 'Bearer access-new' ? ok({ a: 1 }) : fail(401, 'UNAUTHENTICATED', 'Token expired')),
      'GET /b': (req) => (req.headers.Authorization === 'Bearer access-new' ? ok({ b: 2 }) : fail(401, 'UNAUTHENTICATED', 'Token expired')),
      'POST /auth/refresh': (req) =>
        // A rotated token only works once: a second refresh with the old token would be rejected.
        req.body.refreshToken === 'refresh-old' && server.callsTo('POST /auth/refresh').length === 1 ? ok({ accessToken: 'access-new', expiresIn: 900, refreshToken: 'refresh-new' }) : fail(401, 'UNAUTHENTICATED', 'Not authenticated'),
    });

    const [a, b] = await Promise.all([api('/a'), api('/b')]);

    expect(a).toEqual({ a: 1 });
    expect(b).toEqual({ b: 2 });
    expect(server.callsTo('POST /auth/refresh')).toHaveLength(1);
  });

  it('signs the user out when the refresh token is rejected', async () => {
    setAccessToken('expired');
    secureStoreData.set(REFRESH_KEY, 'refresh-revoked');
    const signedOut = jest.fn();
    onSessionExpired(signedOut);
    mockApi({
      'GET /auth/me': () => fail(401, 'UNAUTHENTICATED', 'Not authenticated'),
      'POST /auth/refresh': () => fail(401, 'UNAUTHENTICATED', 'Not authenticated'),
    });

    await expect(api('/auth/me')).rejects.toMatchObject({ status: 401, message: 'Not authenticated' });

    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(secureStoreData.has(REFRESH_KEY)).toBe(false);
    expect(getAccessToken()).toBeNull();
  });

  it('keeps the session when the refresh cannot reach the server', async () => {
    setAccessToken('expired');
    secureStoreData.set(REFRESH_KEY, 'refresh-old');
    const signedOut = jest.fn();
    onSessionExpired(signedOut);
    mockApi({ 'GET /auth/me': () => fail(401, 'UNAUTHENTICATED', 'Token expired'), 'POST /auth/refresh': networkDown });

    await expect(api('/auth/me')).rejects.toMatchObject({ code: 'NETWORK' });

    expect(signedOut).not.toHaveBeenCalled();
    expect(secureStoreData.get(REFRESH_KEY)).toBe('refresh-old');
  });

  it('does not try to refresh when the login itself is rejected', async () => {
    const server = mockApi({ 'POST /auth/login': () => fail(401, 'UNAUTHENTICATED', 'Incorrect email or password') });

    await expect(api('/auth/login', { method: 'POST', body: { email: 'a@b.c', password: 'x', client: 'mobile' } })).rejects.toMatchObject({ message: 'Incorrect email or password' });

    expect(server.calls).toHaveLength(1);
  });

  it('turns a network failure into an ApiError with code NETWORK', async () => {
    mockApi({ 'GET /orders': networkDown });

    const error = await api('/orders').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isNetwork).toBe(true);
    expect(errorMessage(error)).toMatch(/cannot reach the server/i);
  });

  it('surfaces the server message, code and correlation id of a 403', async () => {
    setAccessToken('access-1');
    mockApi({ 'GET /reports/dashboard': () => fail(403, 'FORBIDDEN', 'You do not have permission to do this') });

    const error = (await api('/reports/dashboard').catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.correlationId).toBe('test-correlation');
    expect(errorMessage(error)).toBe('You do not have permission to do this');
  });

  it('returns undefined for 204 responses', async () => {
    mockApi({ 'POST /auth/logout': () => ok() });
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});
