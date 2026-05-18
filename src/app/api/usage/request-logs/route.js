import { NextResponse } from "next/server";
import { getRecentLogs } from "@/lib/usageDb";

export async function GET() {
  try {
    const logs = await getRecentLogs(200);
    return NextResponse.json(logs);
  } catch (error) {
    console.error("[API ERROR] /api/usage/logs failed:", error?.message || error);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 });
  }
}
