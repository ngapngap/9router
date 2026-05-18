import { NextResponse } from "next/server";
import { startLogin } from "@/lib/tunnel/tailscale";
import { loadState, generateShortId } from "@/lib/tunnel/state.js";

export async function POST() {
  if (process.env.SAAS_ENABLED === "true") {
    return NextResponse.json({ error: "not_available_in_saas" }, { status: 404 });
  }
  try {
    const shortId = loadState()?.shortId || generateShortId();
    const result = await startLogin(shortId);
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale login error:", error?.message || error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
