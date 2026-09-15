import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import { normalizeAction, recordAIUsage } from '../src/aiUsage.js';
import { makeDB } from './helpers/d1Mock.js';

const makeKV = (store = {}) => ({
  get: vi.fn(async (k) => (k in store ? String(store[k]) : null)),
  put: vi.fn(async (k, v) => { store[k] = v; }),
});
const env = (extra = {}) => ({
  GOOGLE_CLIENT_ID: 'cid',
  JWT_SECRET: 's',
  ENTITLEMENTS: makeKV({ 'ent:g-user': JSON.stringify({ status: 'active', plan: 'annual' }) }),
  OPENROUTER_API_KEY: 'sk-or-secret',
  ...extra,
});

function mockFetch({ upstreamOk = true } = {}) {
  globalThis.fetch = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes('openrouter.ai')) {
      if (!upstreamOk) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":1}' } }] }) };
    }
    const token = u.includes('tokeninfo')
      ? new URL(u).searchParams.get('access_token')
      : (opts?.headers?.Authorization || '').replace('Bearer ', '');
    if (token !== 't-user') return { ok: false };
    if (u.includes('tokeninfo')) return { ok: true, json: async () => ({ aud: 'cid' }) };
    return { ok: true, json: async () => ({ user: { permissionId: 'g-user', emailAddress: 'u@x.com' } }) };
  });
}

const req = (body) => new Request('https://api/ai/complete', {
  method: 'POST',
  headers: { Authorization: 'Bearer t-user' },
  body: JSON.stringify(body),
});
const BODY = { messages: [{ role: 'user', content: 'hello' }] };

// Minimal ExecutionContext: collects waitUntil promises so tests can await them.
function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), flush: () => Promise.all(pending), pending };
}

const rows = (db) => db._raw.prepare('SELECT action, google_id, created_at FROM ai_usage ORDER BY id').all();

describe('normalizeAction', () => {
  it('accepts lowercase slugs and normalizes case/whitespace', () => {
    expect(normalizeAction('summaries')).toBe('summaries');
    expect(normalizeAction('  Auto-Arrange ')).toBe('auto-arrange');
    expect(normalizeAction('task_planner2')).toBe('task_planner2');
  });
  it('collapses anything else to unknown', () => {
    for (const bad of [undefined, null, 42, '', 'has space', 'x'.repeat(41), '-leading', 'émoji', '<script>']) {
      expect(normalizeAction(bad)).toBe('unknown');
    }
  });
});

describe('recordAIUsage', () => {
  it('inserts a row and never stores prompt content', async () => {
    const db = makeDB();
    expect(await recordAIUsage(db, { action: 'summaries', googleId: 'g-1', now: 1700000000000 })).toBe(true);
    expect(rows(db)).toEqual([{ action: 'summaries', google_id: 'g-1', created_at: 1700000000000 }]);
  });
  it('resolves false (never throws) when the binding is missing or the table does not exist', async () => {
    expect(await recordAIUsage(undefined, { action: 'x', googleId: 'g' })).toBe(false);
    const db = makeDB();
    db._raw.exec('DROP TABLE ai_usage');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await recordAIUsage(db, { action: 'x', googleId: 'g' })).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe('POST /ai/complete usage recording', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('records the declared action after a successful completion, via ctx.waitUntil', async () => {
    mockFetch();
    const db = makeDB();
    const ctx = makeCtx();
    const res = await worker.fetch(req({ ...BODY, action: 'auto-arrange' }), env({ SHARED_DB: db }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: '{"ok":1}' });
    expect(ctx.pending).toHaveLength(1);
    await ctx.flush();
    const [row] = rows(db);
    expect(row).toMatchObject({ action: 'auto-arrange', google_id: 'g-user' });
    expect(typeof row.created_at).toBe('number');
  });

  it('old clients that send no action still succeed and are recorded as unknown', async () => {
    mockFetch();
    const db = makeDB();
    const ctx = makeCtx();
    const res = await worker.fetch(req(BODY), env({ SHARED_DB: db }), ctx);
    expect(res.status).toBe(200);
    await ctx.flush();
    expect(rows(db)[0].action).toBe('unknown');
  });

  it('does not forward action upstream and rejects nothing because of it', async () => {
    mockFetch();
    const db = makeDB();
    const ctx = makeCtx();
    const res = await worker.fetch(req({ ...BODY, action: 'WEIRD action!!' }), env({ SHARED_DB: db }), ctx);
    expect(res.status).toBe(200);
    const upstreamCall = globalThis.fetch.mock.calls.find(([u]) => String(u).includes('openrouter.ai'));
    expect(JSON.parse(upstreamCall[1].body)).not.toHaveProperty('action');
    await ctx.flush();
    expect(rows(db)[0].action).toBe('unknown');
  });

  it('does not record failed completions', async () => {
    mockFetch({ upstreamOk: false });
    const db = makeDB();
    const ctx = makeCtx();
    const res = await worker.fetch(req({ ...BODY, action: 'summaries' }), env({ SHARED_DB: db }), ctx);
    expect(res.status).toBe(502);
    await ctx.flush();
    expect(rows(db)).toEqual([]);
  });

  it('still returns the completion when SHARED_DB is missing or ctx is absent', async () => {
    mockFetch();
    const res1 = await worker.fetch(req({ ...BODY, action: 'summaries' }), env(), makeCtx());
    expect(res1.status).toBe(200);
    const res2 = await worker.fetch(req({ ...BODY, action: 'summaries' }), env({ SHARED_DB: makeDB() }));
    expect(res2.status).toBe(200);
  });

  it('still returns the completion when the ai_usage table does not exist yet', async () => {
    mockFetch();
    const db = makeDB();
    db._raw.exec('DROP TABLE ai_usage');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = makeCtx();
    const res = await worker.fetch(req({ ...BODY, action: 'summaries' }), env({ SHARED_DB: db }), ctx);
    expect(res.status).toBe(200);
    await expect(ctx.flush()).resolves.toBeDefined();
  });
});
