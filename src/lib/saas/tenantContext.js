import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

/** @returns {{ userId: number | null } | undefined} */
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
