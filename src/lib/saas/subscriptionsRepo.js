import { saasQuery } from "./query.js";

/**
 * Đơn vị quota của New-API: 500,000 quota = 1 USD.
 * Áp dụng cho cả `users.quota` và `user_subscriptions.amount_total/amount_used`.
 */
export const QUOTA_PER_USD = 500000;

/**
 * Quy đổi quota → USD.
 * @param {number|string|null|undefined} quota
 * @returns {number}
 */
export function quotaToUsd(quota) {
  const n = Number(quota);
  if (!Number.isFinite(n)) return 0;
  return n / QUOTA_PER_USD;
}

/**
 * Lấy toàn bộ gói đăng ký active của user (status='active' và end_time > now).
 * Sắp xếp theo end_time ASC, sau đó theo bậc VIP (200 > 100 > 50 > 25).
 *
 * @param {number|string} userId internal users.id
 * @returns {Promise<Array<{ title: string, sub_id: number, start_time: number, end_time: number, next_reset_time: number|null, amount_total: number, amount_used: number }>>}
 */
export async function listActiveSubscriptionsByUserId(userId) {
  const res = await saasQuery(
    `SELECT sp.title, us.id AS sub_id, us.start_time, us.end_time,
            us.next_reset_time, us.amount_total, us.amount_used
     FROM user_subscriptions us
     JOIN subscription_plans sp ON sp.id = us.plan_id
     WHERE us.user_id = $1
       AND us.status = 'active'
       AND us.end_time > EXTRACT(EPOCH FROM NOW())::bigint
     ORDER BY us.end_time ASC,
       CASE
         WHEN LOWER(sp.title) IN ('vip 200', 'vip200') THEN 4
         WHEN LOWER(sp.title) IN ('vip 100', 'vip100') THEN 3
         WHEN LOWER(sp.title) IN ('vip 50',  'vip50')  THEN 2
         WHEN LOWER(sp.title) IN ('vip 25',  'vip25')  THEN 1
         ELSE 0
       END DESC`,
    [userId],
  );
  return res.rows;
}
