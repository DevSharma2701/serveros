/** A tiny fake of the ServeOS API for tests: routes keyed by "METHOD /path" (path after /api/v1, no query). */
export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status: number; body?: unknown };
type Handler = (req: FakeRequest) => Reply | Promise<Reply>;

export const ok = (body?: unknown): Reply => ({ status: body === undefined ? 204 : 200, body });
export const fail = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message, details: null, correlationId: 'test-correlation' } } });

export interface ApiMock {
  calls: FakeRequest[];
  /** Calls made to one route. */
  callsTo(route: string): FakeRequest[];
  /** Replace or add a route while a test is running. */
  on(route: string, handler: Handler): void;
}

export function mockApi(routes: Record<string, Handler>): ApiMock {
  const table = new Map(Object.entries(routes));
  const calls: FakeRequest[] = [];

  globalThis.fetch = jest.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const req: FakeRequest = {
      method: init.method ?? 'GET',
      path: url.pathname.replace(/^\/api\/v1/, ''),
      query: Object.fromEntries(url.searchParams.entries()),
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const handler = table.get(`${req.method} ${req.path}`);
    if (!handler) throw new Error(`Unmocked request: ${req.method} ${req.path}`);
    const reply = await handler(req);
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  }) as unknown as typeof fetch;

  return {
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    on: (route, handler) => void table.set(route, handler),
  };
}

/** A fetch that fails the way a phone with no signal does. */
export const networkDown: Handler = () => {
  throw new TypeError('Network request failed');
};
