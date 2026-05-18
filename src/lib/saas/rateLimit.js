/** In-memory rate limiter per IP — simple counter, no external dependency. */
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 5;
const store = new Map();

function pruneStore() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.start > WINDOW_MS * 2) store.delete(key);
  }
}

setInterval(pruneStore, WINDOW_MS * 2).unref?.();

/**
 * @param {string} ip
 * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
 */
export function checkRateLimit(ip) {
  const now = Date.now();
  let entry = store.get(ip);

  if (!entry || now - entry.start > WINDOW_MS) {
    entry = { start: now, count: 1 };
    store.set(ip, entry);
    return { allowed: true, remaining: MAX_REQUESTS - 1, resetMs: entry.start + WINDOW_MS };
  }

  entry.count++;
  if (entry.count > MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetMs: entry.start + WINDOW_MS };
  }

  return { allowed: true, remaining: MAX_REQUESTS - entry.count, resetMs: entry.start + WINDOW_MS };
}
