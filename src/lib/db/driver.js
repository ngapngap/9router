import fs from "node:fs";
import path from "node:path";
import { ensureDirs, DATA_FILE } from "./paths.js";
import { assertSafeUserId } from "@/lib/saas/userDataRoot.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

if (!global._saasUserDbAdapter) {
  global._saasUserDbAdapter = /** @type {Map<string, { instance: any, initPromise: Promise<any> | null }>} */ (new Map());
}
const saasUserSlots = global._saasUserDbAdapter;

/**
 * @param {string} dataFile
 */
function ensureParentDir(dataFile) {
  const dir = path.dirname(dataFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function tryBunSqlite(dataFile) {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(dataFile);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite(dataFile) {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(dataFile);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite(dataFile) {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(dataFile);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs(dataFile) {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(dataFile);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

/**
 * @param {string} dataFile Absolute path to SQLite file
 */
async function initAdapterForDataFile(dataFile) {
  ensureParentDir(dataFile);
  let adapter = await tryBunSqlite(dataFile);
  if (!adapter) adapter = await tryBetterSqlite(dataFile);
  if (!adapter) adapter = await tryNodeSqlite(dataFile);
  if (!adapter) adapter = await trySqlJs(dataFile);
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");

  if (!global._dbAdapterPathsLogged) global._dbAdapterPathsLogged = new Set();
  const seen = global._dbAdapterPathsLogged;
  if (!seen.has(dataFile)) {
    seen.add(dataFile);
    console.log(`[DB] Driver: ${adapter.driver}`);
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

async function initDefaultAdapter() {
  ensureDirs();
  return initAdapterForDataFile(DATA_FILE);
}

/**
 * SQLite tenant SaaS: `DATA_DIR/saas/users/<id>/data.sqlite`
 * @param {string|number} userId
 */
export async function getAdapterForUser(userId) {
  const safe = assertSafeUserId(userId);
  let slot = saasUserSlots.get(safe);
  if (slot?.instance) return slot.instance;
  if (slot?.initPromise) return slot.initPromise;

  const { ensureUserDataDir } = await import("@/lib/saas/userDataRoot.js");
  const dir = ensureUserDataDir(safe);
  const dataFile = path.join(dir, "data.sqlite");

  slot = { instance: null, initPromise: null };
  saasUserSlots.set(safe, slot);
  slot.initPromise = initAdapterForDataFile(dataFile).then((a) => {
    slot.instance = a;
    slot.initPromise = null;
    return a;
  });
  return slot.initPromise;
}

export async function getAdapter() {
  if (process.env.SAAS_ENABLED === "true") {
    const { getTenantUserId } = await import("@/lib/saas/tenantContext.js");
    const tid = getTenantUserId();
    if (tid != null) {
      return getAdapterForUser(tid);
    }
    const { getSaasUserIdFromRequest } = await import("@/lib/saas/sessionServer.js");
    const sid = await getSaasUserIdFromRequest();
    if (sid != null) {
      return getAdapterForUser(sid);
    }
  }

  if (state.instance) return state.instance;
  if (!state.initPromise) {
    state.initPromise = initDefaultAdapter().then((a) => {
      state.instance = a;
      return a;
    });
  }
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
