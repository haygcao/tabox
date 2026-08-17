import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import { validateUrlsRequest, checkUrls, MAX_URLS_PER_REQUEST, MAX_URL_CHARS } from '../src/urlValidator.js';

const makeKV = (store = {}) => ({
  get: vi.fn(async (k) => (k in store ? String(store[k]) : null)),
  put: vi.fn(async (k, v) => { store[k] = v; }),
});
const env = (kvStore = {}, extra = {}) => ({
  GOOGLE_CLIENT_ID: 'cid',
  JWT_SECRET: 's',
  ENTITLEMENTS: makeKV(kvStore),
  ...extra,
});

// authenticate() calls Google tokeninfo then drive/about; anything else is a
// site probe — answered from the `sites` map (url -> status) or 200.
function mockFetch({ identities = { 't-user': { googleId: 'g-user', email: 'u@x.com' } }, sites = {} } = {}) {
  const calls = { probes: [] };
  globalThis.fetch = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes('tokeninfo') || u.includes('googleapis.com')) {
      const token = u.includes('tokeninfo')
        ? new URL(u).searchParams.get('access_token')
        : (opts?.headers?.Authorization || '').replace('Bearer ', '');
      const id = identities[token];
      if (!id) return { ok: false };
      if (u.includes('tokeninfo')) return { ok: true, json: async () => ({ aud: 'cid' }) };
      return { ok: true, json: async () => ({ user: { permissionId: id.googleId, emailAddress: id.email } }) };
    }
    calls.probes.push({ url: u, opts });
    const status = sites[u] ?? 200;
    return { ok: status < 400, status, body: { cancel: vi.fn(async () => {}) } };
  });
  return calls;
}

const req = (token, body) => new Request('https://api/ai/validate-urls', {
  method: 'POST',
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body),
});

// Validation is Pro-only, like /ai/complete.
const PRO_KV = () => ({ 'ent:g-user': JSON.stringify({ status: 'active', plan: 'annual' }) });

describe('POST /ai/validate-urls (route)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('rejects unauthenticated callers with 401', async () => {
    const calls = mockFetch();
    const res = await worker.fetch(req('t-bad', { urls: ['https://example.com'] }), env(PRO_KV()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
    expect(calls.probes).toHaveLength(0);
  });

  it('rejects signed-in users without a Pro entitlement with 403, consuming no quota', async () => {
    const calls = mockFetch();
    const e = env();
    const res = await worker.fetch(req('t-user', { urls: ['https://example.com'] }), e);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'pro_required' });
    expect(calls.probes).toHaveLength(0);
    expect(e.ENTITLEMENTS.put.mock.calls.filter(([k]) => k.startsWith('rl:'))).toHaveLength(0);
  });

  it('rejects malformed bodies (missing/empty/oversized list, bad entries) with 400', async () => {
    const calls = mockFetch();
    for (const bad of [
      {},
      { urls: [] },
      { urls: 'https://example.com' },
      { urls: Array.from({ length: MAX_URLS_PER_REQUEST + 1 }, (_, i) => `https://site${i}.com`) },
      { urls: ['ftp://files.example.com'] },
      { urls: ['not a url'] },
      { urls: [42] },
      { urls: [`https://example.com/${'x'.repeat(MAX_URL_CHARS)}`] },
    ]) {
      const res = await worker.fetch(req('t-user', bad), env(PRO_KV()));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_urls' });
    }
    expect(calls.probes).toHaveLength(0);
  });

  it('rate-limits per user on its own ai-validate bucket (30/min)', async () => {
    mockFetch();
    const e = env(PRO_KV());
    let lastStatus = 200;
    for (let i = 0; i < 31; i++) {
      lastStatus = (await worker.fetch(req('t-user', { urls: ['https://example.com'] }), e)).status;
    }
    expect(lastStatus).toBe(429);
    const buckets = e.ENTITLEMENTS.put.mock.calls.map(([k]) => k).filter((k) => k.startsWith('rl:'));
    expect(buckets.every((k) => k.includes(':ai-validate:'))).toBe(true);
  });

  it('probes each url and returns per-url verdicts', async () => {
    const calls = mockFetch({ sites: { 'https://good.com/': 200, 'https://gone.com/': 404 } });
    const res = await worker.fetch(
      req('t-user', { urls: ['https://good.com/', 'https://gone.com/'] }),
      env(PRO_KV()),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { url: 'https://good.com/', ok: true, status: 200 },
        { url: 'https://gone.com/', ok: false, status: 404 },
      ],
    });
    expect(calls.probes).toHaveLength(2);
    expect(calls.probes[0].opts.method).toBe('HEAD');
    expect(calls.probes[0].opts.redirect).toBe('follow');
    expect(calls.probes[0].opts.headers['User-Agent']).toMatch(/^Mozilla\/5\.0/);
  });
});

describe('validateUrlsRequest', () => {
  it('accepts 1..20 valid http(s) urls and copies the list', () => {
    const urls = ['https://a.com', 'http://b.com/path?q=1'];
    const out = validateUrlsRequest({ urls });
    expect(out).toEqual({ ok: true, urls });
    expect(out.urls).not.toBe(urls);
  });

  it('rejects non-object bodies', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(validateUrlsRequest(bad)).toEqual({ ok: false, error: 'invalid_urls' });
    }
  });
});

// ---------------------------------------------------------------------------
// checkUrls verdict table (fetchImpl injected — no network, no route)
// ---------------------------------------------------------------------------

const resp = (status) => ({ status, body: { cancel: vi.fn(async () => {}) } });

describe('checkUrls verdicts', () => {
  it('status < 400 → ok:true', async () => {
    const fetchImpl = vi.fn(async () => resp(204));
    expect(await checkUrls(['https://a.com'], fetchImpl)).toEqual([
      { url: 'https://a.com', ok: true, status: 204 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].method).toBe('HEAD');
  });

  it('auth walls / bot blockers (401, 403, 429) → ok:true', async () => {
    for (const status of [401, 403, 429]) {
      const fetchImpl = vi.fn(async () => resp(status));
      expect(await checkUrls(['https://a.com'], fetchImpl)).toEqual([
        { url: 'https://a.com', ok: true, status },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // no GET retry for these
    }
  });

  it('other >= 400 (404, 410, 500) → ok:false', async () => {
    for (const status of [404, 410, 500]) {
      const fetchImpl = vi.fn(async () => resp(status));
      expect(await checkUrls(['https://a.com'], fetchImpl)).toEqual([
        { url: 'https://a.com', ok: false, status },
      ]);
    }
  });

  it('HEAD 405 retries once as GET and cancels the body; GET verdict wins', async () => {
    const getBody = { cancel: vi.fn(async () => {}) };
    const fetchImpl = vi.fn(async (url, opts) => (
      opts.method === 'HEAD' ? resp(405) : { status: 200, body: getBody }
    ));
    expect(await checkUrls(['https://a.com'], fetchImpl)).toEqual([
      { url: 'https://a.com', ok: true, status: 200 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].method).toBe('GET');
    expect(getBody.cancel).toHaveBeenCalledTimes(1);
  });

  it('HEAD 501 retries as GET; a GET 404 is a hard fail', async () => {
    const fetchImpl = vi.fn(async (url, opts) => (opts.method === 'HEAD' ? resp(501) : resp(404)));
    expect(await checkUrls(['https://a.com'], fetchImpl)).toEqual([
      { url: 'https://a.com', ok: false, status: 404 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('405 even after the GET retry → ok:true (method-blocked, not dead)', async () => {
    const fetchImpl = vi.fn(async () => resp(405));
    expect(await checkUrls(['https://a.com'], fetchImpl)).toEqual([
      { url: 'https://a.com', ok: true, status: 405 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // HEAD then GET
  });

  it('a GET body without cancel() does not break the verdict', async () => {
    const fetchImpl = vi.fn(async (url, opts) => (
      opts.method === 'HEAD' ? resp(405) : { status: 200, body: null }
    ));
    expect(await checkUrls(['https://a.com'], fetchImpl)).toEqual([
      { url: 'https://a.com', ok: true, status: 200 },
    ]);
  });

  it('timeout (our 5s abort fired) → ok:true, status -1 (slow ≠ dead)', async () => {
    vi.useFakeTimers();
    try {
      // Rejects with an AbortError-named error only when OUR signal fires.
      const fetchImpl = vi.fn((url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }));
      const pending = checkUrls(['https://slow.com'], fetchImpl);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toEqual([{ url: 'https://slow.com', ok: true, status: -1 }]);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // no GET retry after a timeout
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-timeout fetch error (DNS/conn refused/TLS) → ok:false, status 0', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed: NXDOMAIN'); });
    expect(await checkUrls(['https://no-such-host.example'], fetchImpl)).toEqual([
      { url: 'https://no-such-host.example', ok: false, status: 0 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('checks every url and preserves input order', async () => {
    const fetchImpl = vi.fn(async (url) => (String(url).includes('gone') ? resp(404) : resp(200)));
    const out = await checkUrls(['https://a.com', 'https://gone.com', 'https://b.com'], fetchImpl);
    expect(out.map((r) => r.url)).toEqual(['https://a.com', 'https://gone.com', 'https://b.com']);
    expect(out.map((r) => r.ok)).toEqual([true, false, true]);
  });
});
