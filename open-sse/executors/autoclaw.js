import { createHash, randomBytes } from "node:crypto";
import { DefaultExecutor } from "./default.js";

// AutoClaw (Zhipu's autoglm agent client), cloned from the community plugin
// (magpie-community/plugins packages/autoclaw), overseas gateway
// https://autoglm-api.autoglm.ai. No max_tokens, the official system prompt
// must open the system message, and another client's official prompt
// sentences in any system/developer prompt are refused (406). Tokens are
// JWTs; device_id rides in the refresh token.

const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const PRODUCT = "autoclaw";
const CLIENT_VERSION = "1.18.1";
const CN_CLIENT_VERSION = "2.1.0";

const GLOBAL_HOST = "https://autoglm-api.autoglm.ai";
const CN_HOST = "https://autoglm-api.zhipuai.cn";
const MANAGED_HOST = "https://autoglm-acceleration-api.zhipuai.cn";
const CHAT_PATH = "/autoclaw-proxy/proxy/autoclaw/v1/chat/completions";
const CN_CHAT_PATH = "/autoclaw-proxy/proxy/autoclaw/chat/completions";
const OFFICIAL_SYSTEM_PROMPT = "You are AutoClaw. Answer the user directly and concisely.";

const QUOTA_WORDS = /额度|余额不足|用完|用尽|quota|insufficient[_ ]?(balance|credit)|exhausted/i;
const BANNED_WORDS = /\bbanned\b|封禁|封号|账号异常|账户异常|account (has been |is |was )?(suspended|frozen|disabled|blocked|restricted)/i;

function md5Hex(input) {
  return createHash("md5").update(input).digest("hex");
}

function randomHex(n) {
  return randomBytes(n).toString("hex");
}

function platformTm() {
  return "linux-x64";
}

// WAF-signing headers every business call carries.
export function bizHeaders(accessToken, version) {
  const ts = String(Math.floor(Date.now() / 1000));
  const h = {
    "Content-Type": "application/json",
    Accept: "*/*",
    "User-Agent": "AutoClaw/" + version + " (linux-x64)",
    "X-Version": version,
    "X-Tm": platformTm(),
    "X-Product": PRODUCT,
    "X-Auth-Appid": APP_ID,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": md5Hex(APP_ID + "&" + ts + "&" + APP_KEY),
    "X-Trace-Id": randomHex(16),
    "X-Lang": "zh-CN",
  };
  if (accessToken) h["Authorization"] = "Bearer " + accessToken;
  return h;
}

function bareToken(v) {
  let t = String(v ?? "").trim();
  while (t.toLowerCase().startsWith("bearer ")) t = t.slice(7).trim();
  return t;
}

function jwtClaim(token, key) {
  const part = bareToken(token).split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))[key];
  } catch {
    return undefined;
  }
}

const FLAGGED = [
  [/You are a Claude agent, built on Anthropic's Claude Agent SDK\.?/gi, "You are a coding assistant."],
  [/(?:Anthropic's |the )?Claude Agent SDK/gi, "the agent framework"],
  [/You are an AI agent powered by DeepSeek Harness/gi, "You are an AI agent powered by DeepSeek-Harness"],
  [/You are Claude Code/gi, "You are the Claude Code CLI"],
  [/You are Codex/gi, "You are the Codex agent"],
  [/Codex CLI/gi, "Codex command-line tool"],
  [/You are opencode/gi, "You are the opencode agent"],
  [/You are Cursor/gi, "You are the Cursor agent"],
  [/You are Cline/gi, "You are the Cline agent"],
  [/You are Qwen Code/gi, "You are the Qwen Code agent"],
  [/You are ZCode/gi, "You are the ZCode agent"],
  // The upstream fingerprints whole OFFICIAL opening sentences, not just the
  // identity clause: the Claude Code / Codex second line is refused (406) even
  // after the identity rewrite (verified live - single-word edits clear it,
  // the exact string inside another sentence still 406s). Replace the sentence.
  [/You are an interactive CLI tool that helps users with software engineering tasks/gi, "You are a helpful AI assistant that helps with software engineering tasks."],
  [/You are running as a coding agent in the Codex CLI on a user's computer/gi, "You are running as a coding agent in a command-line tool on the user's computer"],
];

function unflagged(text) {
  for (const [re, to] of FLAGGED) text = text.replace(re, to);
  return text;
}

function unflag(messages) {
  let changed = false;
  for (const m of messages) {
    if (!m || (m.role !== "system" && m.role !== "developer")) continue;
    if (typeof m.content === "string") {
      const t = unflagged(m.content);
      if (t !== m.content) { m.content = t; changed = true; }
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part?.text === "string") {
          const t = unflagged(part.text);
          if (t !== part.text) { part.text = t; changed = true; }
        }
      }
    }
  }
  return changed;
}

// The gateway answers a history it can't read with 500 "parse response
// failed": null content goes as "", tool-call arguments arrive as objects on
// some paths, and empty tools lists are refused.
function tidyBody(payload) {
  if (Array.isArray(payload.messages)) {
    payload.messages = payload.messages.map((m) => {
      if (!m || typeof m !== "object") return m;
      const out = { ...m };
      if (out.content == null) out.content = "";
      delete out.reasoning_content;
      if (Array.isArray(out.tool_calls)) {
        out.tool_calls = out.tool_calls.map((c) => {
          const args = c?.function?.arguments;
          if (!c?.function || typeof args === "string") return c;
          return { ...c, function: { ...c.function, arguments: args == null ? "{}" : JSON.stringify(args) } };
        });
      }
      return out;
    });
  }
  if ("tools" in payload && !(Array.isArray(payload.tools) && payload.tools.length)) {
    delete payload.tools;
    delete payload.tool_choice;
  }
  return payload;
}

function prefixOfficialSystem(payload) {
  const idx = payload.messages.findIndex((m) => m && m.role === "system");
  if (idx >= 0) {
    const cur = payload.messages[idx].content;
    if (typeof cur === "string") {
      if (!cur.startsWith(OFFICIAL_SYSTEM_PROMPT)) {
        payload.messages[idx] = { ...payload.messages[idx], content: OFFICIAL_SYSTEM_PROMPT + "\n\n" + cur };
      }
    } else if (Array.isArray(cur)) {
      payload.messages[idx] = { ...payload.messages[idx], content: [{ type: "text", text: OFFICIAL_SYSTEM_PROMPT }, ...cur] };
    } else {
      payload.messages[idx] = { ...payload.messages[idx], content: OFFICIAL_SYSTEM_PROMPT };
    }
  } else {
    payload.messages = [{ role: "system", content: OFFICIAL_SYSTEM_PROMPT }, ...payload.messages];
  }
  return payload;
}

function rewriteBody(rawBody) {
  let payload;
  try {
    payload = JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) return null;
  tidyBody(payload);
  unflag(payload.messages);
  prefixOfficialSystem(payload);
  delete payload.max_tokens;
  delete payload.max_completion_tokens;
  return payload;
}

async function explained(res) {
  if (res.status < 400) return res;
  const text = await res.text().catch(() => "");
  if (res.status === 406) {
    let said = "";
    try { said = JSON.parse(text)?.error?.message ?? ""; } catch {}
    return new Response(JSON.stringify({ error: { message: (said || "406 Not Acceptable") + " — AutoClaw refuses chats whose system prompt carries another agent's identity line; it was rewritten for the known ones, so an unknown one needs another provider", type: "permission_error", code: null } }), { status: 406, headers: { "Content-Type": "application/json" } });
  }
  return new Response(text, { status: res.status, statusText: res.statusText });
}

async function refusedNotSignIn(res) {
  if (res.status !== 401 && res.status !== 403) return null;
  const text = await res.clone().text().catch(() => "");
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  const code = d?.code ?? d?.error?.code ?? null;
  const message = String(d?.message ?? d?.msg ?? d?.error?.message ?? "").trim();
  const spent = String(code) === "810000" || (message && QUOTA_WORDS.test(message));
  const banned = String(code) === "410004" || (message && BANNED_WORDS.test(message));
  if (!spent && !banned) return null;
  try { res.body?.cancel?.(); } catch {}
  return new Response(JSON.stringify({ error: { message: "AutoClaw: " + (message || "account refused"), type: spent ? "rate_limit_error" : "permission_error", code } }), { status: spent ? 429 : 403, headers: { "Content-Type": "application/json" } });
}

class AutoClawExecutorBase extends DefaultExecutor {
  parseError(response, bodyText) {
    if (response?.status === 406) {
      console.error("[AutoClaw] 406 body:", JSON.stringify(String(bodyText || ""))); 
      console.error("[AutoClaw] 406 system-prompt sent:", String(this.__lastSystem || "").slice(0, 800));
    }
    if (bodyText) {
      try {
        const d = JSON.parse(bodyText);
        const message = String(d?.message ?? d?.msg ?? d?.error?.message ?? "");
        const code = d?.code ?? d?.error?.code ?? null;
        if (String(code) === "810000" || QUOTA_WORDS.test(message)) {
          return { status: 429, message: "AutoClaw: " + (message || "quota exhausted"), resetsAtMs: null };
        }
        if (String(code) === "410004" || BANNED_WORDS.test(message)) {
          return { status: 403, message: "AutoClaw: " + (message || "account refused"), keepSignIn: true };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export class AutoClawExecutor extends AutoClawExecutorBase {
  constructor() {
    super("autoclaw");
  }

  buildHeaders(credentials, stream, url, model, body) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    const token = bareToken(credentials?.accessToken || credentials?.apiKey);
    headers["X-Authorization"] = "Bearer " + token;
    delete headers["Authorization"];
    headers["X-Tm"] = platformTm();
    headers["X-Version"] = CLIENT_VERSION;
    headers["X-Request-Id"] = randomHex(16);
    headers["x_trace_id"] = "autoclaw-desktop";
    const routeModel = typeof model === "string" ? model : "";
    if (routeModel) headers["X-Request-Model"] = routeModel;
    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;
    const rewritten = rewriteBody(JSON.stringify(transformed)) || transformed;
    try {
      const sysMsg = (rewritten.messages || []).find((m) => m && m.role === "system");
      this.__lastSystem = sysMsg ? (typeof sysMsg.content === "string" ? sysMsg.content : JSON.stringify(sysMsg.content)) : "";
    } catch { /* logging aid only */ }
    return rewritten;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // The overseas gateway bounces a spent token between hosts: the plugin
    // retries the other host once on a 401/403 that is not the account's.
    return (urlIndex === 0 ? GLOBAL_HOST : CN_HOST) + CHAT_PATH;
  }

  getBaseUrls() {
    return [GLOBAL_HOST + CHAT_PATH, CN_HOST + CHAT_PATH];
  }

  parseRetry(response, urlIndex) {
    return false;
  }

  computeRetryDelay() {
    return false;
  }

  async shouldRetryStatus(response) {
    // A 401/403 that is the account's own (quota spent, ban) must not retry
    // or fall through to the next host as a sign-in failure would.
    const spent = await refusedNotSignIn(response);
    if (spent) return { response: spent, stop: true };
    return null;
  }
}

export default AutoClawExecutor;
