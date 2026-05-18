import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSaasDatabaseConfigured } from "@/lib/saas/pgPool.js";
import { findUserForLogin } from "@/lib/saas/usersRepo.js";
import { verifyPassword } from "@/lib/saas/password.js";
import { computeIsAdmin } from "@/lib/saas/adminPolicy.js";
import { checkRateLimit } from "@/lib/saas/rateLimit.js";

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

/**
 * @param {object} row
 */
function normalizeUserId(row) {
  const n = Number(row.id);
  return Number.isFinite(n) ? n : null;
}

async function handleSaasLogin(request, body) {
  if (!isSaasDatabaseConfigured()) {
    return NextResponse.json({ error: "SaaS database not configured" }, { status: 503 });
  }

  const settings = await getSettings();

  if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
    return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
  }

  if (settings.authMode === "oidc" && isOidcConfigured(settings)) {
    return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
  }

  const identifier = typeof body.identifier === "string" ? body.identifier.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!identifier || !password) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const user = await findUserForLogin(identifier);
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const valid = await verifyPassword(password, user.password);
  if (!valid) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const userId = normalizeUserId(user);
  if (userId === null) {
    return NextResponse.json({ error: "Invalid account" }, { status: 401 });
  }

  const cookieStore = await cookies();
  await setDashboardAuthCookie(cookieStore, request, {
    sub: String(userId),
    userId,
    isAdmin: computeIsAdmin(user),
    saas: true,
  });

  return NextResponse.json({ success: true });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));

  if (process.env.SAAS_ENABLED === "true") {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetMs - Date.now()) / 1000)) } });
    }
    return await handleSaasLogin(request, body);
  }

    const { password } = body;
    const settings = await getSettings();

    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    // Default password is '123456' if not set
    const storedHash = settings.password;

    if (settings.authMode === "oidc" && isOidcConfigured(settings)) {
      return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
    }

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else {
      // Use env var or default
      const initialPassword = process.env.INITIAL_PASSWORD || "123456";
      isValid = password === initialPassword;
    }

    if (isValid) {
      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
