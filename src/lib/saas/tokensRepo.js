import { saasQuery } from "./query.js";

/**
 * Danh sách token New-API theo user (chỉ đọc). Key đầy đủ — mask ở layer API/UI.
 * @param {number|string} userId
 */
export async function listTokensByUserId(userId) {
  const res = await saasQuery(
    `SELECT id, name, key, status, created_time, expired_time
     FROM public.tokens
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY id DESC`,
    [userId],
  );
  return res.rows;
}

/** §2.3 DESIGN — 8 ký tự đầu + … */
export function maskTokenKey(key) {
  const s = String(key ?? "").trim();
  if (s.length <= 8) return s ? "…" : "";
  return `${s.slice(0, 8)}…`;
}
