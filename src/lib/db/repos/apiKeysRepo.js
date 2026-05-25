import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

/**
 * SaaS: scan all per-user SQLite DBs to find which user owns this API key.
 * Uses in-memory cache to avoid repeated filesystem scans.
 * Cache invalidated every 60s.
 *
 * @param {string} key — API key to find
 * @returns {Promise<string|null>} userId or null
 */
const _keyOwnerCache = new Map(); // key -> { userId, ts }
const KEY_CACHE_TTL = 60_000; // 60s

export { _keyOwnerCache, KEY_CACHE_TTL };

async function findKeyOwnerAcrossUsers(key) {
  // Check cache first
  const cached = _keyOwnerCache.get(key);
  if (cached && Date.now() - cached.ts < KEY_CACHE_TTL) {
    return cached.userId;
  }

  const { DATA_DIR } = await import("@/lib/dataDir.js");
  const path = await import("node:path");
  const fs = await import("node:fs");

  const usersDir = path.join(DATA_DIR, "saas", "users");
  let userDirs;
  try {
    userDirs = fs.readdirSync(usersDir).filter(d => /^\d+$/.test(d));
  } catch {
    return null; // saas/users dir doesn't exist yet
  }

  const { getAdapterForUser } = await import("../driver.js");

  for (const uid of userDirs) {
    try {
      const db = await getAdapterForUser(uid);
      const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
      if (row && (row.isActive === 1 || row.isActive === true)) {
        _keyOwnerCache.set(key, { userId: uid, ts: Date.now() });
        return uid;
      }
    } catch {
      // Skip broken/unreadable user DBs
      continue;
    }
  }

  // Not found — cache negative result briefly (10s)
  _keyOwnerCache.set(key, { userId: null, ts: Date.now() - KEY_CACHE_TTL + 10_000 });
  return null;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt]
  );

  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT key FROM apiKeys WHERE id = ?`, [id]);
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  // Invalidate cache
  if (row?.key) _keyOwnerCache.delete(row.key);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const k = typeof key === "string" ? key.trim() : "";
  if (!k) return false;

  if (process.env.SAAS_ENABLED === "true") {
    // SaaS: scan all per-user SQLite DBs to find key (keys stored in per-user SQLite only)
    const { setTenantUserId } = await import("@/lib/saas/tenantContext.js");
    const userId = await findKeyOwnerAcrossUsers(k);
    if (!userId) return false;
    setTenantUserId(Number(userId));
    return true;
  }

  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [k]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
