// chrome/task-planner-core.js
// Pure helpers for the Task Planner chat tool: prompt builders, strict JSON
// schemas, and normalizers. NO storage, NO AI calls, NO extension APIs — the
// stateful session logic lives in chrome/task-planner.js.
//
// The SW loads this via importScripts; tests load it via require().
// Dual-export pattern: globalThis.TaboxTaskPlannerCore + module.exports
// (mirrors chrome/ai-planners.js).
(() => {

// ai-planners.js is a pure dual-export module and the SW loads it via
// importScripts BEFORE this file (see chrome/background.js), so the global is
// always populated by the time this runs.
const planners = typeof require === 'function' ? require('./ai-planners') : globalThis.TaboxAIPlanners;

// The 9 chrome tab-group color names — canonical list lives in ai-planners.js;
// re-exported from this module's API so consumers/tests keep using
// core.GROUP_COLORS.
const GROUP_COLORS = planners.GROUP_COLORS;

// Caps from the design contract (docs/superpowers/specs/2026-08-16-task-planner-design.md §2).
const MAX_GROUPS = 8;
const MAX_TABS = 40;
const MAX_REPLY_CHARS = 400;
const MAX_COLLECTION_NAME = 50;
const MAX_GROUP_TITLE = 40;
const MAX_PILL_CHARS = 30;
const HISTORY_WINDOW = 12;
const MIN_PILLS = 3;
const MAX_PILLS = 5;
// Session-store bounds (enforced in chrome/task-planner.js): user input is
// clamped before storage/prompting, and the stored transcript keeps only the
// most recent messages so the session record can't grow without bound.
const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_STORED_MESSAGES = 50;

// Static fallbacks when pill generation fails (offline, signed out, bad JSON).
const FALLBACK_PILLS = ['Plan a trip', 'Research a topic', 'Learn a new skill', 'Compare products'];

// Shown when the model returns an empty reply — a blank chat bubble is worse
// than a generic one.
const DEFAULT_REPLY = "Here's your updated tab set.";

// Sanctioned duplication of ai-planners' uid minting: kept local so this
// module has no behavioral dependency beyond the GROUP_COLORS constant above.
function mintUid() {
    return (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// JSON schemas (Worker json_schema strict mode: every property required,
// additionalProperties:false)
// ---------------------------------------------------------------------------

// Every turn returns the FULL updated tab set (not a diff) — the schema has no
// room for anything but add/update/remove of tabs, which keeps the "a turn can
// only change the tab set" promise structurally true.
const PLANNER_TURN_SCHEMA = {
    type: 'object',
    properties: {
        reply: { type: 'string', maxLength: MAX_REPLY_CHARS },
        collectionName: { type: 'string', maxLength: MAX_COLLECTION_NAME },
        groups: {
            type: 'array',
            maxItems: MAX_GROUPS,
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string', maxLength: MAX_GROUP_TITLE },
                    color: { type: 'string', enum: GROUP_COLORS },
                    tabs: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string' },
                                url: { type: 'string' },
                            },
                            required: ['title', 'url'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['title', 'color', 'tabs'],
                additionalProperties: false,
            },
        },
    },
    required: ['reply', 'collectionName', 'groups'],
    additionalProperties: false,
};

const PILLS_SCHEMA = {
    type: 'object',
    properties: {
        pills: {
            type: 'array',
            minItems: MIN_PILLS,
            maxItems: MAX_PILLS,
            items: { type: 'string', maxLength: MAX_PILL_CHARS },
        },
    },
    required: ['pills'],
    additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function serializeTabSet(groups) {
    if (!Array.isArray(groups) || groups.length === 0) {
        return '(empty — no tabs collected yet)';
    }
    return groups.map((g) => {
        const tabLines = (g.tabs || []).map((t) => `- ${t.title || t.url} (${t.url})`);
        return `Group "${g.title}" [${g.color}]:\n${tabLines.join('\n')}`;
    }).join('\n\n');
}

// System prompt sent on EVERY turn. The current tab set always rides here, so
// client-side removals persist and windowing the chat history loses nothing.
function buildPlannerSystemPrompt({ groups = [], collectionName = '' } = {}) {
    return [
        'You are the Tabox Task Planner, an assistant inside the Tabox browser extension.',
        'Your ONLY job is to help the user collect and organize websites (browser tabs) for a task or topic they describe, arranged into tab groups.',
        '',
        'Rules:',
        '- Only help with collecting and organizing websites for a topic. If the user asks for anything else (general questions, coding, math, chit-chat), set "reply" to a refusal that starts with "I can only help you collect websites" and return the CURRENT TAB SET below unchanged.',
        '- Every turn, return the FULL updated tab set in "groups": every group and tab that should exist after this turn. A turn may only add, update, or remove tabs and groups — nothing else.',
        '- Only include real, well-known websites with valid http or https URLs you are confident exist. Prefer top-level pages (homepages, section pages) over deep links that may 404.',
        `- Use at most ${MAX_GROUPS} groups and ${MAX_TABS} tabs in total.`,
        `- "reply" is a short conversational message, at most ${MAX_REPLY_CHARS} characters.`,
        `- "collectionName" is a short name for the collection (at most ${MAX_COLLECTION_NAME} characters), kept up to date with the plan.`,
        `- Group colors must be one of: ${GROUP_COLORS.join(', ')}.`,
        '',
        `CURRENT TAB SET (collection name: "${collectionName || 'Untitled'}"):`,
        serializeTabSet(groups),
    ].join('\n');
}

// How many of the user's collection summaries feed the pills prompt.
const PILLS_MAX_COLLECTIONS = 15;

function buildPillsPrompt(summaries = []) {
    const capped = (Array.isArray(summaries) ? summaries : []).slice(0, PILLS_MAX_COLLECTIONS);
    const lines = capped.map((c) => {
        const titles = (c.tabs || []).map((t) => t.title).filter(Boolean).slice(0, 3);
        return `- "${c.name || 'Untitled'}"${titles.length ? ` (e.g. ${titles.join('; ')})` : ''}`;
    });
    return [
        'Suggest quick-start ideas ("pills") for a browser-tab planning assistant. The user taps one to start collecting websites for a task or topic.',
        `Each pill is a short imperative phrase of 2-4 words, at most ${MAX_PILL_CHARS} characters (like "Plan a trip" or "Research a topic").`,
        '',
        lines.length
            ? `The user's saved tab collections, for inspiration (stay generic enough to start something new):\n${lines.join('\n')}`
            : 'The user has no saved collections yet — suggest broadly useful ideas.',
        '',
        `Respond with JSON: { "pills": ["...", ...] } — ${MIN_PILLS} to ${MAX_PILLS} pills.`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function isValidHttpUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Normalize a raw model turn into { reply, collectionName, groups }.
 * - Drops non-http(s)/malformed URLs and dedupes URLs across the whole set.
 * - Coerces invalid colors round-robin (nextColor pattern from ai-planners).
 * - Caps at MAX_GROUPS groups / MAX_TABS tabs total; drops emptied groups.
 * - Preserves existing tab uids by URL match against prevGroups (and group
 *   uids by title match) so the panel doesn't re-animate unchanged items;
 *   mints fresh uids for new tabs/groups.
 * @param {object} raw        - Parsed model output ({ reply, collectionName, groups }).
 * @param {Array}  prevGroups - The session's current groups (uid-carrying).
 */
function normalizeTurn(raw, prevGroups = []) {
    const prevTabUidByUrl = new Map();
    const prevGroupUidByTitle = new Map();
    for (const g of Array.isArray(prevGroups) ? prevGroups : []) {
        const titleKey = String(g.title || '').trim().toLowerCase();
        if (titleKey && !prevGroupUidByTitle.has(titleKey)) prevGroupUidByTitle.set(titleKey, g.uid);
        for (const t of g.tabs || []) {
            if (t.url && !prevTabUidByUrl.has(t.url)) prevTabUidByUrl.set(t.url, t.uid);
        }
    }

    let colorCursor = 0;
    const nextColor = (c) => (GROUP_COLORS.includes(c) ? c : GROUP_COLORS[colorCursor++ % GROUP_COLORS.length]);

    const seenUrls = new Set();
    const usedGroupUids = new Set();
    let tabBudget = MAX_TABS;
    const groups = [];
    const rawGroups = (raw && Array.isArray(raw.groups)) ? raw.groups.slice(0, MAX_GROUPS) : [];
    for (const g of rawGroups) {
        if (tabBudget <= 0) break;
        const title = String((g && g.title) || 'Group').trim().slice(0, MAX_GROUP_TITLE) || 'Group';
        const tabs = [];
        for (const t of (g && Array.isArray(g.tabs)) ? g.tabs : []) {
            if (tabBudget <= 0) break;
            const url = t && typeof t.url === 'string' ? t.url.trim() : '';
            if (!isValidHttpUrl(url) || seenUrls.has(url)) continue;
            seenUrls.add(url);
            tabBudget -= 1;
            let title2;
            try { title2 = String((t.title || '')).trim() || new URL(url).hostname.replace(/^www\./, ''); } catch { title2 = url; }
            tabs.push({ uid: prevTabUidByUrl.get(url) || mintUid(), title: title2, url });
        }
        if (tabs.length === 0) continue; // group emptied by URL filtering — drop it
        const titleKey = title.toLowerCase();
        let uid = prevGroupUidByTitle.get(titleKey);
        if (!uid || usedGroupUids.has(uid)) uid = mintUid();
        usedGroupUids.add(uid);
        groups.push({ uid, title, color: nextColor(g && g.color), tabs });
    }

    const reply = String((raw && raw.reply) || '').trim().slice(0, MAX_REPLY_CHARS) || DEFAULT_REPLY;
    const collectionName = String((raw && raw.collectionName) || '').trim().slice(0, MAX_COLLECTION_NAME);
    return { reply, collectionName, groups };
}

// Windowed chat history: the last `max` display messages, projected to the
// { role, content } shape the Worker accepts. The current tab set rides in the
// system prompt, so dropping old turns loses nothing structural.
function windowHistory(messages, max = HISTORY_WINDOW) {
    return (Array.isArray(messages) ? messages : [])
        .slice(-max)
        .map((m) => ({ role: m.role, content: m.content }));
}

// Returns 3-5 cleaned pill strings, or null when the raw output is unusable
// (caller falls back to FALLBACK_PILLS).
function normalizePills(raw) {
    const arr = raw && Array.isArray(raw.pills) ? raw.pills : null;
    if (!arr) return null;
    const seen = new Set();
    const pills = [];
    for (const p of arr) {
        const pill = String(p || '').trim().slice(0, MAX_PILL_CHARS);
        const key = pill.toLowerCase();
        if (!pill || seen.has(key)) continue;
        seen.add(key);
        pills.push(pill);
        if (pills.length === MAX_PILLS) break;
    }
    return pills.length >= MIN_PILLS ? pills : null;
}

// Models occasionally wrap JSON in a markdown fence even under json_schema.
// Sanctioned duplication of app/ai/aiClient.js parseJSONContent — kept local
// so this SW-side module stays import-free of popup code.
function parseJSONContent(raw) {
    const trimmed = String(raw).trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return JSON.parse(fenced ? fenced[1] : trimmed);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const taskPlannerCoreApi = {
    GROUP_COLORS,
    MAX_GROUPS,
    MAX_TABS,
    MAX_REPLY_CHARS,
    MAX_COLLECTION_NAME,
    MAX_GROUP_TITLE,
    MAX_PILL_CHARS,
    HISTORY_WINDOW,
    MIN_PILLS,
    MAX_PILLS,
    MAX_USER_MESSAGE_CHARS,
    MAX_STORED_MESSAGES,
    PILLS_MAX_COLLECTIONS,
    FALLBACK_PILLS,
    DEFAULT_REPLY,
    PLANNER_TURN_SCHEMA,
    PILLS_SCHEMA,
    buildPlannerSystemPrompt,
    buildPillsPrompt,
    normalizeTurn,
    windowHistory,
    normalizePills,
    parseJSONContent,
    mintUid,
};

/* istanbul ignore next */
if (typeof globalThis !== 'undefined') globalThis.TaboxTaskPlannerCore = taskPlannerCoreApi;
/* istanbul ignore next */
if (typeof module !== 'undefined' && module.exports) module.exports = taskPlannerCoreApi;

})();
