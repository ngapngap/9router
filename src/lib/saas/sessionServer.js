import { cookies } from "next/headers";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

/**
 * @returns {Promise<number | null>} users.id khi session SaaS hợp lệ; null nếu không SaaS / không đăng nhập SaaS.
 */
export async function getSaasUserIdFromRequest() {
  if (process.env.SAAS_ENABLED !== "true") return null;
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  const session = await getDashboardAuthSession(token);
  if (!session?.saas) return null;
  const id = Number(session.sub);
  return Number.isFinite(id) ? id : null;
}
