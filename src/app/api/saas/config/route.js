import { NextResponse } from "next/server";

/** Cấu hình hiển thị client (không lộ secret). */
export async function GET() {
  const enabled = process.env.SAAS_ENABLED === "true";
  const raw = process.env.SAAS_RAMCLOUDS_BASE_URL?.trim();
  const ramcloudsBaseUrl = raw || "https://ramclouds.me/v1";

  return NextResponse.json({
    enabled,
    ramcloudsBaseUrl,
  });
}
