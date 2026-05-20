/**
 * saasContext.js — Higher-order helpers wrap route handler trong tenant/system ALS context.
 *
 * P09 (#21) regression fix: dashboard routes gọi getSettings() / getAdapter()
 * không có tenant context → P09 guard throw. Wrap handler bằng helper này
 * để đảm bảo có ALS context đúng.
 *
 * Usage:
 *   import { withSystemContext, withTenantContext } from "@/lib/security/saasContext.js";
 *
 *   // Pre-auth route (đọc settings global, KHÔNG cần userId):
 *   async function handleGet(request) { ... }
 *   export const GET = withSystemContext(handleGet);
 *
 *   // Authenticated route (cần userId từ JWT cookie):
 *   async function handleGet(request) { ... }
 *   export const GET = withTenantContext(handleGet);
 *
 * Khi nào dùng cái nào:
 *   - withSystemContext: login, status, oidc/test, csrf-token, health (đọc default adapter / Postgres global)
 *   - withTenantContext: settings, account, providers, keys (đọc/ghi per-user SQLite)
 *
 * Refs: https://github.com/ngapngap/9router/issues/21
 */
import { NextResponse } from "next/server";
import { runAsSystem, runWithTenant, setTenantUserId } from "@/lib/saas/tenantContext.js";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";

/**
 * Wrap handler trong runAsSystem. Cho phép gọi getAdapter() fallback default adapter.
 * Dùng cho pre-auth routes hoặc routes đọc settings global.
 *
 * @param {Function} handler — async (request, ...args) => Response
 * @returns {Function}
 */
export function withSystemContext(handler) {
  return async (request, ...args) => {
    return runAsSystem(() => handler(request, ...args));
  };
}

/**
 * Wrap handler trong runWithTenant(userId từ JWT cookie).
 * Trả 401 nếu không có cookie hợp lệ.
 *
 * @param {Function} handler — async (request, ...args) => Response
 * @returns {Function}
 */
export function withTenantContext(handler) {
  return async (request, ...args) => {
    // Self-host mode: skip tenant context (single-user)
    if (process.env.SAAS_ENABLED !== "true") {
      return handler(request, ...args);
    }

    const token = request.cookies?.get?.("auth_token")?.value;
    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const claims = await getDashboardAuthSession(token);
    if (!claims || !claims.sub) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = Number(claims.sub);
    if (!Number.isFinite(userId) || userId <= 0) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return runWithTenant(() => {
      setTenantUserId(userId);
      return handler(request, ...args);
    });
  };
}
