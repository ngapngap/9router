import { NextResponse } from "next/server";
import { isSaasDatabaseConfigured } from "@/lib/saas/pgPool.js";
import { getSaasUserIdFromRequest } from "@/lib/saas/sessionServer.js";
import { listTokensByUserId, maskTokenKey } from "@/lib/saas/tokensRepo.js";

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
    const rows = await listTokensByUserId(userId);
    const items = rows.map((r) => ({
      id: Number(r.id),
      name: r.name ?? null,
      maskedKey: maskTokenKey(r.key),
      status: r.status != null ? Number(r.status) : null,
      createdTime: r.created_time != null ? Number(r.created_time) : null,
      expiredTime: r.expired_time != null ? Number(r.expired_time) : null,
    }));

    return NextResponse.json({ items });
  } catch (e) {
    console.error("[account/tokens]", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
