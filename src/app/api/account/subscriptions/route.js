import { NextResponse } from "next/server";
import { isSaasDatabaseConfigured } from "@/lib/saas/pgPool.js";
import { getSaasUserIdFromRequest } from "@/lib/saas/sessionServer.js";
import {
  listActiveSubscriptionsByUserId,
  quotaToUsd,
  dailyLimitForTitle,
} from "@/lib/saas/subscriptionsRepo.js";

export const dynamic = "force-dynamic";

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
    const rows = await listActiveSubscriptionsByUserId(userId);
    const items = rows.map((r) => {
      const amountTotal = Number(r.amount_total) || 0;
      const amountUsed = Number(r.amount_used) || 0;
      const remaining = Math.max(amountTotal - amountUsed, 0);
      return {
        subId: Number(r.sub_id),
        title: r.title ?? null,
        startTime: r.start_time != null ? Number(r.start_time) : null,
        endTime: r.end_time != null ? Number(r.end_time) : null,
        nextResetTime: r.next_reset_time != null ? Number(r.next_reset_time) : null,
        amountTotal,
        amountUsed,
        amountTotalUsd: quotaToUsd(amountTotal),
        amountUsedUsd: quotaToUsd(amountUsed),
        dailyQuotaRemainingUsd: quotaToUsd(remaining),
        dailyRequestLimit: dailyLimitForTitle(r.title),
      };
    });
    return NextResponse.json({ items });
  } catch (e) {
    console.error("[account/subscriptions]", e?.message || e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
