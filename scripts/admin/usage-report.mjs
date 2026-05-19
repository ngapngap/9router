#!/usr/bin/env node
/**
 * usage-report.mjs — Cross-user usage report (CSV).
 * Usage: node --env-file=.env scripts/admin/usage-report.mjs --month YYYY-MM [--user <id>] [--out <path>]
 * P11 (#22). Refs: https://github.com/ngapngap/9router/issues/22
 */
import fs from "node:fs";
import { parseCli, printHelp } from "./_lib/cliCommon.mjs";

const USAGE = `Usage: node --env-file=.env scripts/admin/usage-report.mjs --month YYYY-MM [--user <id>] [--out <path>]`;
const { flags } = parseCli({ month: { type: "string" }, user: { type: "string" }, out: { type: "string" } });
if (flags.help || !flags.month) printHelp(USAGE);

// Placeholder: read from audit log as proxy for usage data
// Full implementation would query usageHistory from per-user SQLite via runAsSystem
const { readAuditLog } = await import("../../src/lib/saas/auditLog.js");
const since = `${flags.month}-01T00:00:00.000Z`;
const nextMonth = new Date(since);
nextMonth.setMonth(nextMonth.getMonth() + 1);

const entries = readAuditLog({ limit: 10000, since, user: flags.user || undefined });
// Filter to month range
const filtered = entries.filter(e => e.ts < nextMonth.toISOString());

// CSV output
const header = "ts,event,userId,detail";
const rows = filtered.map(e => `${e.ts},${e.event},${e.userId || ""},${(e.detail || "").replace(/,/g, ";")}`);
const csv = [header, ...rows].join("\n");

if (flags.out) {
  fs.writeFileSync(flags.out, csv);
  console.log(`Written ${rows.length} rows to ${flags.out}`);
} else {
  console.log(csv);
}
