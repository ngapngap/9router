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

// "insufficient" alone is not enough: the wallet refusal is "Insufficient points",
// which the old balance/credit-only alternative missed and left as a bare 402 —
// an account with no points was then retried for the full COOLDOWN.long window.
const QUOTA_WORDS = /额度|余额|积分|用完|用尽|quota|insufficient[_ ]?(balance|credit|point|fund)|exhausted/i;
// AutoClaw answers a paywalled model with HTTP 403 and an action envelope instead of
// a quota code: {"action":{"kind":"pay-view"},"code":810001,"image_url":"…",
// "message":"We're experiencing high demand right now. Please try again shortly, or
// upgrade to a monthly subscription for priority access."} — i.e. this plan does not
// include the model. It is an account-level refusal, not a transient overload, so it
// must not be retried on the same account after a token refresh.
const PAYWALL_CODE = "810001";
const PAYVIEW_KINDS = new Set(["pay-view", "pay-cn", "upgrade", "subscribe"]);
// How long a parsed refusal is remembered as "the last error" for the refresh shortcut.
const REFUSAL_MEMORY_MS = 30 * 1000;
const BANNED_WORDS = /\bbanned\b|封禁|封号|账号异常|账户异常|account (has been |is |was )?(suspended|frozen|disabled|blocked|restricted)/i;
// AutoClaw's queue system answers a request it will not start right now with HTTP 200 and
// an SSE stream that never carries an assistant delta:
//   event: zwork_queue
//   data: {"status":"queueing","title":"High demand right now",
//          "subtitle":"You're in the queue. Upgrade to a subscription for a dedicated
//                      priority queue.","upgrade_button_content":"Upgrade now"}
// The status is 200, so nothing upstream of the account loop sees a failure: the turn is
// recorded as a success, the client is handed a stream whose only payload is "you're in the
// queue", and no other account or combo member is ever tried — the request just dies with
// no retry. The queue event is a transient refusal, not content, so the leading frames are
// read here and raised as a real 429 before the body reaches chatCore.
const QUEUE_EVENT = /^event:\s*zwork_queue/m;
const QUEUE_STATUS = /"status"\s*:\s*"queueing"/;
const QUEUE_SUBTITLE = /"subtitle"\s*:\s*"([^"]*)"/;
// A normal turn's first frame proves the request was accepted; stop peeking at once so a
// healthy stream is never delayed. The queue frame arrives before any content frame.
const CONTENT_FRAME = /^data:\s*\{[^\n]*"choices"/m;
const QUEUE_PEEK_BYTES = 16 * 1024;
const QUEUE_PEEK_MS = 10 * 1000;

// True when a decoded buffer already shows the request was accepted (a content frame), so the
// peek can stop at once and hand the stream back untouched.
function sawContentFrame(text) {
  return CONTENT_FRAME.test(text);
}

// True when the queue refusal is already readable: the event line plus its `queueing` payload.
// Checked per chunk so the refusal is acted on without waiting for a close the upstream may
// never send — a queued upstream can hold the connection open indefinitely.
function sawQueueFrame(text) {
  return QUEUE_EVENT.test(text) && QUEUE_STATUS.test(text);
}

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
  // Upstream also fingerprints the model-name banner some CLI harnesses add
  // ("coding agent powered by the <model> model") - verified live 406 with the
  // exact string, 200 with any word swapped. Strip the model name mention.
  [/You are a coding agent powered by the [\w.\-]+ model/gi, "You are a coding agent powered by a GLM model."],
  // Claude Code env-info line: upstream fingerprints "powered by the model
  // glm-<name>" (dash after glm required - glm5.3 / glm53 / non-GLM model
  // names pass). Replace with a family-level mention.
  [/You are powered by the model glm-[\w.\-]+/gi, "You are powered by a GLM-family model"],
  // Hermes Agent (Nous Research) official opening sentences - refused whole,
  // single-word edits pass. Two live variants: "an intelligent AI assistant
  // created by" and the short comma form "built by" (the comma is required for
  // a refusal - dropping it or using a dash passes upstream).
  [/You are Hermes Agent, (?:an intelligent AI assistant )?(?:created|built|developed|made) by Nous Research/gi, "You are an intelligent AI assistant from Nous Research"],
  // Claude Code subagent (Task-tool) opener: "You are an agent for Claude
  // Code" is refused on its own (verified live) even after the identity
  // rewrite of the first line. Reword the phrase, keep meaning.
  [/You are an agent for Claude Code/gi, "You are an agent working with Claude Code"],
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

/**
 * Read only the head of a streaming 2xx response and report AutoClaw's queue refusal.
 *
 * The queue event is the one refusal that hides behind a success status, so no status-based
 * rule can catch it: the account loop, the combo loop and the request log all see `ok`. It
 * must be caught before the body is handed to the stream layer, because by then the client
 * already has a 200 and only the queue payload.
 *
 * Returns null when there is nothing to peek (no body, non-2xx, non-SSE). Otherwise returns
 * `{ queued, response }`: `queued: true` with a 429 to fall through to the next account or
 * combo member, or `queued: false` with the same stream rebuilt byte for byte (the peek
 * consumed its head, so the original body is gone either way). The peek fails open on its
 * byte/time bound — a slow but healthy stream is never turned into an error.
 */
async function queueRefusal(response, signal = null) {
  if (!response?.body || Number(response.status) >= 400) return null;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const head = [];
  let text = "";
  let timer = null;
  let ended = false;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve("__deadline__"), QUEUE_PEEK_MS); });

  try {
    while (text.length < QUEUE_PEEK_BYTES) {
      if (signal?.aborted) break; // client gone: fail open, the stream layer reports it
      const res = await Promise.race([reader.read(), deadline]);
      if (res === "__deadline__") break; // bound reached: fail open
      const { done, value } = res;
      if (done) { ended = true; break; }
      head.push(value);
      text += decoder.decode(value, { stream: true });
      // The queue frame is complete as soon as its data line arrives — decide on it right
      // away instead of waiting for the stream to close (the upstream may hold it open).
      if (sawQueueFrame(text)) break;
      if (sawContentFrame(text)) break; // a real turn: stop peeking at once
    }
    if (ended || (!sawContentFrame(text) && !sawQueueFrame(text))) text += decoder.decode();
  } catch {
    // A read error belongs to the stream layer, not here: replay and let it report.
    ended = true;
  } finally {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  const queued = sawQueueFrame(text);

  if (queued) {
    // Nothing in a queue stream is usable: drop it and report a real rate limit.
    try { await reader.cancel(); } catch { /* already closed */ }
    const said = QUEUE_SUBTITLE.exec(text)?.[1] || "You're in the queue.";
    return {
      queued: true,
      response: new Response(JSON.stringify({
        error: {
          message: "AutoClaw: " + said + " — upstream answered HTTP 200 with a queue event instead of a completion",
          type: "rate_limit_error",
          code: 810003,
        },
      }), { status: 429, headers: { "Content-Type": "application/json" } }),
    };
  }

  // Healthy (or unreadable): rebuild the body so the consumed bytes are replayed in order.
  // `ended` means the peek already drained the whole stream, so the head it buffered IS the
  // complete body — nothing is left to read.
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
    },
    async pull(controller) {
      if (ended) { controller.close(); return; }
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { try { reader.cancel(reason); } catch { /* already closed */ } },
  });
  return {
    queued: false,
    response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }),
  };
}

class AutoClawExecutorBase extends DefaultExecutor {
  parseError(response, bodyText) {
    const paywall = this.readPaywall(response, bodyText);
    if (paywall) return paywall;
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
          this.lastPaywall = Date.now();
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
  /**
   * True when the last error this executor produced was a paywall / no-points refusal.
   * A refused account answers the same way after a token refresh, so chatCore must
   * not spend a refresh and a duplicate request on it.
   */
  lastRefusalWasPaywall(withinMs = REFUSAL_MEMORY_MS) {
    return Boolean(this.lastPaywall && Date.now() - this.lastPaywall <= withinMs);
  }

  /**
   * A paywall / no-points refusal, or null.
   *
   * Both AutoClaw refusals are account-scoped and NOT recoverable by refreshing the
   * token: a 403 pay-view (plan does not include the model) and a 402 "Insufficient
   * points". Reporting them as 401/403/402 makes chatCore spend a token refresh and
   * an identical retry on the same dead account before the account loop ever sees
   * the error. They are reported as 429 instead — the one status the account loop
   * treats as "this account cannot serve it, move on" — the same normalisation
   * minimax-code applies to its credit refusals.
   */
  readPaywall(response, bodyText) {
    const status = Number(response?.status);
    if (status !== 402 && status !== 403) return null;
    let message = "";
    let code = null;
    let kind = null;
    try {
      const d = JSON.parse(String(bodyText || ""));
      message = String(d?.message ?? d?.msg ?? d?.error?.message ?? "").trim();
      code = d?.code ?? d?.error?.code ?? null;
      kind = d?.action?.kind ?? d?.error?.action?.kind ?? null;
    } catch { /* not JSON: fall through to the word list below */ }

    const paywall = String(code) === PAYWALL_CODE
      || (kind && PAYVIEW_KINDS.has(String(kind)))
      || QUOTA_WORDS.test(message);
    if (!paywall) return null;
    this.lastPaywall = Date.now();
    return {
      status: 429,
      message: "AutoClaw: " + (message || (kind === "pay-view" ? "plan does not include this model" : "no quota left on this account")),
      resetsAtMs: null,
    };
  }

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

  async execute(options) {
    const result = await super.execute(options);
    // A queue refusal arrives as HTTP 200, so it survives every status check inside
    // base.execute(). Adopt it as the real response here: the caller then sees a 429,
    // rotates to the next account, and the combo falls through to the next member.
    // A healthy stream comes back rebuilt with its peeked head replayed intact, and a
    // refusal is remembered like the other account-scoped ones so chatCore skips the
    // token refresh (a queue slot does not improve because the token was re-minted).
    const peeked = await queueRefusal(result.response, options?.signal);
    if (!peeked) return result;
    if (peeked.queued) this.lastPaywall = Date.now();
    return { ...result, response: peeked.response };
  }
}

export default AutoClawExecutor;
