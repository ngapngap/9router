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

/**
 * Admin: danh sách user (phân trang keyset theo id).
 * @param {{ limit?: number, afterId?: number, q?: string }} opts
 */
export async function listUsersAdmin({ limit = 50, afterId = 0, q = "" } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const whereParts = ["deleted_at IS NULL", "id > $1"];
  const params = [afterId];
  let paramIdx = 2;
  if (q) {
    whereParts.push(`(lower(email) LIKE lower($${paramIdx}) OR lower(username) LIKE lower($${paramIdx}) OR id::text = $${paramIdx})`);
    params.push(`%${q}%`);
    paramIdx++;
  }
  const whereClause = whereParts.join(" AND ");
  params.push(lim + 1);
  const res = await saasQuery(
    `SELECT id, username, email, display_name, role, status, quota, used_quota, request_count
     FROM public.users
     WHERE ${whereClause}
     ORDER BY id ASC
     LIMIT $${paramIdx}`,
    params,
  );
  const rows = res.rows;
  const hasMore = rows.length > lim;
  const data = hasMore ? rows.slice(0, lim) : rows;
  const nextCursor = hasMore ? data[data.length - 1]?.id : null;
  return { users: data, hasMore, nextCursor };
}
