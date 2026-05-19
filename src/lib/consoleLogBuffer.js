/**
 * consoleLogBuffer.js — Patched console.* capture với SaaS guard + redact.
 *
 * P09 (#21):
 *   - Mỗi log entry tag userId từ ALS (fallback "system" nếu ngoài tenant context).
 *   - Redact 3 pattern bí mật (Bearer, sk-*, Basic) trước khi push vào buffer.
 *   - getConsoleLogs({ userId }) filter theo user cho admin endpoint.
 *
 * SaaS mode: disable hẳn trừ khi SAAS_ENABLE_CONSOLE_LOGS_FOR_ADMIN=true.
 *
 * Refs: https://github.com/ngapngap/9router/issues/21
 */
import { EventEmitter } from "events";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config.js";
import { getTenantUserId } from "@/lib/saas/tenantContext.js";

const consoleLevels = ["log", "info", "warn", "error", "debug"];

if (!global._consoleLogBufferState) {
  global._consoleLogBufferState = {
    logs: [],
    patched: false,
    originals: {},
    emitter: new EventEmitter(),
  };
  global._consoleLogBufferState.emitter.setMaxListeners(50);
}

const state = global._consoleLogBufferState;

// Ensure emitter exists (handles hot reload with stale global)
if (!state.emitter) {
  state.emitter = new EventEmitter();
  state.emitter.setMaxListeners(50);
}

function toLogLine(level, args) {
  return args.map(formatArg).join(" ");
}

// Strip ANSI escape codes so terminal colors don't bleed into UI
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

function formatArg(arg) {
  if (typeof arg === "string") return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack || arg.message || String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

// P09 (#21): Redact secrets trước khi push vào buffer.
const REDACT_PATTERNS = [
  { regex: /Bearer\s+[A-Za-z0-9._\-]+/g, replace: "Bearer [REDACTED]" },
  { regex: /sk-[A-Za-z0-9]+/g, replace: "sk-[REDACTED]" },
  { regex: /Basic\s+[A-Za-z0-9+/=]+/g, replace: "Basic [REDACTED]" },
];

function redactSecrets(str) {
  let out = str;
  for (const p of REDACT_PATTERNS) {
    out = out.replace(p.regex, p.replace);
  }
  return out;
}

function appendLine(level, line) {
  // P09 (#21): tag userId + redact secrets
  let userId = null;
  try { userId = getTenantUserId(); } catch { /* ngoài ALS context */ }
  const entry = {
    ts: Date.now(),
    level,
    line: redactSecrets(line),
    userId: userId ?? "system",
  };
  state.logs.push(entry);
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
  }
  state.emitter.emit("line", entry);
}

export function initConsoleLogCapture() {
  if (state.patched) return;

  // SaaS isolation: the buffer is global to the process and would mix logs
  // across every tenant (API keys, paths, models, errors). Disable capture
  // entirely unless the operator explicitly opts in.
  if (process.env.SAAS_ENABLED === "true" && process.env.SAAS_ENABLE_CONSOLE_LOGS_FOR_ADMIN !== "true") {
    state.patched = true; // mark patched so we don't re-check on every request
    return;
  }

  for (const level of consoleLevels) {
    state.originals[level] = console[level];
    console[level] = (...args) => {
      appendLine(level, toLogLine(level, args));
      state.originals[level](...args);
    };
  }

  state.patched = true;
}

/**
 * Lấy console logs. Trong SaaS mode, admin có thể filter theo userId.
 * @param {{ userId?: string|number }} [opts]
 * @returns {Array<{ts:number, level:string, line:string, userId:string|number}>}
 */
export function getConsoleLogs(opts) {
  if (opts?.userId != null) {
    return state.logs.filter(e => e.userId == opts.userId);
  }
  return state.logs;
}

export function clearConsoleLogs() {
  state.logs = [];
  state.emitter.emit("clear");
}

export function getConsoleEmitter() {
  return state.emitter;
}
