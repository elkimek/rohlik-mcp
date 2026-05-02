/**
 * Tests for RohlikAPI's HTTP-layer behavior:
 *   - cookie jar parsing/rebuild
 *   - concurrent ensureLoggedIn lock
 *   - 401 → re-login → retry once
 *   - error body capture on retry failure
 *   - addToCart per-product failure surfacing
 *   - login success heuristic rejects status === undefined
 *
 * node-fetch is replaced by a vi.fn so we can script responses and inspect
 * exactly which URLs were hit and what headers we sent.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.mock('node-fetch', () => ({ default: (...args: unknown[]) => mockFetch(...args) }));

import { RohlikAPI, RohlikAPIError } from '../src/rohlik-api.js';

interface FakeResponseOpts {
  status?: number;
  body?: unknown;
  setCookie?: string[];
  bodyText?: string;
}

function fakeResponse(opts: FakeResponseOpts = {}): unknown {
  const status = opts.status ?? 200;
  const body = opts.body ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 401 ? 'Unauthorized' : status === 500 ? 'Server Error' : 'Status',
    headers: {
      get: (_name: string) => null,
      getSetCookie: () => opts.setCookie ?? [],
    },
    json: async () => body,
    text: async () => opts.bodyText ?? (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const successfulLogin = (setCookie?: string[]) =>
  fakeResponse({
    status: 200,
    body: { status: 200, data: { user: { id: 42 }, address: { id: 7 } } },
    setCookie,
  });

const successfulCart = () =>
  fakeResponse({
    status: 200,
    body: { status: 200, data: { items: {}, totalPrice: 0, submitConditionPassed: true } },
  });

function fetchCalls() {
  return mockFetch.mock.calls.map((c) => ({
    url: c[0] as string,
    headers: ((c[1] as { headers?: Record<string, string> })?.headers) ?? {},
    method: ((c[1] as { method?: string })?.method) ?? 'GET',
  }));
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('RohlikAPI cookie jar', () => {
  it('parses Set-Cookie name=value pairs and replays them as a Cookie: header', async () => {
    mockFetch.mockResolvedValueOnce(successfulLogin(['SESSION=abc; Path=/; HttpOnly', 'CSRF=xyz; Path=/']));
    mockFetch.mockResolvedValueOnce(successfulCart());

    const api = new RohlikAPI({ username: 'u', password: 'p' });
    await api.getCartContent();

    const calls = fetchCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/login');
    expect(calls[1].url).toContain('/cart');
    expect(calls[1].headers.Cookie).toBe('SESSION=abc; CSRF=xyz');
  });

  it('updates a cookie value when the server rotates it', async () => {
    mockFetch.mockResolvedValueOnce(successfulLogin(['SESSION=v1; Path=/']));
    mockFetch.mockResolvedValueOnce(fakeResponse({
      status: 200,
      body: { status: 200, data: { items: {}, totalPrice: 0, submitConditionPassed: true } },
      setCookie: ['SESSION=v2; Path=/'],
    }));
    mockFetch.mockResolvedValueOnce(successfulCart());

    const api = new RohlikAPI({ username: 'u', password: 'p' });
    await api.getCartContent();
    await api.getCartContent();

    const calls = fetchCalls();
    expect(calls[1].headers.Cookie).toBe('SESSION=v1');
    expect(calls[2].headers.Cookie).toBe('SESSION=v2');
  });
});

describe('RohlikAPI concurrent login lock', () => {
  it('shares one login across concurrent calls', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/login')) return successfulLogin(['SESSION=s; Path=/']);
      if (url.includes('/cart')) return successfulCart();
      if (url.includes('/orders/delivered')) {
        return fakeResponse({ status: 200, body: { status: 200, data: [] } });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const api = new RohlikAPI({ username: 'u', password: 'p' });
    await Promise.all([api.getCartContent(), api.getOrderHistory(5)]);

    const loginCalls = mockFetch.mock.calls.filter((c) => (c[0] as string).includes('/login'));
    expect(loginCalls).toHaveLength(1);
  });
});

describe('RohlikAPI 401 retry', () => {
  it('re-logs in and retries once on 401', async () => {
    mockFetch
      .mockResolvedValueOnce(successfulLogin(['SESSION=old; Path=/']))
      .mockResolvedValueOnce(fakeResponse({ status: 401, bodyText: 'expired' }))
      .mockResolvedValueOnce(successfulLogin(['SESSION=new; Path=/']))
      .mockResolvedValueOnce(successfulCart());

    const api = new RohlikAPI({ username: 'u', password: 'p' });
    const cart = await api.getCartContent();
    expect(cart.total_items).toBe(0);

    const calls = fetchCalls();
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toContain('/login');
    expect(calls[1].url).toContain('/cart');
    expect(calls[2].url).toContain('/login');
    expect(calls[3].url).toContain('/cart');
    expect(calls[3].headers.Cookie).toBe('SESSION=new');
  });

  it('throws a RohlikAPIError with the response body when the retry also fails', async () => {
    mockFetch
      .mockResolvedValueOnce(successfulLogin())
      .mockResolvedValueOnce(fakeResponse({ status: 401, bodyText: 'first attempt' }))
      .mockResolvedValueOnce(successfulLogin())
      .mockResolvedValueOnce(fakeResponse({ status: 401, bodyText: 'still expired' }));

    const api = new RohlikAPI({ username: 'u', password: 'p' });
    await expect(api.getCartContent()).rejects.toMatchObject({
      name: 'RohlikAPIError',
      status: 401,
      body: 'still expired',
    });
  });
});

describe('RohlikAPI addToCart', () => {
  it('returns per-product failures alongside successes', async () => {
    mockFetch.mockImplementation(async (url: string, init: { method?: string } = {}) => {
      if (url.includes('/login')) return successfulLogin();
      if (url.includes('/cart') && init.method === 'POST') {
        const callIndex = mockFetch.mock.calls.filter((c) =>
          (c[0] as string).includes('/cart') && ((c[1] as { method?: string })?.method) === 'POST',
        ).length;
        // Second add fails, others succeed
        if (callIndex === 2) return fakeResponse({ status: 500, bodyText: 'item unavailable' });
        return fakeResponse({ status: 200, body: { status: 200 } });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const api = new RohlikAPI({ username: 'u', password: 'p' });
    const result = await api.addToCart([
      { product_id: 1, quantity: 1 },
      { product_id: 2, quantity: 3 },
      { product_id: 3, quantity: 1 },
    ]);

    expect(result.added).toEqual([1, 3]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].productId).toBe(2);
    expect(result.failed[0].reason).toContain('500');
    expect(result.failed[0].reason).toContain('item unavailable');
  });
});

describe('RohlikAPI login success heuristic', () => {
  it('rejects login when the response has no status field', async () => {
    mockFetch.mockResolvedValueOnce(fakeResponse({
      status: 200,
      body: { data: { user: { id: 42 } } },
    }));

    const api = new RohlikAPI({ username: 'u', password: 'p' });
    await expect(api.getCartContent()).rejects.toBeInstanceOf(RohlikAPIError);
  });
});
