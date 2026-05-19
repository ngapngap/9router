#!/usr/bin/env node
/**
 * audit-query.mjs — Query audit log with filters.
 * Usage: node --env-file=.env scripts/admin/audit-query.mjs [--user <id>] [--since <ISO>] [--event <name>] [--limit <n>]
 * P11 (#22). Refs: https://github.com/ngapngap/9router/issues/22
 */
import { parseCli, printHelp, output } from "./_lib/cliCommon.mjs";

const USAGE = `Usage: node --env-file=.env scripts/admin/audit-query.mjs [--user <id>] [--since <ISO>] [--event <name>] [--limit <n>]`;
const { flags } = parseCli({ user: { type: "string" }, since: { type: "string" }, event: { type: "string" }, limit: { type: "string", default: "50" } });
if (flags.help) printHelp(USAGE);

// Dynamic import to use DATA_DIR from env
const { readAuditLog } = await import("../../src/lib/saas/auditLog.js");
const results = readAuditLog({
  limit: Number(flags.limit) || 50,
  since: flags.since || undefined,
  user: flags.user || undefined,
  event: flags.event || undefined,
});

output(results);
