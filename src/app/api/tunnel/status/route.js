import { NextResponse } from "next/server";
import { getTunnelStatus, getTailscaleStatus } from "@/lib/tunnel/tunnelManager";
import { getDownloadStatus } from "@/lib/tunnel/cloudflared";

export async function GET() {
  if (process.env.SAAS_ENABLED === "true") {
    return NextResponse.json({ error: "not_available_in_saas" }, { status: 404 });
  }
  try {
    const [tunnel, tailscale] = await Promise.all([getTunnelStatus(), getTailscaleStatus()]);
    const download = getDownloadStatus();
    return NextResponse.json({ tunnel, tailscale, download });
  } catch (error) {
    console.error("Tunnel status error:", error?.message || error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
