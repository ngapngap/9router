/**
 * respondWithError.js — Safe error response helper.
 *
 * P12 (#24) MED-2: Wrap error.message để không leak internal details ra client.
 * Log full stack server-side, trả generic message ra response.
 *
 * Refs: https://github.com/ngapngap/9router/issues/24
 */
import { NextResponse } from "next/server";
import { redactSecrets } from "./redactSecrets.js";

/**
 * Return safe error response. Log internal error server-side (redacted).
 *
 * @param {Error|string} err — internal error
 * @param {number} [status=500] — HTTP status
 * @param {string} [publicMessage="Internal server error"] — message sent to client
 * @returns {NextResponse}
 */
export function respondWithError(err, status = 500, publicMessage = "Internal server error") {
  // Log internal (redacted) for debugging
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[respondWithError] ${status}: ${redactSecrets(msg)}`);

  return NextResponse.json(
    { error: publicMessage },
    { status }
  );
}
