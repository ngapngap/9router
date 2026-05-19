/**
 * auditLog.js — Append-only audit log cho SaaS admin actions.
 *
 * P08 (#18): baseline — writeAuditLog + readAuditLog (today only).
 * P10 (#23): mở rộng schema (event/metadata/ip), reader filter cross-day (since/user/event).
 *
 * File format: `DATA_DIR/saas/audit/admin-YYYY-MM-DD.log` (1 JSON per line).
 * Rotation: 10MB → rename .1 (giữ 1 backup).
 *
 * 6 event mới (P10): settings.save, connection.add, connection.remove,
 * apiKey.rotate, quota.exhausted, login.failed.
 * Caller emit event tại route handler — file này chỉ cung cấp write/read API.
 *
 * Refs: https://github.com/ngapngap/9router/issues/23
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const AUDIT_DIR = path.join(DATA_DIR, "saas", "audit");
const MAX_LINE_BYTES = 2048;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function ensureDir() {
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

function todayFile() {
  const d = new Date();
  const tag = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(AUDIT_DIR, `admin-${tag}.log`);
}

function rotateIfNeeded(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.size > MAX_FILE_BYTES) {
      const backup = `${filePath}.1`;
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      fs.renameSync(filePath, backup);
    }
  } catch {}
}

/**
 * Ghi 1 dòng audit log.
 *
 * P10 (#23): mở rộng schema — thêm `event` (structured event name) + `metadata` (object).
 * Backward compat: `action` vẫn hoạt động (alias cho `event` nếu `event` không truyền).
 *
 * @param {object} opts
 * @param {string} [opts.action] — legacy field (P08). Dùng `event` thay thế.
 * @param {string} [opts.event] — structured event name (vd "settings.save", "connection.add").
 * @param {string|number} [opts.userId]
 * @param {string|number} [opts.targetId]
 * @param {string} [opts.detail] — legacy text detail (P08).
 * @param {object} [opts.metadata] — structured metadata object (P10).
 * @param {string} [opts.ip] — request IP (P10).
 */
export function writeAuditLog({ action, event, userId, targetId, detail, metadata, ip }) {
  ensureDir();
  const entry = {
    ts: new Date().toISOString(),
    event: String(event || action || "unknown").slice(0, 64),
    userId: userId ?? null,
    targetId: targetId ?? null,
    ip: ip ?? null,
    detail: detail ? String(detail).slice(0, 256) : undefined,
    metadata: metadata ?? undefined,
  };
  // Remove undefined fields
  const clean = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
  const line = JSON.stringify(clean);
  if (line.length > MAX_LINE_BYTES) return;

  const filePath = todayFile();
  rotateIfNeeded(filePath);
  fs.appendFileSync(filePath, line + "\n");
}

/**
 * Đọc audit log với filter.
 *
 * P10 (#23): hỗ trợ filter cross-day (đọc nhiều file), filter theo user/event/since.
 *
 * @param {object|number} [opts]
 * @param {number} [opts.limit=100] — max entries trả về.
 * @param {string} [opts.since] — ISO timestamp, chỉ trả entries >= since.
 * @param {string|number} [opts.user] — filter theo userId.
 * @param {string} [opts.event] — filter theo event name (exact match hoặc prefix "connection.*").
 * @returns {Array<object>}
 */
export function readAuditLog(opts = {}) {
  // Backward compat: nếu opts là number → legacy call readAuditLog(100)
  if (typeof opts === "number") {
    opts = { limit: opts };
  }
  const { limit = 100, since, user, event } = opts;

  ensureDir();

  // List all audit files, sorted by date
  const files = [];
  try {
    const entries = fs.readdirSync(AUDIT_DIR);
    for (const name of entries) {
      if (name.startsWith("admin-") && name.endsWith(".log")) {
        files.push(path.join(AUDIT_DIR, name));
      }
    }
  } catch { return []; }
  files.sort(); // lexicographic = chronological for YYYY-MM-DD

  const results = [];
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const l of lines) {
        try {
          const entry = JSON.parse(l);
          // Filter: since
          if (since && entry.ts < since) continue;
          // Filter: user
          if (user != null && entry.userId != user) continue;
          // Filter: event (exact or prefix with *)
          if (event) {
            if (event.endsWith("*")) {
              const prefix = event.slice(0, -1);
              if (!entry.event?.startsWith(prefix)) continue;
            } else {
              if (entry.event !== event) continue;
            }
          }
          results.push(entry);
        } catch { /* skip malformed line */ }
      }
    } catch { /* skip unreadable file */ }
  }

  // Return last `limit` entries (most recent)
  return results.slice(-limit);
}
