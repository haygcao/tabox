// URL reachability validator for AI-suggested tabs: the Task Planner asks the
// Worker to probe each freshly suggested URL so hallucinated 404s never reach
// the user. Same style as aiProxy.js — a validate step that rebuilds the
// request from an allowlist, then a do step that talks to the network — both
// exported for tests. The route handler in index.js stays thin.
//
// Verdicts fail OPEN on ambiguity: a slow site or a bot-walled site loads
// fine in the user's real browser, so only clear negatives (HTTP >= 400 other
// than auth/bot statuses, or a connection-level failure like NXDOMAIN — the
// hallucinated-domain case) mark a URL unreachable.
export const MAX_URLS_PER_REQUEST = 20;
export const MAX_URL_CHARS = 2048;
const FETCH_TIMEOUT_MS = 5000;
// A browsery UA: some sites 403 obviously non-browser agents outright, which
// would skew verdicts for pages that load fine in the extension's browser.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// Statuses that mean "the site exists but gated the probe": auth walls (401,
// 403), method not allowed even after the GET retry (405), and rate limiting
// (429). All of these load fine in a real browser — verdict ok.
const GATED_OK_STATUSES = new Set([401, 403, 405, 429]);

// Validates { urls: string[] } — 1..MAX_URLS_PER_REQUEST entries, each a
// string of at most MAX_URL_CHARS parsing as an http/https URL.
export function validateUrlsRequest(body) {
  const invalid = { ok: false, error: 'invalid_urls' };
  if (!body || typeof body !== 'object' || !Array.isArray(body.urls)) return invalid;
  const { urls } = body;
  if (urls.length < 1 || urls.length > MAX_URLS_PER_REQUEST) return invalid;
  for (const url of urls) {
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS) return invalid;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return invalid;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return invalid;
  }
  return { ok: true, urls: urls.slice() };
}

// One probe: fetch with a hard deadline, following redirects. Returns
// { status } on any HTTP response, { timedOut: true } when OUR abort fired
// (slow, not dead), or { failed: true } on a connection-level error
// (DNS/refused/TLS — the hallucinated-domain case).
async function probe(url, method, fetchImpl) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method,
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA },
      signal: controller.signal,
    });
    // GET bodies are only fetched to read the status — cancel so the Worker
    // never streams a page it doesn't need.
    if (method === 'GET') {
      try { res.body?.cancel?.(); } catch { /* already consumed/locked — fine */ }
    }
    return { status: res.status };
  } catch {
    return timedOut ? { timedOut: true } : { failed: true };
  } finally {
    clearTimeout(timer);
  }
}

async function checkUrl(url, fetchImpl) {
  let result = await probe(url, 'HEAD', fetchImpl);
  // HEAD unsupported (405/501) — retry once as GET with the same deadline.
  if (result.status === 405 || result.status === 501) {
    result = await probe(url, 'GET', fetchImpl);
  }
  if (result.timedOut) return { url, ok: true, status: -1 }; // slow ≠ dead; fail open
  if (result.failed) return { url, ok: false, status: 0 };   // DNS/conn/TLS failure
  const { status } = result;
  return { url, ok: status < 400 || GATED_OK_STATUSES.has(status), status };
}

// Probes every URL concurrently — the Workers runtime queues past its 6
// simultaneous-connection cap automatically, so a flat Promise.all is safe.
export function checkUrls(urls, fetchImpl = fetch) {
  return Promise.all(urls.map((url) => checkUrl(url, fetchImpl)));
}
