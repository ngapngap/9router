import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

/**
 * SaaS mode: insert key vào Postgres tokens table để Bearer auth lookup hoạt động.
 * Postgres tokens table là nơi validateApiKey query khi SAAS_ENABLED=true.
 */
async function syncKeyToPostgres(key, name, userId) {
  if (process.env.SAAS_ENABLED !== "true") return;
  if (!userId) return;
  try {
    const { saasQuery } = await import("@/lib/saas/query.js");
    await saasQuery(
      `INSERT INTO public.tokens (user_id, key, name, status, created_time, accessed_time, expired_time)
       VALUES ($1, $2, $3, 1, $4, $4, -1)
       ON CONFLICT (key) DO NOTHING`,
      [userId, key, name || "Dashboard API Key", Math.floor(Date.now() / 1000)]
    );
  } catch (e) {
    console.warn("[apiKeysRepo] syncKeyToPostgres failed:", e.message);
    // Non-fatal: key still works in SQLite for display, just won't auth via Bearer until synced
  }
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

  // SaaS: sync to Postgres for Bearer auth lookup
  const { getTenantUserId } = await import("@/lib/saas/tenantContext.js");
  await syncKeyToPostgres(apiKey.key, apiKey.name, getTenantUserId());

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

  // SaaS: soft-delete from Postgres too
  if (row?.key && process.env.SAAS_ENABLED === "true") {
    try {
      const { saasQuery } = await import("@/lib/saas/query.js");
      await saasQuery(
        `UPDATE public.tokens SET deleted_at = NOW() WHERE TRIM(key::text) = $1`,
        [row.key]
      );
    } catch (e) {
      console.warn("[apiKeysRepo] deleteKeyFromPostgres failed:", e.message);
    }
  }

  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const k = typeof key === "string" ? key.trim() : "";
  if (!k) return false;

  if (process.env.SAAS_ENABLED === "true") {
    const { findTokenByKeyForProxy } = await import("@/lib/saas/tokensRepo.js");
    const { setTenantUserId } = await import("@/lib/saas/tenantContext.js");
    const row = await findTokenByKeyForProxy(k);
    if (!row?.user_id) return false;
    setTenantUserId(Number(row.user_id));
    return true;
  }

  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [k]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
