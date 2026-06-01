/**
 * /api/health — Deep readiness probe.
 *
 * Checks:
 *   1. Postgres reachable (SELECT 1) — only when SAAS_ENABLED=true
 *   2. DATA_DIR writable (fs.access W_OK)
 *   3. Disk free > 10% (fs.statfs)
 *
 * Returns 200 with `{ ok: false, checks: {...} }` when a check fails but the
 * HTTP server itself is alive (degraded mode). Returns 503 only when no
 * checks could even run (server broken). This avoids killing the container
 * mid-init when the DB layer is still warming up.
 *
 * P10 (#23): implement from stub `{ ok: true }`.
 * Refs: https://github.com/ngapngap/9router/issues/23
 */
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { constants } from "node:fs";

const DATA_DIR = process.env.DATA_DIR || "./data";
const CHECK_TIMEOUT_MS = 2000;

async function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), ms)
  );
  return Promise.race([promise, timeout]);
}

async function checkPostgres() {
  if (process.env.SAAS_ENABLED !== "true") {
    return { status: "skip", reason: "not SaaS mode" };
  }
  try {
    const { saasQuery } = await import("@/lib/saas/query.js");
    await withTimeout(saasQuery("SELECT 1"), CHECK_TIMEOUT_MS);
    return { status: "ok" };
  } catch (err) {
    return { status: "fail", reason: err.message };
  }
}

async function checkDataDir() {
  try {
    await withTimeout(fs.access(DATA_DIR, constants.W_OK), CHECK_TIMEOUT_MS);
    return { status: "ok" };
  } catch (err) {
    return { status: "fail", reason: err.message };
  }
}

async function checkDisk() {
  try {
    const stats = await withTimeout(fs.statfs(DATA_DIR), CHECK_TIMEOUT_MS);
    const freeRatio = Number(stats.bavail) / Number(stats.blocks);
    if (freeRatio < 0.1) {
      return { status: "fail", reason: `disk free ${(freeRatio * 100).toFixed(1)}% < 10%` };
    }
    return { status: "ok", freePercent: (freeRatio * 100).toFixed(1) };
  } catch (err) {
    return { status: "fail", reason: err.message };
  }
}

export async function GET() {
  // Hard guard: if the global DB adapter is null, the process is still booting
  // (initApp in progress). Return 200 + booting=true so Docker healthcheck
  // gives us a chance to finish init instead of killing us mid-flight.
  const booting = !global._dbAdapter?.instance && !global._dbAdapter?.initPromise;

  let pg, dataDir, disk;
  try {
    [pg, dataDir, disk] = await Promise.all([
      checkPostgres(),
      checkDataDir(),
      checkDisk(),
    ]);
  } catch (err) {
    return NextResponse.json(
      { ok: false, booting, error: err.message },
      { status: 503 }
    );
  }

  const checks = { pg, dataDir, disk };
  const allOk = Object.values(checks).every(c => c.status === "ok" || c.status === "skip");
  const anyRan = Object.values(checks).some(c => c.status !== "skip");

  return NextResponse.json(
    { ok: allOk, booting, checks },
    { status: allOk ? 200 : (anyRan ? 200 : 503) }
  );
}
