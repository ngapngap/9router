import pg from "pg";

const g = globalThis;
const POOL_KEY = Symbol.for("9router.saasPgPool");

/**
 * @returns {boolean}
 */
export function isSaasDatabaseConfigured() {
  return (
    process.env.SAAS_ENABLED === "true" &&
    Boolean(process.env.SAAS_DATABASE_URL?.trim())
  );
}

/**
 * PostgreSQL pool for New-API (read-only usage planned in later phases).
 * @returns {import("pg").Pool | null}
 */
export function getSaasPool() {
  if (!isSaasDatabaseConfigured()) return null;

  const connectionString = process.env.SAAS_DATABASE_URL.trim();

  if (!g[POOL_KEY]) {
    g[POOL_KEY] = new pg.Pool({
      connectionString,
      max: 15,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  return g[POOL_KEY];
}

/** Ends pool and clears singleton (tests + graceful shutdown). */
export async function endSaasPool() {
  const pool = g[POOL_KEY];
  if (!pool) return;
  await pool.end().catch(() => {});
  delete g[POOL_KEY];
}
