/** POST /api/account/import — import JSON router config vào SQLite per-user. DESIGN §8.3. */
import { NextResponse } from "next/server";
import { isSaasDatabaseConfigured } from "@/lib/saas/pgPool.js";
import { getSaasUserIdFromRequest } from "@/lib/saas/sessionServer.js";
import { getAdapterForUser } from "@/lib/db/driver.js";
import { importDb } from "@/lib/db/index.js";

export async function POST(request) {
  if (process.env.SAAS_ENABLED !== "true") {
    return NextResponse.json({ error: "not_saas" }, { status: 404 });
  }

  const userId = await getSaasUserIdFromRequest();
  if (userId == null) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isSaasDatabaseConfigured()) {
    return NextResponse.json({ error: "saas_db_not_configured" }, { status: 503 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: "Invalid database payload" }, { status: 400 });
  }

  try {
    const adapter = await getAdapterForUser(userId);
    const { stringifyJson } = await import("@/lib/db/helpers/jsonCol.js");

    adapter.transaction(() => {
      adapter.run(`DELETE FROM settings`);
      adapter.run(`DELETE FROM providerConnections`);
      adapter.run(`DELETE FROM providerNodes`);
      adapter.run(`DELETE FROM proxyPools`);
      adapter.run(`DELETE FROM apiKeys`);
      adapter.run(`DELETE FROM combos`);
      adapter.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

      if (payload.settings) {
        adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
      }
      for (const c of payload.providerConnections || []) {
        const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
        adapter.run(
          `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()],
        );
      }
      for (const n of payload.providerNodes || []) {
        const { id, type, name, createdAt, updatedAt, ...rest } = n;
        adapter.run(
          `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()],
        );
      }
      for (const p of payload.proxyPools || []) {
        const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
        adapter.run(
          `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()],
        );
      }
      for (const k of payload.apiKeys || []) {
        adapter.run(
          `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()],
        );
      }
      for (const c of payload.combos || []) {
        adapter.run(
          `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()],
        );
      }
      for (const [a, m] of Object.entries(payload.modelAliases || {})) {
        adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
      }
      for (const m of payload.customModels || []) {
        const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
        adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
      }
      for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
        adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
      }
      for (const [provider, models] of Object.entries(payload.pricing || {})) {
        adapter.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
      }
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[account/import]", e);
    return NextResponse.json({ error: "import_failed" }, { status: 500 });
  }
}
