-- Per-request AI usage log for the War Room dashboard ("Tabox AI usage by
-- action type"). One row per successful /ai/complete call. No prompt content
-- is stored — only the client-declared action slug, the caller's googleId,
-- and a timestamp (epoch ms). Written fire-and-forget via ctx.waitUntil so it
-- can never delay or fail a completion.
CREATE TABLE ai_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  google_id  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_usage_created_at ON ai_usage(created_at);
CREATE INDEX ai_usage_action_created_at ON ai_usage(action, created_at);
