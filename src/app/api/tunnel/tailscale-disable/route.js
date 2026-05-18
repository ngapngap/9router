import { NextResponse } from "next/server";
import { disableTailscale } from "@/lib/tunnel/tunnelManager";

export async function POST() {
  if (process.env.SAAS_ENABLED === "true") {
    return NextResponse.json({ error: "not_available_in_saas" }, { status: 404 });
  }
  try {
    const result = await disableTailscale();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale disable error:", error?.message || error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
