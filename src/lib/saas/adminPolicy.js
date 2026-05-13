/**
 * @param {{ id: number | string, role?: number | string | null }} userRow
 * @returns {boolean}
 */
export function computeIsAdmin(userRow) {
  const raw = process.env.SAAS_ADMIN_USER_IDS;
  if (raw?.trim()) {
    const allow = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const idStr = String(userRow.id);
    if (allow.includes(idStr)) return true;
  }

  const role = Number(userRow.role);
  if (Number.isNaN(role)) return false;
  return role === 10 || role === 100;
}
