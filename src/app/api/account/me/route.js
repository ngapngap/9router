import { NextResponse } from "next/server";
import { isSaasDatabaseConfigured } from "@/lib/saas/pgPool.js";
import { getSaasUserIdFromRequest } from "@/lib/saas/sessionServer.js";
import { getUserAccountById } from "@/lib/saas/usersRepo.js";
import { quotaToUsd } from "@/lib/saas/subscriptionsRepo.js";

export async function GET() {
  if (process.env.SAAS_ENABLED !== "true") {
    return NextResponse.json({ error: "not_saas" }, { status: 404 });
  }
  if (!isSaasDatabaseConfigured()) {
    return NextResponse.json({ error: "saas_db_not_configured" }, { status: 503 });
  }

  const userId = await getSaasUserIdFromRequest();
  if (userId == null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const row = await getUserAccountById(userId);
    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const quota = row.quota != null ? Number(row.quota) : null;
    const usedQuota = row.used_quota != null ? Number(row.used_quota) : null;

    return NextResponse.json({
      id: Number(row.id),
      username: row.username ?? null,
      email: row.email ?? null,
      displayName: row.display_name ?? null,
      role: row.role != null ? Number(row.role) : null,
      status: row.status != null ? Number(row.status) : null,
      quota,
      usedQuota,
      balanceUsd: quota != null ? quotaToUsd(quota) : null,
      usedQuotaUsd: usedQuota != null ? quotaToUsd(usedQuota) : null,
    });
  } catch (e) {
    console.error("[account/me]", e?.message || e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
