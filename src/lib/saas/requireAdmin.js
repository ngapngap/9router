/**
 * Shared admin/self-host gate for sensitive routes.
 *
 * In SaaS mode, the global console log buffer (and similar process-wide state)
 * mixes data from every tenant. Routes that expose this state must be locked
 * to admins only. In self-host mode (SAAS_ENABLED!=="true") there is exactly
 * one tenant, so the route is allowed.
 *
 * @returns {Promise<{ ok: true } | { ok: false, response: Response }>}
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { getUserAccountById } from "@/lib/saas/usersRepo.js";
import { computeIsAdmin } from "@/lib/saas/adminPolicy.js";

export async function requireSaasAdminOrSelfHost() {
  if (process.env.SAAS_ENABLED !== "true") return { ok: true };

  const cookieStore = await cookies();
  const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
  if (!session?.saas || !session?.sub) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  let user = null;
  try {
    user = await getUserAccountById(session.sub);
  } catch {
    user = null;
  }

  if (!user || !computeIsAdmin(user)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  // Even for admins, console buffer leaks data across tenants.
  // Operator must explicitly opt-in via env to expose this in SaaS mode.
  if (process.env.SAAS_ENABLE_CONSOLE_LOGS_FOR_ADMIN !== "true") {
    return { ok: false, response: NextResponse.json({ error: "Disabled in SaaS mode" }, { status: 403 }) };
  }

  return { ok: true };
}
