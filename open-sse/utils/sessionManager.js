/**
 * Session Manager for Antigravity Cloud Code
 *
 * Handles session ID generation and caching for prompt caching continuity.
 * Mimics the Antigravity binary behavior: generates a session ID at startup
 * and keeps it for the process lifetime, scoped per account/connection.
 *
 * P09 (#21): runtimeSessionStore scoped per-tenant qua tenantCache helper.
 * Cleanup tự động qua sweepIdleTenantCaches (tenantCache.js, 5min interval).
 *
 * Reference: antigravity-claude-proxy/src/cloudcode/session-manager.js
 */

import crypto from "crypto";
import { getTenantScopedCache } from "./tenantCache.js";
import { getTenantUserId } from "@/lib/saas/tenantContext.js";

/**
 * Get the tenant-scoped session store for a given userId.
 * @param {number|string|null} [userId] — nếu null, đọc từ ALS context.
 * @returns {Map}
 */
function getSessionStore(userId) {
  return getTenantScopedCache("session-manager", userId ?? getTenantUserId());
}

/**
 * Get or create a session ID for the given connection.
 *
 * The binary generates a session ID once at startup: `rs() + Date.now()`.
 * Since 9router is long-running, we simulate this "per-launch" behavior by
 * storing a generated ID in memory for each connection.
 *
 * - If 9router restarts, the ID changes (matching binary restart behavior).
 * - Within a running instance, the ID is stable for that connection.
 * - This enables prompt caching while using the EXACT random logic of the binary.
 *
 * @param {string} connectionId - The connection identifier (email or unique ID)
 * @param {number|string|null} [userId] - userId for tenant scoping (optional, falls back to ALS context)
 * @returns {string} A stable session ID string matching binary format
 */
export function deriveSessionId(connectionId, userId) {
    if (!connectionId) {
        return generateBinaryStyleId();
    }

    const store = getSessionStore(userId);

    const existing = store.get(connectionId);
    if (existing) {
        existing.lastUsed = Date.now();
        return existing.sessionId;
    }

    // Evict oldest entry if store exceeds max size (safety cap between cleanup cycles)
    const MAX_SESSIONS = 1000;
    if (store.size >= MAX_SESSIONS) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }

    const sessionId = generateBinaryStyleId();
    store.set(connectionId, { sessionId, lastUsed: Date.now() });
    return sessionId;
}

/**
 * Generate a Session ID using the binary's exact logic.
 * Format: `rs() + Date.now()` where `rs()` is randomUUID
 *
 * @returns {string} A session ID in binary format
 */
export function generateBinaryStyleId() {
    return crypto.randomUUID() + Date.now().toString();
}

/**
 * Clears all session IDs for the current tenant (e.g. useful for testing or explicit reset)
 * @param {number|string|null} [userId] - userId for tenant scoping (optional)
 */
export function clearSessionStore(userId) {
    getSessionStore(userId).clear();
}
