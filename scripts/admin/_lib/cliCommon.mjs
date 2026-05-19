#!/usr/bin/env node
/**
 * scripts/admin/_lib/cliCommon.mjs — Shared CLI helpers.
 * P11 (#22). Refs: https://github.com/ngapngap/9router/issues/22
 */
import { parseArgs } from "node:util";
import pg from "pg";

/**
 * Parse CLI args with common flags.
 * @param {object} options — parseArgs options (thêm vào common flags)
 * @param {string[]} [positionals] — tên positional args
 */
export function parseCli(options = {}, positionals = []) {
  const merged = {
    ...options,
    help: { type: "boolean", short: "h", default: false },
    "dry-run": { type: "boolean", default: false },
  };
  const { values, positionals: pos } = parseArgs({
    options: merged,
    allowPositionals: true,
    strict: false,
  });
  return { flags: values, positionals: pos };
}

/** Print usage and exit. */
export function printHelp(usage) {
  console.log(usage);
  process.exit(0);
}

/** Connect to Postgres (admin write connection). */
export function getPgClient() {
  const host = process.env.SAAS_NEW_API_PG_HOST || "localhost";
  const port = Number(process.env.SAAS_NEW_API_PG_PORT) || 5432;
  const database = process.env.SAAS_NEW_API_PG_DATABASE || "new-api";
  const user = process.env.SAAS_NEW_API_PG_ADMIN_USER || process.env.SAAS_NEW_API_PG_USER || "postgres";
  const password = process.env.SAAS_NEW_API_PG_ADMIN_PASSWORD || process.env.SAAS_NEW_API_PG_PASSWORD || "";
  const ssl = process.env.SAAS_NEW_API_PG_SSL === "true" ? { rejectUnauthorized: false } : false;

  return new pg.Client({ host, port, database, user, password, ssl });
}

/** Log audit event from CLI. */
export async function emitCliAudit(event, metadata) {
  // Import dynamically to avoid loading full app context
  try {
    const { writeAuditLog } = await import("../../src/lib/saas/auditLog.js");
    writeAuditLog({
      event: "admin.cli.action",
      userId: null,
      metadata: { script: event, ...metadata, actor: `${process.env.USERNAME || "unknown"}@${(await import("node:os")).hostname()}` },
    });
  } catch { /* audit best-effort */ }
}

/** Format output (table or json). */
export function output(data, format = process.env.OUTPUT || "table") {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.table(data);
  }
}
