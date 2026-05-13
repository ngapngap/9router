import { NextResponse } from "next/server";
import { saasQuery } from "@/lib/saas/query.js";

export async function GET() {
  if (process.env.SAAS_ENABLED !== "true") {
    return NextResponse.json({ ok: false, enabled: false });
  }

  if (!process.env.SAAS_DATABASE_URL?.trim()) {
    return NextResponse.json(
      { ok: false, error: "missing_database_url" },
      { status: 503 },
    );
  }

  try {
    await saasQuery("SELECT 1 AS ok");
    return NextResponse.json({ ok: true, select1: true });
  } catch (err) {
    console.error("[health/saas-db]", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, error: "db_unreachable" }, { status: 503 });
  }
}
