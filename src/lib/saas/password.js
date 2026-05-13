import bcrypt from "bcryptjs";

/**
 * @param {string} plain
 * @param {string | null | undefined} hashFromDb
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plain, hashFromDb) {
  if (!hashFromDb || typeof hashFromDb !== "string") return false;
  return bcrypt.compare(plain, hashFromDb);
}
