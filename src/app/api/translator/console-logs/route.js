import { NextResponse } from "next/server";
import { clearConsoleLogs, getConsoleLogs, initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { requireSaasAdminOrSelfHost } from "@/lib/saas/requireAdmin";

initConsoleLogCapture();

export async function GET() {
  const gate = await requireSaasAdminOrSelfHost();
  if (!gate.ok) return gate.response;
  try {
    const logs = getConsoleLogs();
    return NextResponse.json({ success: true, logs });
  } catch (error) {
    console.error("Error getting console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  const gate = await requireSaasAdminOrSelfHost();
  if (!gate.ok) return gate.response;
  try {
    clearConsoleLogs();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error clearing console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
