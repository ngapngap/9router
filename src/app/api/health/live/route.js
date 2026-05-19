/**
 * /api/health/live — Liveness probe.
 *
 * Only checks process alive. Always returns 200.
 * Used by kubelet / orchestrator restart probe.
 *
 * P10 (#23). Refs: https://github.com/ngapngap/9router/issues/23
 */
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true });
}
