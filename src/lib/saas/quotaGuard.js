/**
 * quotaGuard.js — Pre-flight quota check trước khi proxy upstream.
 *
 * P11 (#22): Trả 402 nếu user hết quota, KHÔNG gọi upstream.
 * Hook point: v1Request.js runV1WithBearerAuth, sau isValidApiKey.
 *
 * Env flags:
 *   QUOTA_GUARD_ENABLED=true — bật pre-check (default false).
 *   QUOTA_OVERRUN_AUDIT=true — log audit khi streaming overrun (default true).
 *
 * Refs: https://github.com/ngapngap/9router/issues/22
 */

import { saasQuery } from "./query.js";
import { writeAuditLog } from "./auditLog.js";

const BUFFER_FACTOR = 1.2; // +20% buffer

/**
 * Check quota trước khi proxy request.
 *
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} [opts.model]
 * @param {string} [opts.provider]
 * @returns {Promise<{ allowed: boolean, remaining?: number, estimated?: number, error?: object }>}
 */
export async function assertQuotaForRequest({ userId, model = "unknown", provider = "unknown" }) {
  if (process.env.QUOTA_GUARD_ENABLED !== "true") {
    return { allowed: true };
  }

  try {
    const result = await saasQuery(
      "SELECT quota, used_quota FROM public.users WHERE id = $1",
      [userId],
    );
    const row = result.rows?.[0];
    if (!row) return { allowed: true }; // user not found in pg → allow (defensive)

    const quota = Number(row.quota) || 0;
    const usedQuota = Number(row.used_quota) || 0;
    const remaining = quota - usedQuota;

    // quota = 0 → unlimited (convention New-API)
    if (quota === 0) return { allowed: true, remaining: Infinity };

    // Estimate cost (simplified — flat cost = 1 per request as placeholder)
    const estimatedCost = 1 * BUFFER_FACTOR;

    if (remaining < estimatedCost) {
      writeAuditLog({
        event: "quota.exhausted",
        userId,
        metadata: { model, provider, remaining, estimated: estimatedCost },
      });

      return {
        allowed: false,
        remaining,
        estimated: estimatedCost,
        error: {
          code: "quota_exhausted",
          message: `User quota exhausted; estimated cost ${estimatedCost.toFixed(1)} exceeds remaining ${remaining}`,
          type: "insufficient_quota",
          retry_after: 86400,
        },
      };
    }

    return { allowed: true, remaining };
  } catch (err) {
    // Fail-open: nếu query lỗi → cho phép request, log warning
    console.warn("[quotaGuard] pre-check failed, allowing request:", err.message);
    return { allowed: true };
  }
}

/**
 * Record overrun khi streaming vượt quota (gọi sau khi stream kết thúc).
 *
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} [opts.model]
 * @param {number} opts.estimated
 * @param {number} opts.actual
 */
export function recordOverrun({ userId, model = "unknown", estimated, actual }) {
  if (process.env.QUOTA_OVERRUN_AUDIT !== "false") {
    writeAuditLog({
      event: "quota.overrun",
      userId,
      metadata: { model, estimated, actual, overshoot: actual - estimated },
    });
  }
}
