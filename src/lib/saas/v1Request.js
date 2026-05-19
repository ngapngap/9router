/**
 * Wrap v1 handlers so AsyncLocalStorage tenant tồn tại trước khi validateApiKey gắn userId.
 * @template T
 * @param {() => Promise<T>} fn
 */
export async function saasV1Entry(fn) {
  if (process.env.SAAS_ENABLED !== "true") return fn();
  const { runWithTenant } = await import("./tenantContext.js");
  return runWithTenant(fn);
}

/**
 * GET/POST v1: tenant ALS + Bearer (khi SaaS). Handler không cần tự validate.
 * @template T
 * @param {Request} request
 * @param {() => Promise<T>} inner
 */
export async function runV1WithBearerAuth(request, inner) {
  return saasV1Entry(async () => {
    if (process.env.SAAS_ENABLED !== "true") {
      return inner();
    }
    const { extractApiKey, isValidApiKey } = await import("@/sse/services/auth.js");
    const apiKey = extractApiKey(request);
    if (!apiKey) {
      return Response.json(
        { error: { message: "Missing API key", type: "invalid_request_error" } },
        { status: 401, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
    if (!(await isValidApiKey(apiKey))) {
      return Response.json(
        { error: { message: "Incorrect API key", type: "invalid_request_error" } },
        { status: 401, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    // P11 (#22): quota guard pre-flight — reject 402 if user quota exhausted
    const { getTenantUserId } = await import("./tenantContext.js");
    const userId = getTenantUserId();
    if (userId != null) {
      const { assertQuotaForRequest } = await import("./quotaGuard.js");
      const quotaCheck = await assertQuotaForRequest({ userId, model: "unknown", provider: "unknown" });
      if (!quotaCheck.allowed) {
        return Response.json(
          { error: quotaCheck.error },
          { status: 402, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }
    }

    return inner();
  });
}
