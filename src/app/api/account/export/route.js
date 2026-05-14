import { NextResponse } from "next/server";
import { isSaasDatabaseConfigured } from "@/lib/saas/pgPool.js";
import { getSaasUserIdFromRequest } from "@/lib/saas/sessionServer.js";
import { exportUserRouterConfig } from "@/lib/saas/userExport.js";

export async function GET() {
  if (process.env.SAAS_ENABLED !== "true") {
    return NextResponse.json({ error: "not_saas" }, { status: 404 });
  }

  const userId = await getSaasUserIdFromRequest();
  if (userId == null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isSaasDatabaseConfigured()) {
    return NextResponse.json({ error: "saas_db_not_configured" }, { status: 503 });
  }

  try {
    const payload = await exportUserRouterConfig(userId);
    const body = JSON.stringify(payload);
    const filename = `9router-export-${userId}.json`;
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    console.error("[account/export]", e);
    return NextResponse.json({ error: "export_failed" }, { status: 500 });
  }
}
