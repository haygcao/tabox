// chrome/task-planner.js — session store + handlers, with a mocked AI client
// and stateful storage. The AI client global is read lazily by the module, so
// each test installs its own mock on globalThis.TaboxAIClient.
require('jest-webextension-mock');
const { installStatefulLocalStorage } = require('./helpers/statefulLocalStorage');
installStatefulLocalStorage();

const core = require('../chrome/task-planner-core.js');
const planner = require('../chrome/task-planner.js');

const KEY = planner.TASK_PLANNER_SESSION_KEY;

const readStored = async () => (await browser.storage.local.get(KEY))[KEY];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Installs the AI client mock. `extra` overrides client members — pass a
// custom `validateUrls` to exercise the reachability filter; by default every
// url validates ok so existing turn tests land their tabs untouched.
function mockAI(impl, extra = {}) {
    const fn = jest.fn(impl);
    globalThis.TaboxAIClient = {
        requestChatCompletion: fn,
        validateUrls: jest.fn(async (urls) => urls.map((url) => ({ url, ok: true }))),
        ...extra,
    };
    return fn;
}

function turnJSON({ reply = 'Here you go', collectionName = 'My Plan', changedGroups, removedGroupTitles = [], removedUrls = [] } = {}) {
    return JSON.stringify({
        reply,
        collectionName,
        changedGroups: changedGroups || [{ title: 'Reading', color: 'blue', tabs: [{ title: 'MDN', url: 'https://developer.mozilla.org' }] }],
        removedGroupTitles,
        removedUrls,
    });
}

async function seedSession(overrides = {}) {
    const now = Date.now();
    const session = {
        sessionId: 'session-1',
        status: 'ready',
        greeting: planner.PLANNER_GREETING,
        pills: ['Plan a trip', 'Research a topic', 'Compare products'],
        pillsSeen: ['Plan a trip', 'Research a topic', 'Compare products'],
        messages: [],
        groups: [],
        collectionName: '',
        linkedCollectionUid: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
    await browser.storage.local.set({ [KEY]: session });
    return session;
}

beforeEach(async () => {
    await browser.storage.local.clear();
    mockAI(async () => turnJSON());
});

describe('taskPlannerStart', () => {
    test('mints a session with the contract shape and AI-generated pills', async () => {
        const ai = mockAI(async () => '{"pills":["Plan a trip","Research desks","Learn Spanish"]}');
        const loadSummaries = jest.fn(async () => [{ name: 'Japan 2026', tabs: [{ title: 'JAL' }] }]);
        const res = await planner.taskPlannerStart({ loadSummaries });
        expect(res.ok).toBe(true);
        const s = res.state;
        expect(s.sessionId).toBeTruthy();
        expect(s.status).toBe('ready');
        expect(s.greeting).toBe(planner.PLANNER_GREETING);
        expect(s.pills).toEqual(['Plan a trip', 'Research desks', 'Learn Spanish']);
        expect(s.messages).toEqual([]);
        expect(s.groups).toEqual([]);
        expect(s.collectionName).toBe('');
        expect(s.linkedCollectionUid).toBeNull();
        expect(s.error).toBeNull();
        expect(typeof s.createdAt).toBe('number');
        expect(typeof s.updatedAt).toBe('number');
        expect(await readStored()).toEqual(s);
        // Pills call fed by the collection summaries, constrained by PILLS_SCHEMA.
        expect(loadSummaries).toHaveBeenCalled();
        const [messages, opts] = ai.mock.calls[0];
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toContain('Japan 2026');
        expect(opts.responseConstraint).toBe(core.PILLS_SCHEMA);
    });

    test('falls back to FALLBACK_PILLS when the AI call fails — never an error state', async () => {
        mockAI(async () => { throw new Error('sign in to Tabox to use AI features'); });
        const res = await planner.taskPlannerStart({ loadSummaries: async () => [] });
        expect(res.ok).toBe(true);
        expect(res.state.status).toBe('ready');
        expect(res.state.error).toBeNull();
        expect(res.state.pills).toEqual(core.FALLBACK_PILLS);
    });

    test('falls back when the model returns unusable pills (too few)', async () => {
        mockAI(async () => '{"pills":["Only", "Two"]}');
        const res = await planner.taskPlannerStart({});
        expect(res.state.pills).toEqual(core.FALLBACK_PILLS);
    });

    test('falls back when loadSummaries itself throws', async () => {
        const ai = mockAI(async () => '{"pills":["A","B","C"]}');
        const res = await planner.taskPlannerStart({ loadSummaries: async () => { throw new Error('storage broke'); } });
        expect(res.ok).toBe(true);
        expect(res.state.pills).toEqual(core.FALLBACK_PILLS);
        expect(ai).not.toHaveBeenCalled();
    });

    test('returns the existing session when it is <24h old and not forced', async () => {
        const ai = mockAI(async () => turnJSON());
        const existing = await seedSession({ messages: [{ id: 'm1', role: 'user', content: 'hi', ts: 1 }] });
        const res = await planner.taskPlannerStart({});
        expect(res.state).toEqual(existing);
        expect(ai).not.toHaveBeenCalled(); // no pill regeneration for a reused session
    });

    test('force mints a fresh session even when a recent one exists', async () => {
        mockAI(async () => '{"pills":["A pill","B pill","C pill"]}');
        await seedSession();
        const res = await planner.taskPlannerStart({ force: true });
        expect(res.state.sessionId).not.toBe('session-1');
        expect(res.state.messages).toEqual([]);
    });

    test('an expired (>24h) session is replaced', async () => {
        mockAI(async () => '{"pills":["A pill","B pill","C pill"]}');
        const old = Date.now() - planner.SESSION_MAX_AGE_MS - 1000;
        await seedSession({ createdAt: old, updatedAt: old });
        const res = await planner.taskPlannerStart({});
        expect(res.state.sessionId).not.toBe('session-1');
    });

    test('a reset landing while pills generate does not resurrect the session', async () => {
        let resolvePills;
        mockAI(() => new Promise((resolve) => { resolvePills = resolve; }));
        const startPromise = planner.taskPlannerStart({});
        await tick();
        expect(await readStored()).toBeTruthy(); // session written, pills pending
        await planner.taskPlannerReset();
        resolvePills('{"pills":["A pill","B pill","C pill"]}');
        const res = await startPromise;
        expect(res.ok).toBe(true);
        expect(res.state).toBeNull();
        expect(await readStored()).toBeUndefined();
    });

    test('regenerates pills on reuse when the session persisted with pills null (SW died mid-generation)', async () => {
        const ai = mockAI(async () => '{"pills":["A pill","B pill","C pill"]}');
        await seedSession({ pills: null });
        const res = await planner.taskPlannerStart({ loadSummaries: async () => [] });
        expect(res.ok).toBe(true);
        expect(res.state.sessionId).toBe('session-1'); // reused, not replaced
        expect(res.state.pills).toEqual(['A pill', 'B pill', 'C pill']);
        expect((await readStored()).pills).toEqual(['A pill', 'B pill', 'C pill']);
        expect(ai).toHaveBeenCalledTimes(1);
    });

    test('pills regen on reuse falls back to FALLBACK_PILLS on AI failure', async () => {
        mockAI(async () => { throw new Error('sign in to Tabox to use AI features'); });
        await seedSession({ pills: null });
        const res = await planner.taskPlannerStart({});
        expect(res.ok).toBe(true);
        expect(res.state.pills).toEqual(core.FALLBACK_PILLS);
    });

    test('two concurrent starts share one session and one pill generation', async () => {
        let resolvePills;
        const ai = mockAI(() => new Promise((resolve) => { resolvePills = resolve; }));
        const p1 = planner.taskPlannerStart({});
        const p2 = planner.taskPlannerStart({});
        await tick();
        expect(ai).toHaveBeenCalledTimes(1); // second start piggybacks on the first
        resolvePills('{"pills":["A pill","B pill","C pill"]}');
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.ok).toBe(true);
        expect(r1.state.sessionId).toBe(r2.state.sessionId);
        expect(r1.state.pills).toEqual(['A pill', 'B pill', 'C pill']);
        // The dedupe window closes with the in-flight start: a later start is
        // its own call — reusing the session but generating a FRESH batch.
        const ai2 = mockAI(async () => '{"pills":["D pill","E pill","F pill"]}');
        const r3 = await planner.taskPlannerStart({});
        expect(r3.state.sessionId).toBe(r1.state.sessionId);
        expect(r3.state.pills).toEqual(['D pill', 'E pill', 'F pill']);
        expect(ai2).toHaveBeenCalledTimes(1);
    });

    test('reusing an unused chat generates fresh pills each open, steering away from seen ones', async () => {
        const ai = mockAI(async () => '{"pills":["Plan a heist","Learn pottery","Track a comet"]}');
        await seedSession(); // no user messages; pills + pillsSeen populated
        const res = await planner.taskPlannerStart({});
        expect(res.ok).toBe(true);
        expect(res.state.sessionId).toBe('session-1'); // reused, not replaced
        expect(res.state.pills).toEqual(['Plan a heist', 'Learn pottery', 'Track a comet']);
        // Previously seen pills ride in the avoid list, and the batch is recorded.
        const [messages, opts] = ai.mock.calls[0];
        expect(messages[0].content).toContain('already seen');
        expect(messages[0].content).toContain('Plan a trip');
        expect(opts.temperature).toBe(0.9);
        expect(res.state.pillsSeen).toEqual([
            'Plan a trip', 'Research a topic', 'Compare products',
            'Plan a heist', 'Learn pottery', 'Track a comet',
        ]);
    });

    test('pillsSeen is capped at MAX_PILLS_SEEN', async () => {
        mockAI(async () => '{"pills":["New A","New B","New C"]}');
        const seen = Array.from({ length: core.MAX_PILLS_SEEN }, (_, i) => `Old ${i}`);
        await seedSession({ pillsSeen: seen });
        const res = await planner.taskPlannerStart({});
        expect(res.state.pillsSeen).toHaveLength(core.MAX_PILLS_SEEN);
        expect(res.state.pillsSeen.slice(-3)).toEqual(['New A', 'New B', 'New C']);
        expect(res.state.pillsSeen[0]).toBe('Old 3'); // oldest entries dropped
    });
});

describe('taskPlannerRefreshPills', () => {
    test('flips to skeletons, lands a fresh batch avoiding seen pills, records it', async () => {
        let resolvePills;
        const ai = mockAI(() => new Promise((resolve) => { resolvePills = resolve; }));
        await seedSession();
        const p = planner.taskPlannerRefreshPills({});
        await tick();
        expect((await readStored()).pills).toBeNull(); // skeletons while generating
        resolvePills('{"pills":["Plan a heist","Learn pottery","Track a comet"]}');
        const res = await p;
        expect(res.ok).toBe(true);
        expect(res.state.pills).toEqual(['Plan a heist', 'Learn pottery', 'Track a comet']);
        expect(res.state.pillsSeen).toContain('Plan a heist');
        const [messages] = ai.mock.calls[0];
        expect(messages[0].content).toContain('Plan a trip'); // avoid list
    });

    test('is ignored once the conversation has a user message', async () => {
        const ai = mockAI(async () => '{"pills":["A pill","B pill","C pill"]}');
        await seedSession({ messages: [{ id: 'm1', role: 'user', content: 'hi', ts: 1 }] });
        const res = await planner.taskPlannerRefreshPills({});
        expect(res.ok).toBe(true);
        expect(res.ignored).toBe(true);
        expect(ai).not.toHaveBeenCalled();
    });

    test('errors cleanly with no session', async () => {
        const res = await planner.taskPlannerRefreshPills({});
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/no active planner session/i);
    });

    test('concurrent refreshes share one AI call', async () => {
        let resolvePills;
        const ai = mockAI(() => new Promise((resolve) => { resolvePills = resolve; }));
        await seedSession();
        const p1 = planner.taskPlannerRefreshPills({});
        const p2 = planner.taskPlannerRefreshPills({});
        await tick();
        expect(ai).toHaveBeenCalledTimes(1);
        resolvePills('{"pills":["A pill","B pill","C pill"]}');
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.state.pills).toEqual(r2.state.pills);
    });

    test('a reset landing mid-refresh does not resurrect the session', async () => {
        let resolvePills;
        mockAI(() => new Promise((resolve) => { resolvePills = resolve; }));
        await seedSession();
        const p = planner.taskPlannerRefreshPills({});
        await tick();
        await planner.taskPlannerReset();
        resolvePills('{"pills":["A pill","B pill","C pill"]}');
        const res = await p;
        expect(res.ok).toBe(true);
        expect(res.state).toBeNull();
        expect(await readStored()).toBeUndefined();
    });

    test('AI failure falls back to FALLBACK_PILLS, never an error state', async () => {
        mockAI(async () => { throw new Error('rate_limited'); });
        await seedSession();
        const res = await planner.taskPlannerRefreshPills({});
        expect(res.ok).toBe(true);
        expect(res.state.pills).toEqual(core.FALLBACK_PILLS);
        expect(res.state.status).toBe('ready');
    });
});

describe('taskPlannerSend', () => {
    test('happy path: appends both messages, lands normalized groups + name, status ready', async () => {
        const ai = mockAI(async () => turnJSON({ reply: 'Added some reading.', collectionName: 'Web Dev' }));
        await seedSession();
        const res = await planner.taskPlannerSend({ text: '  plan my reading  ' });
        expect(res.ok).toBe(true);
        const s = res.state;
        expect(s.status).toBe('ready');
        expect(s.error).toBeNull();
        expect(s.messages).toHaveLength(2);
        expect(s.messages[0]).toMatchObject({ role: 'user', content: 'plan my reading' });
        expect(s.messages[1]).toMatchObject({ role: 'assistant', content: 'Added some reading.' });
        expect(s.messages.every((m) => m.id && typeof m.ts === 'number')).toBe(true);
        expect(s.collectionName).toBe('Web Dev');
        expect(s.groups).toHaveLength(1);
        expect(s.groups[0]).toMatchObject({ title: 'Reading', color: 'blue' });
        expect(s.groups[0].uid).toBeTruthy();
        expect(s.groups[0].tabs[0]).toMatchObject({ title: 'MDN', url: 'https://developer.mozilla.org' });
        expect(s.groups[0].tabs[0].uid).toBeTruthy();
        expect(await readStored()).toEqual(s);
        // AI turn contract: system (rules + current tab set) + history + user, temp 0.7, turn schema.
        const [messages, opts] = ai.mock.calls[0];
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('CURRENT TAB SET');
        expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'plan my reading' });
        expect(opts.temperature).toBe(0.7);
        expect(opts.responseConstraint).toBe(core.PLANNER_TURN_SCHEMA);
        // Chat turns run the thinking tier for facet decomposition.
        expect(opts.modelTier).toBe('thinking');
    });

    test('pill generation stays on the fast default tier', async () => {
        const ai = mockAI(async () => '{"pills":["A pill","B pill","C pill"]}');
        await planner.taskPlannerStart({});
        const [, opts] = ai.mock.calls[0];
        expect(opts.modelTier).toBeUndefined();
    });

    test('windows the history to HISTORY_WINDOW display messages', async () => {
        const ai = mockAI(async () => turnJSON());
        const messages = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `msg ${i}`, ts: i }));
        await seedSession({ messages });
        await planner.taskPlannerSend({ text: 'next' });
        const [sent] = ai.mock.calls[0];
        expect(sent).toHaveLength(1 + core.HISTORY_WINDOW + 1); // system + window + new user
        expect(sent[1]).toEqual({ role: 'user', content: 'msg 8' });
    });

    test('an off-topic turn (empty ops arrays) keeps groups identical, uids included', async () => {
        const prevGroups = [
            { uid: 'g-1', title: 'Flights', color: 'blue', tabs: [{ uid: 't-1', title: 'JAL', url: 'https://www.jal.com' }] },
        ];
        mockAI(async () => JSON.stringify({
            reply: 'I can only help you collect websites for a topic.',
            collectionName: 'Trip',
            changedGroups: [],
            removedGroupTitles: [],
            removedUrls: [],
        }));
        await seedSession({ groups: prevGroups, collectionName: 'Trip' });
        const res = await planner.taskPlannerSend({ text: 'what is 2+2?' });
        expect(res.state.groups).toEqual(prevGroups);
        expect(res.state.messages[1].content).toMatch(/^I can only help you collect websites/);
    });

    test('merges a diff turn onto the existing groups instead of replacing them', async () => {
        const prevGroups = [
            { uid: 'g-1', title: 'Flights', color: 'blue', tabs: [{ uid: 't-1', title: 'JAL', url: 'https://www.jal.com' }] },
            { uid: 'g-2', title: 'Hotels', color: 'red', tabs: [{ uid: 't-2', title: 'Booking', url: 'https://www.booking.com' }] },
        ];
        mockAI(async () => turnJSON({
            reply: 'Added food spots and dropped Booking.',
            collectionName: 'Trip',
            changedGroups: [{ title: 'Food', color: 'green', tabs: [{ title: 'Tabelog', url: 'https://tabelog.com' }] }],
            removedUrls: ['https://www.booking.com'],
        }));
        await seedSession({ groups: prevGroups, collectionName: 'Trip' });
        const res = await planner.taskPlannerSend({ text: 'add food, drop booking' });
        expect(res.ok).toBe(true);
        // Untouched group survives byte-identical; Hotels emptied out; Food appended.
        expect(res.state.groups.map((g) => g.title)).toEqual(['Flights', 'Food']);
        expect(res.state.groups[0]).toEqual(prevGroups[0]);
        expect(res.state.groups[1].tabs[0]).toMatchObject({ title: 'Tabelog', url: 'https://tabelog.com' });
    });

    test('parses a markdown-fenced JSON reply', async () => {
        mockAI(async () => '```json\n' + turnJSON() + '\n```');
        await seedSession();
        const res = await planner.taskPlannerSend({ text: 'go' });
        expect(res.ok).toBe(true);
        expect(res.state.groups).toHaveLength(1);
    });

    test('is ignored while a turn is already thinking (no second AI call, flagged ignored)', async () => {
        const ai = mockAI(async () => turnJSON());
        const thinking = await seedSession({ status: 'thinking' });
        const res = await planner.taskPlannerSend({ text: 'another' });
        expect(res.ok).toBe(true);
        expect(res.ignored).toBe(true);
        expect(res.state).toEqual(thinking);
        expect(ai).not.toHaveBeenCalled();
    });

    test('ignores empty text (flagged ignored)', async () => {
        const ai = mockAI(async () => turnJSON());
        await seedSession();
        const res = await planner.taskPlannerSend({ text: '   ' });
        expect(res.ok).toBe(true);
        expect(res.ignored).toBe(true);
        expect(res.state.messages).toEqual([]);
        expect(ai).not.toHaveBeenCalled();
    });

    test('two rapid sends: only the first appends and calls the AI, the second is ignored', async () => {
        let resolveTurn;
        const ai = mockAI(() => new Promise((resolve) => { resolveTurn = resolve; }));
        await seedSession();
        // Fired back-to-back with no tick in between: both pass any naive
        // pre-check, but the single read-merge-write serializes the verdicts.
        const first = planner.taskPlannerSend({ text: 'plan' });
        const second = planner.taskPlannerSend({ text: 'plan again' });
        const resSecond = await second;
        expect(resSecond.ok).toBe(true);
        expect(resSecond.ignored).toBe(true);
        expect(ai).toHaveBeenCalledTimes(1);
        resolveTurn(turnJSON());
        const resFirst = await first;
        expect(resFirst.ok).toBe(true);
        expect(resFirst.ignored).toBeUndefined();
        const stored = await readStored();
        expect(stored.messages.map((m) => m.content)).toEqual(['plan', 'Here you go']);
    });

    test('clamps user text to MAX_USER_MESSAGE_CHARS in both the transcript and the prompt', async () => {
        const ai = mockAI(async () => turnJSON());
        await seedSession();
        const res = await planner.taskPlannerSend({ text: 'x'.repeat(core.MAX_USER_MESSAGE_CHARS + 500) });
        expect(res.ok).toBe(true);
        expect(res.state.messages[0].content).toHaveLength(core.MAX_USER_MESSAGE_CHARS);
        const [sent] = ai.mock.calls[0];
        expect(sent[sent.length - 1].content).toHaveLength(core.MAX_USER_MESSAGE_CHARS);
    });

    test('caps the stored transcript at MAX_STORED_MESSAGES', async () => {
        mockAI(async () => turnJSON({ reply: 'latest' }));
        const messages = Array.from({ length: core.MAX_STORED_MESSAGES + 10 }, (_, i) => (
            { id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `msg ${i}`, ts: i }
        ));
        await seedSession({ messages });
        const res = await planner.taskPlannerSend({ text: 'next' });
        expect(res.state.messages).toHaveLength(core.MAX_STORED_MESSAGES);
        // The newest messages survive the cap; the oldest are dropped.
        const contents = res.state.messages.map((m) => m.content);
        expect(contents[contents.length - 2]).toBe('next');
        expect(contents[contents.length - 1]).toBe('latest');
        expect(contents).not.toContain('msg 0');
    });

    test('errors cleanly with no session', async () => {
        const res = await planner.taskPlannerSend({ text: 'hello' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/no active planner session/i);
    });

    test('AI failure → status error + message, transcript intact for retry', async () => {
        mockAI(async () => { throw new Error('Tabox AI: request timed out after 90s'); });
        await seedSession({ messages: [{ id: 'm0', role: 'user', content: 'earlier', ts: 1 }] });
        const res = await planner.taskPlannerSend({ text: 'plan a trip' });
        expect(res.ok).toBe(false);
        expect(res.error).toContain('timed out');
        const stored = await readStored();
        expect(stored.status).toBe('error');
        expect(stored.error).toContain('timed out');
        expect(stored.messages.map((m) => m.content)).toEqual(['earlier', 'plan a trip']); // kept
    });

    test('unparseable model output → error state, transcript intact', async () => {
        mockAI(async () => 'not json at all');
        await seedSession();
        const res = await planner.taskPlannerSend({ text: 'plan' });
        expect(res.ok).toBe(false);
        const stored = await readStored();
        expect(stored.status).toBe('error');
        expect(stored.messages).toHaveLength(1);
    });

    test('a reset mid-turn drops the result instead of resurrecting the session', async () => {
        let resolveTurn;
        mockAI(() => new Promise((resolve) => { resolveTurn = resolve; }));
        await seedSession();
        const sendPromise = planner.taskPlannerSend({ text: 'plan' });
        await tick();
        expect((await readStored()).status).toBe('thinking');
        await planner.taskPlannerReset();
        resolveTurn(turnJSON());
        const res = await sendPromise;
        expect(res.ok).toBe(true);
        expect(res.state).toBeNull();
        expect(await readStored()).toBeUndefined();
    });

    test('a new session started mid-turn does not adopt the stale result (sessionId guard)', async () => {
        let resolveTurn;
        mockAI(() => new Promise((resolve) => { resolveTurn = resolve; }));
        await seedSession();
        const sendPromise = planner.taskPlannerSend({ text: 'plan' });
        await tick();
        expect((await readStored()).status).toBe('thinking');
        // Reset and start a FRESH session while the old turn is still awaiting the AI.
        await planner.taskPlannerReset();
        mockAI(async () => '{"pills":["A pill","B pill","C pill"]}');
        const fresh = await planner.taskPlannerStart({});
        expect(fresh.state.sessionId).not.toBe('session-1');
        resolveTurn(turnJSON());
        const res = await sendPromise;
        expect(res.ok).toBe(true);
        const stored = await readStored();
        expect(stored.sessionId).toBe(fresh.state.sessionId);
        expect(stored.messages).toEqual([]); // the stale turn did not graft on
        expect(stored.groups).toEqual([]);
        expect(stored.status).toBe('ready');
    });

    test('a stale AI failure does not land its error on a freshly started session (sessionId guard)', async () => {
        let rejectTurn;
        mockAI(() => new Promise((_, reject) => { rejectTurn = reject; }));
        await seedSession();
        const sendPromise = planner.taskPlannerSend({ text: 'plan' });
        await tick();
        await planner.taskPlannerReset();
        mockAI(async () => '{"pills":["A pill","B pill","C pill"]}');
        const fresh = await planner.taskPlannerStart({});
        rejectTurn(new Error('Tabox AI: request timed out after 90s'));
        const res = await sendPromise;
        expect(res.ok).toBe(false); // the caller still learns its turn failed…
        const stored = await readStored();
        expect(stored.sessionId).toBe(fresh.state.sessionId);
        expect(stored.status).toBe('ready'); // …but the new session stays clean
        expect(stored.error).toBeNull();
    });

    test("an overlapping ignored send must not clear the live turn's heal protection (counter, not boolean)", async () => {
        let resolveTurn;
        mockAI(() => new Promise((resolve) => { resolveTurn = resolve; }));
        await seedSession();
        const sendA = planner.taskPlannerSend({ text: 'plan' });
        await tick();
        expect((await readStored()).status).toBe('thinking');
        // Send B collides with A's thinking turn: it settles (and decrements
        // its own in-flight count) while A is still awaiting the AI.
        const resB = await planner.taskPlannerSend({ text: 'again' });
        expect(resB.ignored).toBe(true);
        // A boolean flag cleared by B's exit would let this heal kill A's live turn.
        const mid = await planner.taskPlannerGetState();
        expect(mid.state.status).toBe('thinking');
        resolveTurn(turnJSON());
        const res = await sendA;
        expect(res.ok).toBe(true);
        expect((await readStored()).status).toBe('ready');
    });
});

describe('taskPlannerSend URL validation', () => {
    const twoTabTurn = () => turnJSON({
        reply: 'Added reading.',
        changedGroups: [{ title: 'Reading', color: 'blue', tabs: [
            { title: 'MDN', url: 'https://developer.mozilla.org' },
            { title: 'Ghost', url: 'https://ghost.example.com' },
        ] }],
    });

    test('drops unreachable new tabs and appends the singular note', async () => {
        mockAI(async () => twoTabTurn(), {
            validateUrls: jest.fn(async (urls) => urls.map((url) => ({
                url, ok: url !== 'https://ghost.example.com', status: url === 'https://ghost.example.com' ? 404 : 200,
            }))),
        });
        await seedSession();
        const res = await planner.taskPlannerSend({ text: 'plan reading' });
        expect(res.ok).toBe(true);
        expect(res.state.groups).toHaveLength(1);
        expect(res.state.groups[0].tabs.map((t) => t.url)).toEqual(['https://developer.mozilla.org']);
        expect(res.state.messages[1].content).toBe(
            "Added reading.\n\nI checked the new links and removed 1 that couldn't be reached.",
        );
    });

    test('drops multiple unreachable tabs with the count in the note (plural) and drops emptied groups', async () => {
        mockAI(async () => turnJSON({
            reply: 'Here you go.',
            changedGroups: [
                { title: 'Alive', color: 'blue', tabs: [{ title: 'A', url: 'https://alive.com' }] },
                { title: 'Dead', color: 'red', tabs: [
                    { title: 'D1', url: 'https://dead1.example.com' },
                    { title: 'D2', url: 'https://dead2.example.com' },
                ] },
            ],
        }), {
            validateUrls: jest.fn(async (urls) => urls.map((url) => ({ url, ok: !url.includes('dead') }))),
        });
        await seedSession();
        const res = await planner.taskPlannerSend({ text: 'plan' });
        expect(res.ok).toBe(true);
        expect(res.state.groups.map((g) => g.title)).toEqual(['Alive']); // emptied group dropped
        expect(res.state.messages[1].content).toContain("removed 2 that couldn't be reached");
    });

    test('only NEW urls are sent to the validator — pre-existing tabs are not re-checked', async () => {
        const prevGroups = [
            { uid: 'g-1', title: 'Flights', color: 'blue', tabs: [{ uid: 't-1', title: 'JAL', url: 'https://www.jal.com' }] },
        ];
        const validateUrls = jest.fn(async (urls) => urls.map((url) => ({ url, ok: true })));
        mockAI(async () => turnJSON({
            // Restructures Flights re-listing the existing JAL url + one new url.
            changedGroups: [{ title: 'Flights', color: 'blue', tabs: [
                { title: 'JAL', url: 'https://www.jal.com' },
                { title: 'ANA', url: 'https://www.ana.co.jp' },
            ] }],
        }), { validateUrls });
        await seedSession({ groups: prevGroups });
        const res = await planner.taskPlannerSend({ text: 'more flights' });
        expect(res.ok).toBe(true);
        expect(validateUrls).toHaveBeenCalledTimes(1);
        expect(validateUrls).toHaveBeenCalledWith(['https://www.ana.co.jp']);
    });

    test('validator throw → fail open: all tabs kept, no note appended', async () => {
        mockAI(async () => twoTabTurn(), {
            validateUrls: jest.fn(async () => { throw new Error('validator down'); }),
        });
        await seedSession();
        const res = await planner.taskPlannerSend({ text: 'plan' });
        expect(res.ok).toBe(true);
        expect(res.state.status).toBe('ready');
        expect(res.state.groups[0].tabs).toHaveLength(2);
        expect(res.state.messages[1].content).toBe('Added reading.');
        expect(res.state.messages[1].content).not.toContain("couldn't be reached");
    });

    test('a client without validateUrls (older SW) also fails open', async () => {
        mockAI(async () => twoTabTurn(), { validateUrls: undefined });
        await seedSession();
        const res = await planner.taskPlannerSend({ text: 'plan' });
        expect(res.ok).toBe(true);
        expect(res.state.groups[0].tabs).toHaveLength(2);
        expect(res.state.messages[1].content).toBe('Added reading.');
    });

    test('a clarify turn (no new urls) never calls the validator', async () => {
        const validateUrls = jest.fn(async (urls) => urls.map((url) => ({ url, ok: true })));
        mockAI(async () => JSON.stringify({
            reply: 'What topic would you like to research?',
            collectionName: '',
            changedGroups: [],
            removedGroupTitles: [],
            removedUrls: [],
        }), { validateUrls });
        await seedSession();
        const res = await planner.taskPlannerSend({ text: 'research a topic' });
        expect(res.ok).toBe(true);
        expect(validateUrls).not.toHaveBeenCalled();
    });
});

describe('taskPlannerLoadCollection', () => {
    const loadedGroups = () => ([
        { uid: 'g-1', title: 'Reading', color: 'blue', tabs: [
            { uid: 't-1', title: 'MDN', url: 'https://developer.mozilla.org' },
            { uid: 't-2', title: 'Spec', url: 'https://spec.example.com' },
        ] },
        { uid: 'g-2', title: 'Videos', color: 'red', tabs: [
            { uid: 't-3', title: 'Talks', url: 'https://talks.example.com' },
        ] },
    ]);

    test('happy path: links the session, normalizes groups with uids preserved, announces counts', async () => {
        await seedSession({ collectionName: 'Old Name', error: 'stale error', status: 'error' });
        const res = await planner.taskPlannerLoadCollection({ uid: 'col-1', name: 'Web Dev Research', groups: loadedGroups() });
        expect(res.ok).toBe(true);
        expect(res.ignored).toBeUndefined();
        const s = res.state;
        expect(s.status).toBe('ready');
        expect(s.error).toBeNull();
        expect(s.linkedCollectionUid).toBe('col-1');
        expect(s.collectionName).toBe('Web Dev Research');
        // Normalized through normalizeLoadedGroups (no size caps) — group AND
        // tab uids survive.
        expect(s.groups.map((g) => g.uid)).toEqual(['g-1', 'g-2']);
        expect(s.groups[0].tabs.map((t) => t.uid)).toEqual(['t-1', 't-2']);
        expect(s.groups[1].tabs.map((t) => t.uid)).toEqual(['t-3']);
        // ONE assistant announcement with correct counts and pluralization.
        expect(s.messages).toHaveLength(1);
        expect(s.messages[0]).toMatchObject({
            role: 'assistant',
            content: 'Loaded "Web Dev Research" — 3 tabs in 2 groups. Tell me what you\'d like to add or change!',
        });
        expect(s.messages[0].id).toBeTruthy();
        expect(typeof s.messages[0].ts).toBe('number');
        expect(await readStored()).toEqual(s);
    });

    test('singular pluralization: 1 tab in 1 group', async () => {
        await seedSession();
        const res = await planner.taskPlannerLoadCollection({
            uid: 'col-2',
            name: 'Tiny',
            groups: [{ uid: 'g-1', title: 'Only', color: 'blue', tabs: [{ uid: 't-1', title: 'One', url: 'https://one.com' }] }],
        });
        expect(res.state.messages[0].content).toBe('Loaded "Tiny" — 1 tab in 1 group. Tell me what you\'d like to add or change!');
    });

    test('clamps the collection name and drops invalid tabs before counting', async () => {
        await seedSession();
        const res = await planner.taskPlannerLoadCollection({
            uid: 'col-3',
            name: 'n'.repeat(200),
            groups: [{ uid: 'g-1', title: 'Mixed', color: 'blue', tabs: [
                { uid: 't-1', title: 'Good', url: 'https://good.com' },
                { uid: 't-2', title: 'Bad', url: 'chrome://settings' },
            ] }],
        });
        expect(res.state.collectionName).toHaveLength(core.MAX_COLLECTION_NAME);
        expect(res.state.groups[0].tabs.map((t) => t.url)).toEqual(['https://good.com']);
        expect(res.state.messages[0].content).toContain('1 tab in 1 group');
    });

    test('loads a big collection whole — no group/tab caps on the load path', async () => {
        await seedSession();
        const groups = Array.from({ length: 25 }, (_, gi) => ({
            uid: `g-${gi}`, title: `G${gi}`, color: 'blue',
            tabs: Array.from({ length: 20 }, (_, ti) => ({ uid: `t-${gi}-${ti}`, title: 't', url: `https://site${gi}-${ti}.com` })),
        }));
        const res = await planner.taskPlannerLoadCollection({ uid: 'col-big', name: 'Big', groups });
        expect(res.ok).toBe(true);
        expect(res.state.groups).toHaveLength(25);
        expect(res.state.groups.reduce((n, g) => n + g.tabs.length, 0)).toBe(500);
        // The announcement counts the FULL loaded set.
        expect(res.state.messages[0].content).toContain('500 tabs in 25 groups');
    });

    test('appends to an existing transcript, capped at MAX_STORED_MESSAGES', async () => {
        const messages = Array.from({ length: core.MAX_STORED_MESSAGES }, (_, i) => (
            { id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `msg ${i}`, ts: i }
        ));
        await seedSession({ messages });
        const res = await planner.taskPlannerLoadCollection({ uid: 'col-4', name: 'Full', groups: loadedGroups() });
        expect(res.state.messages).toHaveLength(core.MAX_STORED_MESSAGES);
        expect(res.state.messages[res.state.messages.length - 1].content).toMatch(/^Loaded "Full"/);
        expect(res.state.messages.map((m) => m.content)).not.toContain('msg 0');
    });

    test('is ignored while a turn is thinking — no mutation', async () => {
        const thinking = await seedSession({ status: 'thinking' });
        const res = await planner.taskPlannerLoadCollection({ uid: 'col-5', name: 'Nope', groups: loadedGroups() });
        expect(res.ok).toBe(true);
        expect(res.ignored).toBe(true);
        expect(res.state).toEqual(thinking);
        const stored = await readStored();
        expect(stored.linkedCollectionUid).toBeNull();
        expect(stored.groups).toEqual([]);
        expect(stored.messages).toEqual([]);
    });

    test('errors cleanly with no session', async () => {
        const res = await planner.taskPlannerLoadCollection({ uid: 'col-6', name: 'X', groups: [] });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/no active planner session/i);
    });
});

describe('taskPlannerMarkSaved', () => {
    test('links the session to the saved collection and adopts the final name', async () => {
        await seedSession({ collectionName: 'Draft name' });
        const before = (await readStored()).updatedAt;
        const res = await planner.taskPlannerMarkSaved({ uid: 'col-9', name: 'Saved Name' });
        expect(res.ok).toBe(true);
        expect(res.state.linkedCollectionUid).toBe('col-9');
        expect(res.state.collectionName).toBe('Saved Name');
        expect(res.state.updatedAt).toBeGreaterThanOrEqual(before);
        expect(await readStored()).toEqual(res.state);
    });

    test('keeps the existing name when none is given, and clamps a long one', async () => {
        await seedSession({ collectionName: 'Existing' });
        const res = await planner.taskPlannerMarkSaved({ uid: 'col-10' });
        expect(res.state.collectionName).toBe('Existing');
        expect(res.state.linkedCollectionUid).toBe('col-10');
        const res2 = await planner.taskPlannerMarkSaved({ uid: 'col-11', name: 'n'.repeat(200) });
        expect(res2.state.collectionName).toHaveLength(50);
    });

    test('errors cleanly with no session', async () => {
        const res = await planner.taskPlannerMarkSaved({ uid: 'col-12' });
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/no active planner session/i);
    });
});

describe('linkedCollectionUid persistence across mutations', () => {
    test('send preserves the link through thinking and landing', async () => {
        mockAI(async () => turnJSON());
        await seedSession({ linkedCollectionUid: 'col-1' });
        const res = await planner.taskPlannerSend({ text: 'add more' });
        expect(res.ok).toBe(true);
        expect(res.state.linkedCollectionUid).toBe('col-1');
    });

    test('a failed send preserves the link on the error state', async () => {
        mockAI(async () => { throw new Error('boom'); });
        await seedSession({ linkedCollectionUid: 'col-1' });
        await planner.taskPlannerSend({ text: 'add more' });
        expect((await readStored()).linkedCollectionUid).toBe('col-1');
    });

    test('removeTab preserves the link', async () => {
        await seedSession({
            linkedCollectionUid: 'col-1',
            groups: [{ uid: 'g-1', title: 'A', color: 'blue', tabs: [
                { uid: 't-1', title: '1', url: 'https://1.com' },
                { uid: 't-2', title: '2', url: 'https://2.com' },
            ] }],
        });
        const res = await planner.taskPlannerRemoveTab({ groupUid: 'g-1', tabUid: 't-1' });
        expect(res.state.linkedCollectionUid).toBe('col-1');
    });

    test('reset clears everything, link included', async () => {
        await seedSession({ linkedCollectionUid: 'col-1' });
        const res = await planner.taskPlannerReset();
        expect(res).toEqual({ ok: true, state: null });
        expect(await readStored()).toBeUndefined();
    });
});

describe('taskPlannerRemoveTab', () => {
    test('removes a tab and keeps non-empty groups', async () => {
        await seedSession({ groups: [
            { uid: 'g-1', title: 'A', color: 'blue', tabs: [{ uid: 't-1', title: '1', url: 'https://1.com' }, { uid: 't-2', title: '2', url: 'https://2.com' }] },
            { uid: 'g-2', title: 'B', color: 'red', tabs: [{ uid: 't-3', title: '3', url: 'https://3.com' }] },
        ] });
        const before = (await readStored()).updatedAt;
        const res = await planner.taskPlannerRemoveTab({ groupUid: 'g-1', tabUid: 't-1' });
        expect(res.ok).toBe(true);
        expect(res.state.groups).toHaveLength(2);
        expect(res.state.groups[0].tabs.map((t) => t.uid)).toEqual(['t-2']);
        expect(res.state.updatedAt).toBeGreaterThanOrEqual(before);
    });

    test('dropping the last tab drops the group', async () => {
        await seedSession({ groups: [
            { uid: 'g-1', title: 'A', color: 'blue', tabs: [{ uid: 't-1', title: '1', url: 'https://1.com' }] },
        ] });
        const res = await planner.taskPlannerRemoveTab({ groupUid: 'g-1', tabUid: 't-1' });
        expect(res.state.groups).toEqual([]);
    });

    test('errors cleanly with no session', async () => {
        const res = await planner.taskPlannerRemoveTab({ groupUid: 'g', tabUid: 't' });
        expect(res.ok).toBe(false);
    });

    test('concurrent removals are serialized — neither is lost', async () => {
        await seedSession({ groups: [
            { uid: 'g-1', title: 'A', color: 'blue', tabs: [
                { uid: 't-1', title: '1', url: 'https://1.com' },
                { uid: 't-2', title: '2', url: 'https://2.com' },
                { uid: 't-3', title: '3', url: 'https://3.com' },
            ] },
        ] });
        await Promise.all([
            planner.taskPlannerRemoveTab({ groupUid: 'g-1', tabUid: 't-1' }),
            planner.taskPlannerRemoveTab({ groupUid: 'g-1', tabUid: 't-2' }),
        ]);
        const stored = await readStored();
        expect(stored.groups[0].tabs.map((t) => t.uid)).toEqual(['t-3']);
    });
});

describe('taskPlannerReset', () => {
    test('deletes the session key', async () => {
        await seedSession();
        const res = await planner.taskPlannerReset();
        expect(res).toEqual({ ok: true, state: null });
        expect(await readStored()).toBeUndefined();
    });
});

describe('taskPlannerGetState', () => {
    test('returns null with no session', async () => {
        expect(await planner.taskPlannerGetState()).toEqual({ ok: true, state: null });
    });

    test('returns a live session untouched', async () => {
        const session = await seedSession();
        const res = await planner.taskPlannerGetState();
        expect(res.state).toEqual(session);
    });

    test("heals a stale 'thinking' (owning SW died) into a friendly error", async () => {
        await seedSession({ status: 'thinking', updatedAt: Date.now() - 5000 });
        const res = await planner.taskPlannerGetState();
        expect(res.ok).toBe(true);
        expect(res.state.status).toBe('error');
        expect(res.state.error).toBe(planner.THINKING_INTERRUPTED_ERROR);
        expect((await readStored()).status).toBe('error');
    });

    test('does NOT heal a fresh thinking state while the send is in flight', async () => {
        let resolveTurn;
        mockAI(() => new Promise((resolve) => { resolveTurn = resolve; }));
        await seedSession();
        const sendPromise = planner.taskPlannerSend({ text: 'plan' });
        await tick();
        expect((await readStored()).status).toBe('thinking');
        const mid = await planner.taskPlannerGetState();
        expect(mid.state.status).toBe('thinking'); // in flight + fresh → left alone
        resolveTurn(turnJSON());
        const res = await sendPromise;
        expect(res.ok).toBe(true);
        expect((await readStored()).status).toBe('ready');
    });

    test('heals even an in-flight thinking state once it exceeds the staleness window', async () => {
        let resolveTurn;
        mockAI(() => new Promise((resolve) => { resolveTurn = resolve; }));
        await seedSession();
        const sendPromise = planner.taskPlannerSend({ text: 'plan' });
        await tick();
        // Simulate a hung upstream: backdate the thinking write past the window.
        const stored = await readStored();
        await browser.storage.local.set({ [KEY]: { ...stored, updatedAt: Date.now() - planner.STALE_THINKING_MS - 1000 } });
        const res = await planner.taskPlannerGetState();
        expect(res.state.status).toBe('error');
        resolveTurn(turnJSON());
        await sendPromise;
    });

    test("start also heals a stale 'thinking' before deciding to reuse", async () => {
        await seedSession({ status: 'thinking', updatedAt: Date.now() - 5000 });
        const res = await planner.taskPlannerStart({});
        expect(res.state.sessionId).toBe('session-1'); // reused (fresh enough)…
        expect(res.state.status).toBe('error');        // …but healed, not stuck thinking
    });
});
