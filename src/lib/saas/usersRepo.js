import { saasQuery } from "./query.js";

/**
 * @param {string} identifier email hoặc username (trim ngoài hoặc trong)
 * @returns {Promise<import("pg").QueryResultRow | null>}
 */
export async function findUserForLogin(identifier) {
  const id = String(identifier ?? "").trim();
  if (!id) return null;

  const res = await saasQuery(
    `SELECT id, username, email, password, role, status, display_name, deleted_at
     FROM public.users
     WHERE deleted_at IS NULL AND status = 1
       AND (lower(email) = lower($1) OR lower(username) = lower($1))
     LIMIT 2`,
    [id],
  );

  if (res.rows.length !== 1) return null;
  return res.rows[0];
}

/**
 * Đọc hồ sơ hiển thị (không trả password).
 * @param {number|string} userId
 */
export async function getUserAccountById(userId) {
  const res = await saasQuery(
    `SELECT id, username, email, display_name, role, status,
            quota, used_quota, request_count
     FROM public.users
     WHERE id = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [userId],
  );
  return res.rows[0] ?? null;
}
