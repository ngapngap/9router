const WINDOW_MS = 60_000;
const MAX_REQUESTS = 5;
const store = new Map();

function pruneStore() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.start > WINDOW_MS * 2) store.delete(key);
  }
}

if (typeof setInterval !== "undefined") {
  const timer = setInterval(pruneStore, WINDOW_MS * 2);
  if (timer?.unref) timer.unref();
}

export function createRateLimiter({ windowMs = WINDOW_MS, maxRequests = MAX_REQUESTS } = {}) {
  const localStore = new Map();

  return function checkLimit(key) {
    const now = Date.now();
    let entry = localStore.get(key);

    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 1 };
      localStore.set(key, entry);
      return { allowed: true, remaining: maxRequests - 1, resetMs: entry.start + windowMs };
    }

    entry.count++;
    if (entry.count > maxRequests) {
      return { allowed: false, remaining: 0, resetMs: entry.start + windowMs };
    }

    return { allowed: true, remaining: maxRequests - entry.count, resetMs: entry.start + windowMs };
  };
}

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
