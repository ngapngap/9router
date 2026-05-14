import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getSaasUserIdFromRequest } from "@/lib/saas/sessionServer.js";
import { getUserAccountById, listUsersAdmin } from "@/lib/saas/usersRepo.js";
import { computeIsAdmin } from "@/lib/saas/adminPolicy.js";
import { getUserDataDir } from "@/lib/saas/userDataRoot.js";

/**
 * GET /api/admin/overview — chỉ admin SaaS; tổng quan user + kích thước store SQLite.
 */
export async function GET(request) {
  if (process.env.SAAS_ENABLED !== "true") {
    return NextResponse.json({ error: "not_saas" }, { status: 404 });
  }

  const uid = await getSaasUserIdFromRequest();
  if (uid == null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const me = await getUserAccountById(uid);
  if (!me || !computeIsAdmin(me)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const afterId = Number(searchParams.get("afterId") || "0") || 0;
  const limit = Number(searchParams.get("limit") || "50") || 50;

  const { users, hasMore, nextCursor } = await listUsersAdmin({ afterId, limit });

  const usersOut = [];
  for (const u of users) {
    const dir = getUserDataDir(u.id);
    const sqlitePath = path.join(dir, "data.sqlite");
    let storeBytes = 0;
    try {
      const st = await fs.stat(sqlitePath);
      if (st.isFile()) storeBytes = st.size;
    } catch {
      storeBytes = 0;
    }
    usersOut.push({
      id: u.id,
      username: u.username,
      email: u.email,
      display_name: u.display_name,
      role: u.role,
      status: u.status,
      quota: u.quota,
      used_quota: u.used_quota,
      request_count: u.request_count,
      storeBytes,
    });
  }

  return NextResponse.json({
    users: usersOut,
    hasMore,
    nextCursor,
  });
}
