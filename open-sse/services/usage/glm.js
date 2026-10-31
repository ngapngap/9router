/**
 * GLM Coding Plan usage (international + China regions)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";
import { fetchStartBalance, parseStartBalance, resolveGlmPlanMode } from "../zcodeStart.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

/**
 * Parse the GLM quota API response — shared by pasted API keys and
 * OAuth-minted coding-plan keys (both hit the same monitor endpoint).
 * Supports both TOKENS_LIMIT and CREDIT_LIMIT and dynamic intervals (e.g. session 5h, weekly 7d).
 */
export function parseGlmQuotaResponse(json) {
  const data = json?.data && typeof json.data === "object" ? json.data : {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const quotas = {};

  for (const limit of limits) {
    // 1. Accept both TOKENS_LIMIT and CREDIT_LIMIT from GLM API
    if (!limit || (limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT")) continue;
    const usedPercent = Number(limit.percentage) || 0;
    const resetMs = Number(limit.nextResetTime) || 0;
    const remaining = Math.max(0, 100 - usedPercent);

    // 2. Map key dynamically based on type and period (unit) to avoid overwriting
    let key = "session";
    if (limit.unit === 3) {
      key = `Session (${limit.number}h)`;
    } else if (limit.unit === 6) {
      key = "Weekly (7d)";
    } else if (limit.type === "TOKENS_LIMIT") {
      key = "Tokens";
    } else {
      key = `Limit (${limit.number})`;
    }

    quotas[key] = {
      used: usedPercent,
      total: 100,
      remaining,
      remainingPercentage: remaining,
      resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
      unlimited: false,
    };
  }

  const levelRaw = typeof data.level === "string" ? data.level : "";
  const plan = levelRaw
    ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
    : "Unknown";

  return { plan, quotas };
}

async function getStartPlanUsage(provider, jwt, proxyOptions) {
  try {
    const balance = await fetchStartBalance(provider, jwt, proxyOptions);
    const { active, buckets } = parseStartBalance(balance);
    if (!active) {
      return { message: "This account has no active ZCode Start Plan or gift allowance." };
    }
    const quotas = {};
    for (const bucket of buckets) {
      const baseName = (bucket.planName ? bucket.planName + " · " : "") + bucket.name;
      let name = baseName;
      let suffix = 2;
      while (quotas[name]) name = baseName + " (" + suffix++ + ")";
      const remaining = Math.max(0, 100 - bucket.used);
      quotas[name] = {
        used: bucket.used,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: bucket.resetsAt,
        unlimited: false,
        usedUnits: bucket.usedUnits,
        totalUnits: bucket.totalUnits,
        remainingUnits: bucket.remainingUnits,
        period: bucket.period,
        models: bucket.models,
        aside: bucket.aside,
      };
    }
    return { plan: active.name, until: active.until, quotas };
  } catch (error) {
    return { message: "ZCode Start Plan error: " + error.message };
  }
}

/**
 * GLM Coding Plan usage, or ZCode Start Plan/gift buckets for OAuth accounts
 * without a Coding Plan.
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null, providerSpecificData = null) {
  const jwt = providerSpecificData?.zcodeJwtToken;
  if (jwt) {
    const { start } = await resolveGlmPlanMode(
      provider,
      { apiKey, accessToken: apiKey, providerSpecificData },
      proxyOptions,
    );
    if (start) return getStartPlanUsage(provider, jwt, proxyOptions);
  }
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(
      quotaUrl,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const { plan, quotas } = parseGlmQuotaResponse(json);
    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}
