#!/usr/bin/env node
/**
 * reset-password.mjs — Reset user password (generate random, hash bcrypt, write Postgres).
 * Usage: node --env-file=.env scripts/admin/reset-password.mjs <userId>
 * P11 (#22). Refs: https://github.com/ngapngap/9router/issues/22
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { parseCli, printHelp, getPgClient, emitCliAudit } from "./_lib/cliCommon.mjs";

const USAGE = `Usage: node --env-file=.env scripts/admin/reset-password.mjs <userId> [--dry-run]`;
const { flags, positionals } = parseCli({}, ["userId"]);
if (flags.help) printHelp(USAGE);

const userId = positionals[0];
if (!userId || !/^\d+$/.test(userId)) { console.error("Error: userId (numeric) required."); console.error(USAGE); process.exit(1); }

const newPassword = crypto.randomBytes(18).toString("base64url"); // 24 chars
const hash = await bcrypt.hash(newPassword, 12);

const client = getPgClient();
try {
  await client.connect();
  if (flags["dry-run"]) {
    console.log(`[dry-run] Would UPDATE public.users SET password='$2a$12$...' WHERE id=${userId}`);
  } else {
    const res = await client.query("UPDATE public.users SET password = $1 WHERE id = $2 RETURNING id, username", [hash, userId]);
    if (res.rowCount === 0) { console.error(`User ${userId} not found.`); process.exit(1); }
    // Print password ONCE to stdout — NOT logged anywhere
    console.log(`Password reset for user ${userId} (${res.rows[0].username}).`);
    console.log(`New password: ${newPassword}`);
    await emitCliAudit("user.password.reset", { userId }); // NO password/hash in audit
  }
} finally { await client.end(); }
