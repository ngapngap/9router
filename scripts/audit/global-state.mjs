#!/usr/bin/env node
/**
 * scripts/audit/global-state.mjs — Audit module-level global state.
 *
 * Mục đích: phát hiện các `new (Map|Set|LRUCache|WeakMap)\(` ở module-level
 * (top of file, không trong function) để verify chúng được scope theo userId
 * hay không. Dùng cho P09 (multi-tenant isolation hardening).
 *
 * Status legend:
 *   OK      — verified safe (factory cache, registry static, hoặc đã keyed by userId)
 *   TODO    — chưa refactor, có nguy cơ leak cross-tenant
 *   EXEMPT  — system-wide cache (DNS, proxy dispatcher) — không cần per-tenant
 *
 * Whitelist EXEMPT đặt trong constant ở đầu file. Mỗi entry có comment giải thích.
 *
 * Usage:
 *   node scripts/audit/global-state.mjs               # in bảng tổng quan
 *   node scripts/audit/global-state.mjs --json        # JSON output
 *   node scripts/audit/global-state.mjs --strict      # exit 1 nếu còn entry TODO
 *
 * Reference: https://github.com/ngapngap/9router/issues/21
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");
const SCAN_DIRS = ["src", "open-sse"];
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "tests", "scripts",
]);

// Whitelist EXEMPT: cache hệ thống không cần per-tenant.
// Mỗi entry: { file: regex, cache: regex, reason: string }
const EXEMPT = [
  {
    file: /open-sse\/utils\/proxyFetch\.js$/,
    cache: /proxyDispatchers|DNS_CACHE/,
    reason: "system-wide HTTP dispatcher / DNS cache, không tham gia tenant data",
  },
  {
    file: /open-sse\/translator\/index\.js$/,
    cache: /requestRegistry|responseRegistry/,
    reason: "static registry (format -> handler), không state per-user",
  },
  {
    file: /open-sse\/executors\/index\.js$/,
    cache: /defaultCache/,
    reason: "factory cache (provider -> instance), không state per-user",
  },
  {
    file: /open-sse\/utils\/tenantCache\.js$/,
    cache: /scopedStore/,
    reason: "tenantCache helper bản thân — keyed by (scope, userId)",
  },
];

// OK whitelist (đã verify keyed by userId hoặc credential hash)
const OK = [
  // sẽ điền sau khi sub-wave E refactor xong
];

const PATTERN = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*new\s+(Map|Set|WeakMap|LRUCache)\b/;

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (/\.(m?js|ts)$/.test(entry.name) && !entry.name.endsWith(".test.js")) {
      yield path;
    }
  }
}

function classify(filePath, cacheName) {
  for (const e of EXEMPT) {
    if (e.file.test(filePath) && e.cache.test(cacheName)) {
      return { status: "EXEMPT", reason: e.reason };
    }
  }
  for (const e of OK) {
    if (e.file.test(filePath) && e.cache.test(cacheName)) {
      return { status: "OK", reason: e.reason };
    }
  }
  return { status: "TODO", reason: "verify keying — may leak cross-tenant" };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const strict = args.includes("--strict");

  const results = [];
  for (const top of SCAN_DIRS) {
    const dir = join(ROOT, top);
    try { await stat(dir); } catch { continue; }
    for await (const filePath of walk(dir)) {
      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      let inFunction = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Rough scope tracking: count opening braces of function/class declarations
        if (/^\s*(export\s+)?(async\s+)?function\b/.test(line) ||
            /^\s*(export\s+)?class\b/.test(line)) {
          inFunction++;
        }
        if (inFunction > 0 && /^\s*\}\s*$/.test(line)) {
          inFunction = Math.max(0, inFunction - 1);
        }
        if (inFunction > 0) continue;
        const match = line.match(PATTERN);
        if (match) {
          const [, name, kind] = match;
          const rel = relative(ROOT, filePath).replace(/\\/g, "/");
          const cls = classify(rel, name);
          results.push({ file: rel, line: i + 1, name, kind, ...cls });
        }
      }
    }
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log("\nModule-level global state audit:");
    console.log("-".repeat(80));
    for (const r of results) {
      console.log(`[${r.status.padEnd(6)}] ${r.file}:${r.line}  ${r.kind} ${r.name}`);
      if (r.status !== "OK") console.log(`         -> ${r.reason}`);
    }
    const counts = { OK: 0, EXEMPT: 0, TODO: 0 };
    for (const r of results) counts[r.status]++;
    console.log("-".repeat(80));
    console.log(`Total: ${results.length}  (OK: ${counts.OK}, EXEMPT: ${counts.EXEMPT}, TODO: ${counts.TODO})`);
  }

  if (strict) {
    const todoCount = results.filter(r => r.status === "TODO").length;
    process.exit(todoCount > 0 ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
