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
