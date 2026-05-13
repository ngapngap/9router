import { getSaasPool } from "./pgPool.js";

/**
 * @param {string} text
 * @param {unknown[]=} params
 * @returns {Promise<import("pg").QueryResult>}
 */
export async function saasQuery(text, params = []) {
  const pool = getSaasPool();
  if (!pool) {
    throw new Error("saas_db_not_configured");
  }
  return pool.query(text, params);
}
