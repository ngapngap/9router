/**
 * tenantCache.js — Per-tenant Map helper cho open-sse caches.
 *
 * Pattern: thay vì module-level `const cache = new Map()` (shared cross-tenant),
 * dùng `getTenantScopedCache(scope, userId)` để lấy Map riêng cho từng userId.
 *
 * Helper tự cleanup tenant entries không dùng > TTL (mặc định 1h) để tránh leak memory.
 *
 * Usage:
 *   import { getTenantScopedCache } from "../utils/tenantCache.js";
 *   const cache = getTenantScopedCache("combo-rotation", userId);
 *   cache.set(key, value);
 *
 * Reference: https://github.com/ngapngap/9router/issues/21
 *
 * @module open-sse/utils/tenantCache
 */

import { getTenantUserId } from "@/lib/saas/tenantContext.js";

const TTL_MS = 60 * 60 * 1000; // 1h
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5min

// scope -> Map<userId, { cache: Map, lastAccess: number }>
const scopedStore = new Map();

/**
 * Lấy (hoặc tạo) Map cache riêng cho cặp (scope, userId).
 *
 * @param {string} scope — Tên scope (vd "combo-rotation", "project-id").
 * @param {number|string|null} [userId] — userId. Nếu null/undefined, đọc từ ALS context.
 * @returns {Map} Cache map riêng cho (scope, userId).
 * @throws {Error} Nếu userId không xác định được (không có trong context).
 */
export function getTenantScopedCache(scope, userId) {
  const uid = userId ?? getTenantUserId();
  if (uid == null) {
    throw new Error(`tenantCache: missing userId for scope "${scope}"`);
  }
  let perScope = scopedStore.get(scope);
  if (!perScope) {
    perScope = new Map();
    scopedStore.set(scope, perScope);
  }
  let entry = perScope.get(uid);
  if (!entry) {
    entry = { cache: new Map(), lastAccess: Date.now() };
    perScope.set(uid, entry);
  } else {
    entry.lastAccess = Date.now();
  }
  return entry.cache;
}

/**
 * Xóa entries cache > TTL_MS không dùng. Chạy tự động qua setInterval.
 * Export để test có thể trigger manual.
 *
 * @returns {number} Số entry đã xóa.
 */
export function sweepIdleTenantCaches() {
  const now = Date.now();
  let removed = 0;
  for (const [, perScope] of scopedStore) {
    for (const [uid, entry] of perScope) {
      if (now - entry.lastAccess > TTL_MS) {
        perScope.delete(uid);
        removed++;
      }
    }
  }
  return removed;
}

// Auto-sweep mỗi 5 phút (chỉ trong runtime, không trong test).
if (process.env.NODE_ENV !== "test") {
  setInterval(sweepIdleTenantCaches, CLEANUP_INTERVAL_MS).unref();
}
