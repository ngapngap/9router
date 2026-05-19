/**
 * tenantContext.js — AsyncLocalStorage-based tenant context for SaaS mode.
 *
 * Exports:
 *   - runWithTenant(fn)          — chạy fn trong context user (existing)
 *   - getTenantStore()           — lấy raw ALS store (existing)
 *   - getTenantUserId()          — lấy userId từ context (existing)
 *   - setTenantUserId(userId)    — set userId vào context hiện tại (existing)
 *   - runAsSystem(fn)            — NEW (P09 #21): chạy fn ngoài tenant context, đánh dấu __system
 *   - isSystemContext()          — NEW (P09 #21): true nếu đang trong runAsSystem block
 *
 * `runAsSystem` dùng cho startup hooks / cron / migration mà không thuộc về user nào.
 * Các caller hợp lệ: initCloudSync, db/migrate, initializeApp, initOutboundProxy,
 * oauth/services refresh, tunnel, projectId._cleanupTimer, tokenRefresh setInterval.
 *
 * Reference: https://github.com/ngapngap/9router/issues/21
 */

import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/** @returns {{ userId: number | null, __system?: boolean } | undefined} */
export function getTenantStore() {
  return als.getStore();
}

/** @param {number} userId New-API users.id */
export function setTenantUserId(userId) {
  const s = als.getStore();
  if (s) s.userId = userId;
}

export function getTenantUserId() {
  const id = als.getStore()?.userId;
  return id == null ? null : id;
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runWithTenant(fn) {
  return als.run({ userId: null }, fn);
}

/**
 * Chạy `fn` trong context system (ngoài tenant). Store mang cờ `__system: true`
 * và `userId: null` để các consumer phân biệt với tenant context thật. Dùng cho
 * startup hooks / cron / migrations / background refresh không thuộc về user nào.
 *
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {T | Promise<T>}
 */
export function runAsSystem(fn) {
  return als.run({ userId: null, __system: true }, fn);
}

/**
 * Trả về `true` nếu code hiện đang chạy bên trong một block `runAsSystem`.
 * Dùng để cho phép caller hợp lệ bypass kiểm tra tenant userId.
 *
 * @returns {boolean}
 */
export function isSystemContext() {
  const store = als.getStore();
  return Boolean(store && store.__system === true);
}
