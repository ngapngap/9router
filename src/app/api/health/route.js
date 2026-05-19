/**
 * /api/health — Deep readiness probe.
 *
 * Checks:
 *   1. Postgres reachable (SELECT 1) — only when SAAS_ENABLED=true
 *   2. DATA_DIR writable (fs.access W_OK)
 *   3. Disk free > 10% (fs.statfs)
 *
 * Returns 503 when any check fails; 200 + JSON detail when healthy.
 * Timeout 2s per check to avoid blocking probe.
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
  const [pg, dataDir, disk] = await Promise.all([
    checkPostgres(),
    checkDataDir(),
    checkDisk(),
  ]);

  const checks = { pg, dataDir, disk };
  const ok = Object.values(checks).every(c => c.status === "ok" || c.status === "skip");

  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
