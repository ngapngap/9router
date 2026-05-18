/**
 * @param {{ id: number | string, role?: number | string | null }} userRow
 * @returns {boolean}
 */
export function computeIsAdmin(userRow) {
  // Priority 1: SAAS_ADMIN_USER_IDS (DESIGN §6.1)
  const raw = process.env.SAAS_ADMIN_USER_IDS;
  if (raw?.trim()) {
    const allow = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const idStr = String(userRow.id);
    if (allow.includes(idStr)) return true;
  }

  // Priority 2: SAAS_ADMIN_ROLE_VALUES (CSV, default "10,100")
  const roleVals = (process.env.SAAS_ADMIN_ROLE_VALUES || "10,100")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Number.isFinite);
  const role = Number(userRow.role);
  if (Number.isFinite(role) && roleVals.includes(role)) return true;

  // Priority 3: SAAS_ADMIN_FALLBACK_USER_ID (opt-in only — must be non-empty numeric)
  const fallbackRaw = process.env.SAAS_ADMIN_FALLBACK_USER_ID?.trim();
  if (fallbackRaw && /^\d+$/.test(fallbackRaw) && String(userRow.id) === fallbackRaw) return true;

  return false;
}
