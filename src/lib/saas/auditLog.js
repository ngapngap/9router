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

export function writeAuditLog({ action, userId, targetId, detail }) {
  ensureDir();
  const entry = {
    ts: new Date().toISOString(),
    action: String(action || "").slice(0, 64),
    userId: userId ?? null,
    targetId: targetId ?? null,
    detail: String(detail || "").slice(0, 256),
  };
  const line = JSON.stringify(entry);
  if (line.length > MAX_LINE_BYTES) return;

  const filePath = todayFile();
  rotateIfNeeded(filePath);
  fs.appendFileSync(filePath, line + "\n");
}

export function readAuditLog(limit = 100) {
  ensureDir();
  const filePath = todayFile();
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
