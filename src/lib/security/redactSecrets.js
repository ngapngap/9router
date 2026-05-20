/**
 * redactSecrets.js — Strip sensitive patterns from strings before logging.
 *
 * P12 (#24) HIGH-7. Dùng cho mọi console.error(err.message) upstream-related.
 *
 * Refs: https://github.com/ngapngap/9router/issues/24
 */

const PATTERNS = [
  { regex: /Bearer\s+[A-Za-z0-9._\-]+/g, replace: "Bearer [REDACTED]" },
  { regex: /sk-[A-Za-z0-9]{20,}/g, replace: "sk-[REDACTED]" },
  { regex: /Basic\s+[A-Za-z0-9+/=]+/g, replace: "Basic [REDACTED]" },
  { regex: /key[=:]\s*["']?[A-Za-z0-9_\-]{20,}/gi, replace: "key=[REDACTED]" },
];

/**
 * Redact known secret patterns from a string.
 * @param {string} str
 * @returns {string}
 */
export function redactSecrets(str) {
  if (typeof str !== "string") return String(str ?? "");
  let out = str;
  for (const p of PATTERNS) {
    out = out.replace(p.regex, p.replace);
  }
  return out;
}
