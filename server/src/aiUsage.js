// AI usage recording: one D1 row per successful /ai/complete, keyed by the
// client-declared `action` slug. Feeds the War Room "AI usage by action type"
// chart. Deliberately minimal and defensive — nothing here may ever affect the
// completion response: the write runs in ctx.waitUntil and swallows errors.

// Slug rules: lowercase letters, digits, '-' / '_' ; 1..40 chars. Anything
// else (missing, wrong type, odd characters, too long) collapses to 'unknown'
// so a malformed or hostile client can't write junk labels into the table.
const ACTION_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const UNKNOWN_ACTION = 'unknown';

export function normalizeAction(value) {
  if (typeof value !== 'string') return UNKNOWN_ACTION;
  const slug = value.trim().toLowerCase();
  return ACTION_RE.test(slug) ? slug : UNKNOWN_ACTION;
}

// Returns a promise that always resolves (never rejects). Safe to pass to
// ctx.waitUntil or to ignore entirely.
export async function recordAIUsage(db, { action, googleId, now = Date.now() }) {
  if (!db || typeof db.prepare !== 'function') return false;
  try {
    await db
      .prepare('INSERT INTO ai_usage (action, google_id, created_at) VALUES (?1, ?2, ?3)')
      .bind(normalizeAction(action), googleId ? String(googleId) : null, now)
      .run();
    return true;
  } catch (err) {
    // Missing table (migration not yet applied), D1 hiccup, etc. — log and
    // move on; the user's completion already succeeded.
    console.warn('ai usage: record failed', { message: err && err.message });
    return false;
  }
}
