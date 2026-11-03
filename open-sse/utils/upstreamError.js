/**
 * Upstream error thrown as a Response.
 *
 * Some upstream failures cannot be expressed as an HTTP status at all: Z.ai
 * answers a structurally valid Start-Plan request with HTTP 200 and the JSON
 * body `{"code":1005,"msg":"exceed quota limit"}` — an application-level refusal
 * that is not an Anthropic message, not an SSE stream, and not an `error`
 * object. The generic paths either record it as a successful turn with no
 * output or turn it into an "unknown format" 502.
 *
 * `throwUpstreamError` raises this instead so the NORMAL error path (retry
 * classification, token refresh, the ✗ ERROR log line, account fallback) sees a
 * real 4xx/5xx status on the streaming and the non-streaming path alike, without
 * each handler knowing about the upstream's envelope.
 */

// Extends Error through a real prototype chain so `instanceof` survives the
// bundler and so `.name`/`.stack` behave like every other thrown value.
export class UpstreamError extends Error {
  /** @param {Response} response Upstream-shaped error response (status >= 400) */
  constructor(response, message) {
    super(message);
    this.name = "UpstreamError";
    this.response = response;
    this.status = response?.status || 502;
  }
}

/** True when `error` (or anything in its `cause` chain) is an UpstreamError. */
export function asUpstreamError(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof UpstreamError) return current;
    // Cross-module copies (standalone engine vs app bundle) can disagree on the
    // constructor identity; the marker on the instance is authoritative.
    if (current.name === "UpstreamError" && current.response instanceof Response) {
      return new UpstreamError(current.response, current.message || "upstream error");
    }
    current = current.cause;
  }
  return null;
}

/** Throw helper so a call site reads as one statement. */
export function throwUpstreamError(response, message) {
  throw new UpstreamError(response, message);
}
