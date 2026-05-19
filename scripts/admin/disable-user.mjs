#!/usr/bin/env node
/**
 * disable-user.mjs — Disable SaaS user (set status=2 in Postgres).
 * Usage: node --env-file=.env scripts/admin/disable-user.mjs <userId>
 * P11 (#22). Refs: https://github.com/ngapngap/9router/issues/22
 */
import { parseCli, printHelp, getPgClient, emitCliAudit } from "./_lib/cliCommon.mjs";

const USAGE = `Usage: node --env-file=.env scripts/admin/disable-user.mjs <userId> [--dry-run]`;
const { flags, positionals } = parseCli({}, ["userId"]);
if (flags.help) printHelp(USAGE);

const userId = positionals[0];
if (!userId || !/^\d+$/.test(userId)) { console.error("Error: userId (numeric) required."); console.error(USAGE); process.exit(1); }

const client = getPgClient();
try {
  await client.connect();
  if (flags["dry-run"]) {
    console.log(`[dry-run] Would UPDATE public.users SET status=2 WHERE id=${userId}`);
  } else {
    const res = await client.query("UPDATE public.users SET status = 2 WHERE id = $1 RETURNING id, username, status", [userId]);
    if (res.rowCount === 0) { console.error(`User ${userId} not found.`); process.exit(1); }
    console.log(`User ${userId} disabled (status=2).`, res.rows[0]);
    await emitCliAudit("user.disable", { userId });
  }
} finally { await client.end(); }
