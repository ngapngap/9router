import { handleFetch } from "@/sse/handlers/fetch.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/web/fetch - Web URL fetch/extract endpoint
 */
export async function POST(request) {
  const { saasV1Entry } = await import("@/lib/saas/v1Request.js");
  return saasV1Entry(() => handleFetch(request));
}
