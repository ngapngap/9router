/**
 * csrfToken.js — Double-submit cookie CSRF protection.
 *
 * P12 (#24) MED-3:
 *   - Generate: random token → set cookie `csrf-token` (non-HttpOnly, SameSite=Strict).
 *   - Verify: compare cookie value vs header `X-CSRF-Token`.
 *   - Bypass: /api/v1/* (Bearer auth, no cookie), /api/auth/* (login flow).
 *
 * Refs: https://github.com/ngapngap/9router/issues/24
 */
import crypto from "node:crypto";

const CSRF_COOKIE = "csrf-token";
const CSRF_HEADER = "x-csrf-token";
const TOKEN_LENGTH = 32;

// Paths that bypass CSRF (Bearer-only or auth flow)
const BYPASS_PREFIXES = ["/api/v1/", "/api/v1beta/", "/api/auth/", "/api/health"];

/**
 * Generate CSRF token.
 * @returns {string}
 */
export function generateCsrfToken() {
  return crypto.randomBytes(TOKEN_LENGTH).toString("hex");
}

/**
 * Check if request path should bypass CSRF.
 * @param {string} pathname
 * @returns {boolean}
 */
export function shouldBypassCsrf(pathname) {
  return BYPASS_PREFIXES.some(p => pathname.startsWith(p));
}

/**
 * Verify CSRF token from request.
 * @param {Request} request
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyCsrfToken(request) {
  const method = request.method?.toUpperCase();
  // Only check mutation methods
  if (!["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
    return { valid: true };
  }

  const url = new URL(request.url);
  if (shouldBypassCsrf(url.pathname)) {
    return { valid: true };
  }

  // Check if CSRF protection is enabled
  if (process.env.CSRF_PROTECTION_ENABLED === "false") {
    return { valid: true };
  }

  // Get token from cookie
  const cookieHeader = request.headers.get("cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map(c => c.trim().split("=").map(s => s.trim()))
  );
  const cookieToken = cookies[CSRF_COOKIE];

  // Get token from header
  const headerToken = request.headers.get(CSRF_HEADER);

  if (!cookieToken || !headerToken) {
    return { valid: false, reason: "missing CSRF token" };
  }

  if (cookieToken !== headerToken) {
    return { valid: false, reason: "CSRF token mismatch" };
  }

  return { valid: true };
}
