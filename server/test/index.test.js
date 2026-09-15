import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index.js';

const makeKV = (store = {}) => ({
  get: vi.fn(async (k) => (k in store ? JSON.stringify(store[k]) : null)),
  put: vi.fn(async (k, v) => { store[k] = JSON.parse(v); }),
  delete: vi.fn(async (k) => { delete store[k]; }),
  _store: store,
});

const ENV_BASE = {
  GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  PRICE_MONTHLY: 'pri_m', PRICE_ANNUAL: 'pri_a',
  PADDLE_WEBHOOK_SECRET: 'whsec_test', JWT_SECRET: 'jwt_secret',
};

const okJson = (body) => ({ ok: true, json: async () => body });
function mockGoogleOk() {
  globalThis.fetch = vi.fn()
    .mockResolvedValueOnce(okJson({ aud: ENV_BASE.GOOGLE_CLIENT_ID }))
    .mockResolvedValueOnce(okJson({ user: { permissionId: 'g-123', emailAddress: 'a@b.c' } }));
}

async function signWebhook(body, secret, ts) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}:${body}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('GET /entitlement', () => {
  it('401s without a bearer token', async () => {
    const res = await worker.fetch(new Request('https://x/entitlement'), { ...ENV_BASE, ENTITLEMENTS: makeKV() });
    expect(res.status).toBe(401);
  });

  it('returns entitled=false with no KV record', async () => {
    mockGoogleOk();
    const res = await worker.fetch(
      new Request('https://x/entitlement', { headers: { Authorization: 'Bearer tok' } }),
      { ...ENV_BASE, ENTITLEMENTS: makeKV() }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = await res.json();
    expect(body.entitled).toBe(false);
    expect(body.token).toBeNull();
  });

  it('returns entitled record with signed token for active subscriber', async () => {
    mockGoogleOk();
    const kv = makeKV({ 'ent:g-123': { status: 'active', plan: 'monthly', current_period_end: '2099-01-01T00:00:00Z' } });
    const res = await worker.fetch(
      new Request('https://x/entitlement', { headers: { Authorization: 'Bearer tok' } }),
      { ...ENV_BASE, ENTITLEMENTS: kv }
    );
    const body = await res.json();
    expect(body).toMatchObject({ entitled: true, status: 'active', plan: 'monthly', expiresAt: '2099-01-01T00:00:00Z' });
    expect(body.token.split('.')).toHaveLength(3);
    expect(typeof body.checkedAt).toBe('string');
  });

  it('returns entitled=false (not a 500) for a corrupt KV record', async () => {
    mockGoogleOk();
    const kv = { get: vi.fn(async () => 'corrupt{{'), put: vi.fn() };
    const res = await worker.fetch(
      new Request('https://x/entitlement', { headers: { Authorization: 'Bearer tok' } }),
      { ...ENV_BASE, ENTITLEMENTS: kv }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entitled).toBe(false);
    expect(body.token).toBeNull();
  });
});

describe('POST /webhooks/paddle', () => {
  // Paddle subscription webhooks do NOT carry the checkout's custom_data, so the
  // subscription event alone cannot identify the Google user. googleId arrives on
  // a separate transaction.* event; entitlement resolves once both are seen, in
  // either order.
  const subEvent = {
    event_id: 'evt_1', event_type: 'subscription.created', occurred_at: '2026-07-16T10:00:00Z',
    data: {
      id: 'sub_1', status: 'trialing', customer_id: 'ctm_1',
      current_billing_period: { ends_at: '2026-07-23T10:00:00Z' },
      items: [{ price: { id: 'pri_m' } }],
    },
  };
  const txnEvent = {
    event_id: 'evt_2', event_type: 'transaction.completed', occurred_at: '2026-07-16T10:00:01Z',
    data: { id: 'txn_1', subscription_id: 'sub_1', custom_data: { googleId: 'g-123' } },
  };

  async function post(event, kv) {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const h1 = await signWebhook(body, ENV_BASE.PADDLE_WEBHOOK_SECRET, ts);
    return worker.fetch(
      new Request('https://x/webhooks/paddle', { method: 'POST', body, headers: { 'Paddle-Signature': `ts=${ts};h1=${h1}` } }),
      { ...ENV_BASE, ENTITLEMENTS: kv }
    );
  }

  it('401s on bad signature', async () => {
    const res = await worker.fetch(
      new Request('https://x/webhooks/paddle', { method: 'POST', body: JSON.stringify(subEvent), headers: { 'Paddle-Signature': 'ts=1;h1=bad' } }),
      { ...ENV_BASE, ENTITLEMENTS: makeKV() }
    );
    expect(res.status).toBe(401);
  });

  it('does not grant entitlement from a subscription event alone (no googleId yet)', async () => {
    const kv = makeKV();
    const res = await post(subEvent, kv);
    expect(res.status).toBe(200);
    expect(kv._store['ent:g-123']).toBeUndefined();
  });

  it('resolves entitlement when the transaction event arrives after the subscription event', async () => {
    const kv = makeKV();
    await post(subEvent, kv);      // stashed, pending googleId
    await post(txnEvent, kv);      // supplies googleId -> flush
    expect(kv._store['ent:g-123']).toMatchObject({ status: 'trialing', plan: 'monthly', subscription_id: 'sub_1' });
  });

  it('deletes the parked subpending record once the linking transaction flushes it', async () => {
    const kv = makeKV();
    await post(subEvent, kv);
    expect(kv._store['subpending:sub_1']).toBeDefined();
    await post(txnEvent, kv);
    expect(kv._store['ent:g-123']).toMatchObject({ status: 'trialing', subscription_id: 'sub_1' });
    expect(kv._store['subpending:sub_1']).toBeUndefined();
    expect(kv.delete).toHaveBeenCalledWith('subpending:sub_1');
  });

  it('parks subpending records with an expiration TTL so orphans cannot accumulate forever', async () => {
    const kv = makeKV();
    await post(subEvent, kv);
    expect(kv.put).toHaveBeenCalledWith(
      'subpending:sub_1',
      expect.any(String),
      expect.objectContaining({ expirationTtl: expect.any(Number) })
    );
  });

  it('resolves entitlement when the transaction event arrives before the subscription event', async () => {
    const kv = makeKV();
    await post(txnEvent, kv);      // maps sub_1 -> g-123
    await post(subEvent, kv);      // map exists -> apply directly
    expect(kv._store['ent:g-123']).toMatchObject({ status: 'trialing', plan: 'monthly', subscription_id: 'sub_1' });
  });

  it('applies later subscription lifecycle events (e.g. cancellation) once linked', async () => {
    const kv = makeKV();
    await post(txnEvent, kv);
    await post(subEvent, kv);
    const canceled = {
      event_id: 'evt_3', event_type: 'subscription.canceled', occurred_at: '2026-07-20T10:00:00Z',
      data: { id: 'sub_1', status: 'canceled', customer_id: 'ctm_1', items: [{ price: { id: 'pri_m' } }] },
    };
    await post(canceled, kv);
    expect(kv._store['ent:g-123'].status).toBe('canceled');
  });

  it('returns 200 without writing KV for a validly-signed malformed body', async () => {
    const body = 'not-json{{';
    const ts = Math.floor(Date.now() / 1000);
    const h1 = await signWebhook(body, ENV_BASE.PADDLE_WEBHOOK_SECRET, ts);
    const kv = makeKV();
    const res = await worker.fetch(
      new Request('https://x/webhooks/paddle', { method: 'POST', body, headers: { 'Paddle-Signature': `ts=${ts};h1=${h1}` } }),
      { ...ENV_BASE, ENTITLEMENTS: kv }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('ignores stale out-of-order events for an already-linked subscription', async () => {
    const stale = { ...subEvent, occurred_at: '2026-07-16T08:00:00Z' };
    const kv = makeKV({
      'map:sub_1': { googleId: 'g-123' },
      'ent:g-123': { status: 'active', occurred_at: '2026-07-16T09:00:00Z' },
    });
    const res = await post(stale, kv);
    expect(res.status).toBe(200);
    expect(kv._store['ent:g-123'].status).toBe('active');
  });
});

describe('CORS preflight', () => {
  it('answers OPTIONS with 204 and the headers a Bearer GET needs', async () => {
    const res = await worker.fetch(
      new Request('https://x/entitlement', { method: 'OPTIONS' }),
      { ...ENV_BASE, ENTITLEMENTS: makeKV() }
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

describe('unknown route', () => {
  it('404s', async () => {
    const res = await worker.fetch(new Request('https://x/nope'), { ...ENV_BASE, ENTITLEMENTS: makeKV() });
    expect(res.status).toBe(404);
  });
});

describe('GET /checkout/eligibility', () => {
  const req = (uid) => new Request(`https://x/checkout/eligibility?uid=${uid}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } });

  it('is eligible when no record exists', async () => {
    const res = await worker.fetch(req('10544073283925911319'), { ...ENV_BASE, ENTITLEMENTS: makeKV() });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({ trial_eligible: true });
  });

  it('is ineligible once the googleId ever held a real subscription (canceled included)', async () => {
    const kv = makeKV({ 'ent:10544073283925911319': { status: 'canceled', plan: 'annual', subscription_id: 'sub_1', customer_id: 'ctm_1' } });
    const res = await worker.fetch(req('10544073283925911319'), { ...ENV_BASE, ENTITLEMENTS: kv });
    expect(await res.json()).toEqual({ trial_eligible: false });
  });

  it('stays eligible for a comp grant (no subscription_id)', async () => {
    const kv = makeKV({ 'ent:10544073283925911319': { status: 'active', plan: 'annual', subscription_id: null } });
    const res = await worker.fetch(req('10544073283925911319'), { ...ENV_BASE, ENTITLEMENTS: kv });
    expect(await res.json()).toEqual({ trial_eligible: true });
  });

  it('treats a malformed uid as eligible without touching KV', async () => {
    const kv = makeKV();
    const res = await worker.fetch(req('not-a-google-id'), { ...ENV_BASE, ENTITLEMENTS: kv });
    expect(await res.json()).toEqual({ trial_eligible: true });
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('rate limits per IP after 30 requests in the window', async () => {
    const kv = makeKV();
    let last;
    for (let i = 0; i < 31; i++) last = await worker.fetch(req('10544073283925911319'), { ...ENV_BASE, ENTITLEMENTS: kv });
    expect(last.status).toBe(429);
  });
});

describe('POST /webhooks/paddle — concurrent delivery (KV read-after-write race)', () => {
  // Paddle delivers subscription.* and transaction.* for the same checkout within
  // milliseconds of each other. Cloudflare KV gives no read-after-write guarantee,
  // so each handler can read the store as it was *before* the other's put landed:
  // the transaction parks map: and sees no subpending:, the subscription parks
  // subpending: and sees no map:, and nothing ever performs the join.
  // This stranded a live trialing subscriber (sub_01m1ffc71ajh3f001bzdq9mkjq).
  const subEvent = {
    event_id: 'evt_1', event_type: 'subscription.created', occurred_at: '2026-07-16T10:00:00Z',
    data: {
      id: 'sub_1', status: 'trialing', customer_id: 'ctm_1',
      current_billing_period: { ends_at: '2099-07-23T10:00:00Z' },
      items: [{ price: { id: 'pri_m' } }],
    },
  };
  const txnEvent = {
    event_id: 'evt_2', event_type: 'transaction.completed', occurred_at: '2026-07-16T10:00:01Z',
    data: { id: 'txn_1', subscription_id: 'sub_1', custom_data: { googleId: 'g-123' } },
  };

  // KV where a put is durable but invisible to reads until settle() — the
  // consistency window that caused the incident.
  const makeLaggyKV = (store = {}) => {
    let visible = { ...store };
    return {
      get: vi.fn(async (k) => (k in visible ? JSON.stringify(visible[k]) : null)),
      put: vi.fn(async (k, v) => { store[k] = JSON.parse(v); }),
      delete: vi.fn(async (k) => { delete store[k]; delete visible[k]; }),
      settle: () => { visible = { ...store }; },
      _store: store,
    };
  };

  async function post(event, kv) {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const h1 = await signWebhook(body, ENV_BASE.PADDLE_WEBHOOK_SECRET, ts);
    return worker.fetch(
      new Request('https://x/webhooks/paddle', { method: 'POST', body, headers: { 'Paddle-Signature': `ts=${ts};h1=${h1}` } }),
      { ...ENV_BASE, ENTITLEMENTS: kv }
    );
  }

  it('flushes the parked record when the transaction link becomes visible after the first stale read', async () => {
    const kv = makeKV({ 'map:sub_1': { googleId: 'g-123' } });
    const fresh = kv.get;
    let mapReads = 0;
    kv.get = vi.fn(async (k) => (k === 'map:sub_1' && mapReads++ === 0 ? null : fresh(k)));

    const res = await post(subEvent, kv);

    expect(res.status).toBe(200);
    expect(kv._store['ent:g-123']).toMatchObject({ status: 'trialing', plan: 'monthly', subscription_id: 'sub_1' });
  });

  it('leaves no orphaned subpending record after that late flush', async () => {
    const kv = makeKV({ 'map:sub_1': { googleId: 'g-123' } });
    const fresh = kv.get;
    let mapReads = 0;
    kv.get = vi.fn(async (k) => (k === 'map:sub_1' && mapReads++ === 0 ? null : fresh(k)));

    await post(subEvent, kv);

    expect(kv._store['subpending:sub_1']).toBeUndefined();
  });

  it('self-heals on the next entitlement read when both writes raced and nothing joined them', async () => {
    const kv = makeLaggyKV();
    await Promise.all([post(subEvent, kv), post(txnEvent, kv)]);
    kv.settle();
    // Precondition: the race really did strand the subscriber.
    expect(kv._store['ent:g-123']).toBeUndefined();

    mockGoogleOk();
    const res = await worker.fetch(
      new Request('https://x/entitlement', { headers: { Authorization: 'Bearer tok' } }),
      { ...ENV_BASE, ENTITLEMENTS: kv }
    );

    expect(await res.json()).toMatchObject({ entitled: true, status: 'trialing', plan: 'monthly' });
  });

  it('persists the healed record so the next read needs no reconciliation', async () => {
    const kv = makeLaggyKV();
    await Promise.all([post(subEvent, kv), post(txnEvent, kv)]);
    kv.settle();

    mockGoogleOk();
    await worker.fetch(
      new Request('https://x/entitlement', { headers: { Authorization: 'Bearer tok' } }),
      { ...ENV_BASE, ENTITLEMENTS: kv }
    );

    expect(kv._store['ent:g-123']).toMatchObject({ status: 'trialing', subscription_id: 'sub_1' });
    expect(kv._store['subpending:sub_1']).toBeUndefined();
  });
});
