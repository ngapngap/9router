/**
 * rateLimit.js — Rate limiter keyed by (userId, ip, route).
 *
 * P09 (#21): Trước đây keyed by IP only — 2 user cùng NAT bị nhiễu, đổi IP bypass.
 * Giờ key = `${userId ?? "anon"}|${ip}|${route ?? "*"}`.
 *
 * Backward compat: gọi checkRateLimit("1.2.3.4") (string) vẫn hoạt động
 * (coerce thành { ip: "1.2.3.4" }).
 *
 * Refs: https://github.com/ngapngap/9router/issues/21
 */

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

/**
 * Check rate limit.
 *
 * @param {string|{userId?: string|number, ip: string, route?: string}} arg
 *   - String: backward compat, treated as IP.
 *   - Object: full key {userId, ip, route}.
 * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
 */
export function checkRateLimit(arg) {
  let userId = null, ip = "unknown", route = "*";
  if (typeof arg === "string") {
    ip = arg;
  } else if (arg && typeof arg === "object") {
    userId = arg.userId ?? null;
    ip = arg.ip ?? "unknown";
    route = arg.route ?? "*";
  }
  const key = `${userId ?? "anon"}|${ip}|${route}`;

  const now = Date.now();
  let entry = store.get(key);

  if (!entry || now - entry.start > WINDOW_MS) {
    entry = { start: now, count: 1 };
    store.set(key, entry);
    return { allowed: true, remaining: MAX_REQUESTS - 1, resetMs: entry.start + WINDOW_MS };
  }

  entry.count++;
  if (entry.count > MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetMs: entry.start + WINDOW_MS };
  }

  return { allowed: true, remaining: MAX_REQUESTS - entry.count, resetMs: entry.start + WINDOW_MS };
}
