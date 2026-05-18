import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

async function hasValidCliToken(request) {
  const token = request.headers.get(CLI_TOKEN_HEADER);
  if (!token) return false;
  return token === await getCliToken();
}

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
];

// Require auth, but allow through if requireLogin is disabled
const PROTECTED_API_PATHS = [
  "/api/settings",
  "/api/keys",
  "/api/providers/client",
  "/api/provider-nodes/validate",
];

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false) return true;
  return false;
}

function isPublicSaasApiPath(pathname) {
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname.startsWith("/api/v1/")) return true;
  if (pathname === "/api/health" || pathname.startsWith("/api/health/")) return true;
  if (pathname === "/api/saas/config" || pathname.startsWith("/api/saas/config/")) return true;
  return false;
}

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  if (process.env.SAAS_ENABLED === "true" && pathname.startsWith("/api/") && !isPublicSaasApiPath(pathname)) {
    const cliTok = process.env.CLI_TOKEN_9R?.trim();
    if (cliTok && request.headers.get(CLI_TOKEN_HEADER) === cliTok) {
      return NextResponse.next();
    }
    const token = request.cookies.get("auth_token")?.value;
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await verifyDashboardAuthToken(token))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Always protected - require valid JWT or local CLI token (machineId-based)
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if (await hasValidCliToken(request) || await hasValidToken(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect sensitive API endpoints (allow CLI token, JWT, or requireLogin=false)
  if (PROTECTED_API_PATHS.some((p) => pathname.startsWith(p))) {
    if (pathname === "/api/settings/require-login") return NextResponse.next();
    if (await hasValidCliToken(request) || await isAuthenticated(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    // SaaS mode: luôn yêu cầu JWT login cho dashboard — không phụ thuộc settings.requireLogin
    if (process.env.SAAS_ENABLED === "true") {
      const token = request.cookies.get("auth_token")?.value;
      if (token && await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      }
      return NextResponse.redirect(new URL("/login", request.url));
    }

    // Self-host mode: logic cũ giữ nguyên
    let requireLogin = true;
    let tunnelDashboardAccess = true;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled (redirect to login)
        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
          const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }

    // If login not required, allow through
    if (!requireLogin) return NextResponse.next();

    // Verify JWT token
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      if (await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      } else {
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to /dashboard if logged in, or /dashboard if it's the root
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/dashboard/:path*",
    "/api/:path*",
  ],
};

