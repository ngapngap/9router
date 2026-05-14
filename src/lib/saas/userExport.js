import path from "node:path";
import { createSqlJsAdapter } from "@/lib/db/adapters/sqljsAdapter.js";
import { runMigrationOnce } from "@/lib/db/migrate.js";
import { buildExportPayload } from "@/lib/db/exportPayload.js";
import { ensureUserDataDir } from "./userDataRoot.js";

/**
 * Export JSON router (shape giống /api/settings/database) từ SQLite per-user.
 * @param {number|string} userId
 */
export async function exportUserRouterConfig(userId) {
  const dir = ensureUserDataDir(userId);
  const file = path.join(dir, "data.sqlite");
  const adapter = await createSqlJsAdapter(file);
  await runMigrationOnce(adapter);
  return buildExportPayload(adapter);
}
