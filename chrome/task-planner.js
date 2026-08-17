// chrome/task-planner.js
// Task Planner session store + message handlers. Owns the 'taskPlannerSession'
// key in chrome.storage.local (state shape: docs/superpowers/specs/
// 2026-08-16-task-planner-design.md §2). The popup is a detachable observer —
// it renders exclusively from storage.onChanged plus taskPlannerGetState — so
// every mutation happens here in the service worker and survives popup close.
//
// Deliberately does NOT use the aiRun/aiTaskState engine: the planner owns a
// private key (like duplicateSweep) so a live chat never blocks Smart Organize
// and vice versa. Writes are serialized through a module-level promise chain
// (same pattern as ai-engine.js _writeChain) so overlapping handler calls
// can't clobber each other's read-merge-write.
//
// All handlers reply { ok: true, state } or { ok: false, error }.
(() => {
const core = typeof require === 'function'
    ? require('./task-planner-core')
    : globalThis.TaboxTaskPlannerCore;

const TASK_PLANNER_SESSION_KEY = 'taskPlannerSession';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // fresh-enough session is reused by start
const STALE_THINKING_MS = 120_000;              // 'thinking' older than this is dead (SW discarded)
const PLANNER_GREETING = "Hi! I'm your Tabox planner. Tell me what you'd like to plan or research, and I'll gather the right websites into a tidy collection.";
const THINKING_INTERRUPTED_ERROR = 'Tabox AI was interrupted before it could reply. Please send your message again.';

function localArea() { return (globalThis.browser || globalThis.chrome).storage.local; }
// Lazy so tests (and a future provider swap) can replace the client global.
function client() { return globalThis.TaboxAIClient; }

async function readSession() {
    return (await localArea().get(TASK_PLANNER_SESSION_KEY))[TASK_PLANNER_SESSION_KEY] || null;
}

// Serialized writes: every mutation runs on this chain so concurrent handlers
// (e.g. two removeTab calls, or a send finishing during a removeTab) each see
// the previous write's result. A failed write must not poison the chain for
// later writers, hence the swallowed catch on the stored tail.
let _writeChain = Promise.resolve();
function enqueue(fn) {
    const run = _writeChain.then(fn);
    _writeChain = run.catch(() => {});
    return run;
}

// Read-merge-write a session mutation inside the chain. `mutate(current)`
// returns the next session object, or null/undefined to skip the write (e.g.
// the session was reset while this mutation waited its turn).
function mutateSession(mutate) {
    return enqueue(async () => {
        const cur = await readSession();
        const next = mutate(cur);
        if (!next) return cur;
        await localArea().set({ [TASK_PLANNER_SESSION_KEY]: next });
        return next;
    });
}

// Count of sends THIS worker instance currently has in progress (from before
// their thinking write through settling). If the worker is discarded mid-turn
// (MV3), the counter resets with it — which is exactly the signal that a
// persisted 'thinking' has no owner and must be healed. A counter, not a
// boolean: two overlapping sends must not clear each other's protection.
let _sendsInFlight = 0;

// Heal a 'thinking' session whose owning worker died (no in-flight send in
// this worker) or that has been thinking implausibly long even with a live
// send (hung upstream beyond the client's own 90s deadline).
async function healStaleThinking() {
    const cur = await readSession();
    if (!cur || cur.status !== 'thinking') return cur;
    const age = Date.now() - (cur.updatedAt || 0);
    if (_sendsInFlight > 0 && age <= STALE_THINKING_MS) return cur;
    return mutateSession((s) => {
        if (!s || s.status !== 'thinking') return null; // already moved on
        return { ...s, status: 'error', error: THINKING_INTERRUPTED_ERROR, updatedAt: Date.now() };
    });
}

function errorMessage(error) {
    return (error && error.message) || String(error);
}

async function taskPlannerGetState() {
    try {
        const state = await healStaleThinking();
        return { ok: true, state: state || null };
    } catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}

// Generate suggestion pills from the user's collection summaries, steering
// away from pills the user has already seen (`avoid`) so every batch feels
// fresh. Never throws: any failure (offline, signed out, bad JSON,
// loadSummaries itself throwing) falls back to the static pills.
async function generatePills(loadSummaries, avoid = []) {
    try {
        const summaries = typeof loadSummaries === 'function' ? (await loadSummaries()) || [] : [];
        const content = await client().requestChatCompletion(
            [{ role: 'user', content: core.buildPillsPrompt(summaries, avoid) }],
            // High temperature on purpose: pills are idea generation, and the
            // avoid-list only works if sampling actually explores.
            { temperature: 0.9, responseConstraint: core.PILLS_SCHEMA },
        );
        return core.normalizePills(core.parseJSONContent(content)) || core.FALLBACK_PILLS;
    } catch {
        return core.FALLBACK_PILLS;
    }
}

// Land a freshly generated pill batch on the session (sessionId-guarded) and
// record it in pillsSeen so the next generation avoids repeats.
function landPills(sessionId, pills) {
    return mutateSession((s) => {
        // Reset or replaced while pills were generating — don't adopt.
        if (!s || s.sessionId !== sessionId) return null;
        const seen = [...(s.pillsSeen || []), ...pills].slice(-core.MAX_PILLS_SEEN);
        return { ...s, pills, pillsSeen: seen, updatedAt: Date.now() };
    });
}

// Dedupes concurrent starts (e.g. the popup and full-page view mounting at
// once): while one start is running, later callers share its promise instead
// of minting a second session and paying a second pill AI call.
let _startPromise = null;

// Creates a fresh session (or returns the existing one when it's <24h old and
// `force` isn't set). Pill generation is awaited INSIDE the handler (MV3 — a
// detached timeout could die with the worker); it never produces an error
// state (see generatePills).
function taskPlannerStart(options) {
    if (_startPromise) return _startPromise;
    _startPromise = doTaskPlannerStart(options).finally(() => { _startPromise = null; });
    return _startPromise;
}

async function doTaskPlannerStart({ force = false, loadSummaries } = {}) {
    try {
        const existing = await healStaleThinking();
        if (existing && !force && Date.now() - (existing.createdAt || 0) < SESSION_MAX_AGE_MS) {
            // Conversation already underway — pills are hidden, so reuse as-is.
            const hasUserMessage = (existing.messages || []).some((m) => m.role === 'user');
            if (hasUserMessage) return { ok: true, state: existing };
            // Unused chat: generate a FRESH batch of ideas on every open (and
            // this also heals pills === null from a SW death mid-generation).
            // Flip pills to null first so the panel shows skeletons while the
            // new batch generates.
            await mutateSession((s) => {
                if (!s || s.sessionId !== existing.sessionId || s.pills === null) return null;
                return { ...s, pills: null, updatedAt: Date.now() };
            });
            const pills = await generatePills(loadSummaries, existing.pillsSeen || []);
            const state = await landPills(existing.sessionId, pills);
            return { ok: true, state: state || null };
        }
        const now = Date.now();
        const session = {
            sessionId: core.mintUid(),
            status: 'ready',
            greeting: PLANNER_GREETING,
            pills: null, // null = loading; the popup shows skeleton pills
            pillsSeen: [],
            messages: [],
            groups: [],
            collectionName: '',
            error: null,
            createdAt: now,
            updatedAt: now,
        };
        // The skeleton-session write and the summaries+pills generation are
        // independent — run them concurrently; the pills landing below is
        // chained after the write (and sessionId-guarded) either way.
        const [, pills] = await Promise.all([
            enqueue(async () => {
                await localArea().set({ [TASK_PLANNER_SESSION_KEY]: session });
                return session;
            }),
            generatePills(loadSummaries),
        ]);

        const state = await landPills(session.sessionId, pills);
        return { ok: true, state: state || null };
    } catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}

// Dedupes concurrent refreshes (double-clicks, popup + full-page). Unlike
// start, a refresh during an in-flight refresh just shares the same batch.
let _refreshPromise = null;

// Regenerate the suggestion pills on demand (the panel's reload button).
// Ignored once the conversation has a user message — pills are gone by then.
function taskPlannerRefreshPills(options) {
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = doRefreshPills(options).finally(() => { _refreshPromise = null; });
    return _refreshPromise;
}

async function doRefreshPills({ loadSummaries } = {}) {
    try {
        let sessionId = null;
        let seen = [];
        let ignored = false;
        const flipped = await mutateSession((s) => {
            if (!s) return null;
            if ((s.messages || []).some((m) => m.role === 'user')) {
                ignored = true;
                return null;
            }
            sessionId = s.sessionId;
            seen = s.pillsSeen || [];
            // Skeletons while the new batch generates.
            return { ...s, pills: null, updatedAt: Date.now() };
        });
        if (!sessionId) {
            if (ignored) return { ok: true, state: flipped, ignored: true };
            return { ok: false, error: 'No active planner session. Start a new plan first.' };
        }
        const pills = await generatePills(loadSummaries, seen);
        const state = await landPills(sessionId, pills);
        return { ok: true, state: state || null };
    } catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}

// One chat turn: append the user message, flip to 'thinking', make ONE AI call
// (system prompt carries the full current tab set), normalize, and land the
// assistant message + full replacement groups. The handler awaits everything
// inline. On AI failure the transcript stays intact (status 'error' + message)
// so the user can simply retry. A message that was NOT appended (empty text,
// or a turn already thinking) replies { ok: true, state, ignored: true }.
async function taskPlannerSend({ text } = {}) {
    // Counted from BEFORE the thinking write so healStaleThinking can never
    // kill a turn in the window between the guard check and the write landing.
    _sendsInFlight += 1;
    try {
        const content = typeof text === 'string'
            ? text.trim().slice(0, core.MAX_USER_MESSAGE_CHARS)
            : '';
        const userMessage = { id: core.mintUid(), role: 'user', content, ts: Date.now() };

        // ONE read-merge-write decides the outcome atomically on the write
        // chain — a standalone pre-check would let two rapid sends both pass
        // the thinking guard (TOCTOU). Closure variables carry the verdict.
        let ignored = false;
        let hadSession = false;
        let priorMessages = [];
        const thinking = await mutateSession((s) => {
            if (!s) return null;
            hadSession = true;
            // A turn is already in flight (or the text is empty) — ignore, don't error.
            if (s.status === 'thinking' || !content) {
                ignored = true;
                return null;
            }
            priorMessages = s.messages || [];
            return {
                ...s,
                messages: [...(s.messages || []), userMessage].slice(-core.MAX_STORED_MESSAGES),
                status: 'thinking',
                error: null,
                updatedAt: Date.now(),
            };
        });
        if (!hadSession) return { ok: false, error: 'No active planner session. Start a new plan first.' };
        if (ignored) return { ok: true, state: thinking, ignored: true };
        const sessionId = thinking.sessionId;

        try {
            const messages = [
                { role: 'system', content: core.buildPlannerSystemPrompt({ groups: thinking.groups || [], collectionName: thinking.collectionName || '' }) },
                ...core.windowHistory(priorMessages, core.HISTORY_WINDOW),
                { role: 'user', content },
            ];
            const raw = await client().requestChatCompletion(messages, {
                temperature: 0.7,
                responseConstraint: core.PLANNER_TURN_SCHEMA,
                // Chat turns run the thinking tier: a reasoning pass decomposes
                // the request into facets (lodging, tickets, flights, …) before
                // picking sites. Pills stay on the fast default tier.
                modelTier: 'thinking',
            });
            const turn = core.normalizeTurn(core.parseJSONContent(raw), thinking.groups || []);
            const assistantMessage = { id: core.mintUid(), role: 'assistant', content: turn.reply, ts: Date.now() };
            const state = await mutateSession((s) => {
                // A reset/new-session mid-turn must not adopt the stale result.
                if (!s || s.sessionId !== sessionId) return null;
                return {
                    ...s,
                    messages: [...(s.messages || []), assistantMessage].slice(-core.MAX_STORED_MESSAGES),
                    groups: turn.groups,
                    collectionName: turn.collectionName || s.collectionName || '',
                    status: 'ready',
                    error: null,
                    updatedAt: Date.now(),
                };
            });
            return { ok: true, state };
        } catch (error) {
            const message = errorMessage(error);
            await mutateSession((s) => {
                // A reset/new-session mid-turn must not adopt the stale error.
                if (!s || s.sessionId !== sessionId) return null;
                // Keep the transcript (incl. the just-sent user message) so a retry works.
                return { ...s, status: 'error', error: message, updatedAt: Date.now() };
            });
            return { ok: false, error: message };
        }
    } catch (error) {
        return { ok: false, error: errorMessage(error) };
    } finally {
        _sendsInFlight -= 1;
    }
}

async function taskPlannerRemoveTab({ groupUid, tabUid } = {}) {
    try {
        const state = await mutateSession((s) => {
            if (!s) return null;
            const groups = (s.groups || [])
                .map((g) => (g.uid === groupUid ? { ...g, tabs: (g.tabs || []).filter((t) => t.uid !== tabUid) } : g))
                .filter((g) => (g.tabs || []).length > 0); // dropping the last tab drops the group
            return { ...s, groups, updatedAt: Date.now() };
        });
        if (!state) return { ok: false, error: 'No active planner session.' };
        return { ok: true, state };
    } catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}

async function taskPlannerReset() {
    try {
        await enqueue(async () => {
            await localArea().remove(TASK_PLANNER_SESSION_KEY);
            return null;
        });
        return { ok: true, state: null };
    } catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}

const taskPlannerApi = {
    TASK_PLANNER_SESSION_KEY,
    SESSION_MAX_AGE_MS,
    STALE_THINKING_MS,
    PLANNER_GREETING,
    THINKING_INTERRUPTED_ERROR,
    taskPlannerGetState,
    taskPlannerStart,
    taskPlannerRefreshPills,
    taskPlannerSend,
    taskPlannerRemoveTab,
    taskPlannerReset,
};

/* istanbul ignore next */
if (typeof globalThis !== 'undefined') globalThis.TaboxTaskPlanner = taskPlannerApi;
/* istanbul ignore next */
if (typeof module !== 'undefined' && module.exports) module.exports = taskPlannerApi;
})();
