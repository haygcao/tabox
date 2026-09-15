/* eslint-disable no-undef */
// chrome/ai-client.js
// Service-worker AI client. All inference goes through the Tabox Worker's
// POST /ai/complete proxy (OpenRouter; model pinned server-side in
// server/src/aiProxy.js, currently google/gemini-3.5-flash-lite) so the OpenRouter
// API key never ships in the extension — the Worker holds it as a secret and
// authenticates callers by their Google token. The popup's app/ai/aiClient.js
// relays through here via the `aiComplete` message; keep the session/prompt
// interface of the two in sync.
//
// Loaded via importScripts in background.js after background-utils.js
// (getAuthToken) and pro-config.js (PRO_API_BASE); the require/globalThis
// guards let Jest pull it in directly (mirrors chrome/shared-folders.js).
(() => {
const aiClientBgUtils = typeof require === 'function'
    ? require('./background-utils')
    : globalThis.TaboxBackgroundUtils;
const AI_API_BASE = typeof require === 'function'
    ? require('./pro-config').PRO_API_BASE
    : PRO_API_BASE;

// Returns: 'available' | 'sign-in-required'
async function aiAvailability() {
    try {
        const token = await aiClientBgUtils.getAuthTokenForAI();
        return token ? 'available' : 'sign-in-required';
    } catch {
        return 'sign-in-required';
    }
}

// Sessions are stateless request builders: each prompt sends only the system
// prompt + that prompt (no accumulated context), so repeated prompts on one
// session don't get slower or costlier over a long run.
// `action` is a short slug naming the feature making the call (e.g.
// 'auto-rename'); the Worker records it for usage analytics only — it never
// changes the model or the prompt. Omit it and the Worker logs 'unknown'.
async function createAISession({ systemPrompt, temperature, topK, signal, action } = {}) {
    // Prefetch/refresh the auth token so the first prompt doesn't pay for it.
    aiClientBgUtils.getAuthTokenForAI().catch(() => {});
    return {
        prompt: (text, options = {}) => requestCompletion(
            { systemPrompt, temperature, topK, action },
            text,
            { ...options, signal: options.signal || signal },
        ),
        clone: () => createAISession({ systemPrompt, temperature, topK, signal, action }),
        destroy: () => {},
    };
}

async function promptForJSON(session, prompt, schema, signal) {
    const options = { responseConstraint: schema };
    if (signal) options.signal = signal;
    const startedAt = Date.now();
    const raw = await session.prompt(prompt, options);
    console.debug(`Tabox AI: inference ${Date.now() - startedAt}ms`);
    return parseJSONContent(raw);
}

// Hard per-request deadline. Without one, a stalled upstream (Worker or
// OpenRouter) hangs its fetch forever and freezes the whole task's progress —
// tasks can only observe failures between requests. A timeout turns the hang
// into a normal per-item error (rename skip / split Misc sweep). Generous vs
// observed inference times (a few seconds) so it never clips a slow-but-live
// completion.
const AI_REQUEST_TIMEOUT_MS = 90_000;

async function requestCompletion(config, text, { responseConstraint, signal } = {}) {
    const messages = [];
    if (config.systemPrompt) messages.push({ role: 'system', content: config.systemPrompt });
    messages.push({ role: 'user', content: text });
    return performCompletionRequest(messages, {
        temperature: config.temperature,
        topK: config.topK,
        responseConstraint,
        signal,
        action: config.action,
    });
}

// The Worker's /ai/complete caps a request at 32 messages (system + windowed
// chat history). Callers window their history; this guard turns an overflow
// into a clear client-side error instead of a Worker 400.
const MAX_CHAT_MESSAGES = 32;

// Multi-turn chat completion: accepts a FULL messages array (system/user/
// assistant roles — the Worker accepts assistant since the Task Planner
// change). One-shot prompts should keep using sessions/requestCompletion.
async function requestChatCompletion(messages, { temperature, topK, responseConstraint, signal, modelTier, action } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('Tabox AI: no messages to send');
    if (messages.length > MAX_CHAT_MESSAGES) throw new Error(`Tabox AI: too many messages (max ${MAX_CHAT_MESSAGES})`);
    // Project to the exact wire shape so stray fields (ids, timestamps) from
    // stored transcripts never reach the Worker's strict validator.
    const wireMessages = messages.map((m) => ({ role: m.role, content: m.content }));
    return performCompletionRequest(wireMessages, { temperature, topK, responseConstraint, signal, modelTier, action });
}

async function performCompletionRequest(messages, { temperature, topK, responseConstraint, signal, modelTier, action } = {}) {
    const token = await aiClientBgUtils.getAuthTokenForAI();
    if (!token) throw new Error('Tabox AI: sign in to Tabox to use AI features');
    // One internal controller drives the fetch; the caller's signal and the
    // deadline both funnel into it. Manual wiring (no AbortSignal.timeout/any —
    // Chrome 89 baseline). `timedOut` disambiguates the two abort sources so a
    // deadline surfaces as TimeoutError (per-item failure), never as AbortError
    // (which tasks treat as cancellation).
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, AI_REQUEST_TIMEOUT_MS);
    const body = { messages };
    // Tier NAME only — the Worker maps it to a pinned model ('thinking' runs a
    // reasoning pass; used by Task Planner chat turns).
    if (modelTier !== undefined) body.model_tier = modelTier;
    // Usage-analytics label only (see createAISession).
    if (typeof action === 'string' && action) body.action = action;
    if (temperature !== undefined) body.temperature = temperature;
    if (topK !== undefined) body.top_k = topK;
    if (responseConstraint) {
        body.response_format = {
            type: 'json_schema',
            json_schema: { name: 'response', strict: true, schema: responseConstraint },
        };
    }
    let response;
    try {
        response = await fetch(`${AI_API_BASE}/ai/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        if (timedOut) {
            const e = new Error(`Tabox AI: request timed out after ${AI_REQUEST_TIMEOUT_MS / 1000}s`);
            e.name = 'TimeoutError';
            throw e;
        }
        throw err;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 403 && data.error === 'pro_required') {
            // The Worker says entitlement is gone (expired trial, cancellation)
            // while the popup's cached record may still say Pro for up to 24h.
            // Refresh the cache in the background: the storage.local write flips
            // isPro in any open popup (usePremiumEntitlement's onChanged
            // listener), swapping the tool panel for the upsell. Fire-and-forget
            // so a slow refresh can't delay the error surfacing.
            try { Promise.resolve(globalThis.refreshProEntitlement?.()).catch(() => {}); } catch { /* no-op */ }
            const proError = new Error('Tabox AI requires Tabox Pro. Upgrade to keep using AI tools.');
            proError.code = 'pro_required';
            throw proError;
        }
        throw new Error(`Tabox AI: request failed (${response.status}): ${data.error || 'request_failed'}`);
    }
    if (typeof data.content !== 'string' || !data.content) throw new Error('Tabox AI: empty completion');
    return data.content;
}

// The Worker's /ai/validate-urls caps a request at 20 urls; larger sets are
// sent as sequential chunks. 30s per chunk is generous: the Worker itself
// gives each probe a 5s deadline and runs them concurrently.
const VALIDATE_URLS_CHUNK = 20;
const VALIDATE_URLS_TIMEOUT_MS = 30_000;

// Check reachability of AI-suggested URLs via the Worker's POST
// /ai/validate-urls. Returns the concatenated per-url verdicts
// [{ url, ok, status }]. Throws on missing token / non-OK / malformed reply —
// callers treat ANY throw as fail-open (keep all tabs), so validator downtime
// never breaks the feature that called it.
async function validateUrls(urls) {
    const token = await aiClientBgUtils.getAuthTokenForAI();
    if (!token) throw new Error('Tabox AI: sign in to Tabox to use AI features');
    const list = Array.isArray(urls) ? urls : [];
    const results = [];
    for (let i = 0; i < list.length; i += VALIDATE_URLS_CHUNK) {
        const chunk = list.slice(i, i + VALIDATE_URLS_CHUNK);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), VALIDATE_URLS_TIMEOUT_MS);
        let response;
        try {
            response = await fetch(`${AI_API_BASE}/ai/validate-urls`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ urls: chunk }),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(`Tabox AI: URL validation failed (${response.status}): ${data.error || 'request_failed'}`);
        }
        if (!Array.isArray(data.results)) throw new Error('Tabox AI: URL validation returned a malformed reply');
        results.push(...data.results);
    }
    return results;
}

// Models occasionally wrap JSON in a markdown fence even under json_schema.
function parseJSONContent(raw) {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return JSON.parse(fenced ? fenced[1] : trimmed);
}

const aiClientApi = { aiAvailability, createAISession, promptForJSON, requestChatCompletion, validateUrls };

/* istanbul ignore next */
if (typeof globalThis !== 'undefined') globalThis.TaboxAIClient = aiClientApi;
/* istanbul ignore next */
if (typeof module !== 'undefined' && module.exports) module.exports = aiClientApi;
})();
