import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";

const SAFE_ID = /^\d+$/;

/**
 * @param {string | number} userId
 * @returns {string} segment an toàn cho đường dẫn
 */
export function assertSafeUserId(userId) {
  const s = String(userId ?? "").trim();
  if (!SAFE_ID.test(s)) {
    throw new Error("invalid_user_id");
  }
  return s;
}

/**
 * Thư mục cấu hình router SQLite cho user SaaS.
 * @param {string | number} userId
 */
export function getUserDataDir(userId) {
  const safe = assertSafeUserId(userId);
  return path.join(DATA_DIR, "saas", "users", safe);
}

export function ensureUserDataDir(userId) {
  const dir = getUserDataDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
