import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as machineIdPkg from "node-machine-id";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { PROVIDERS } from "../providers/index.js";

// ZCode Start Plan support, ported from magpie's retired zcode built-in.
// Coding-plan requests keep using api.z.ai and the account's API key. Start
// Plan requests use zcode.z.ai, the OAuth session JWT, ZCode's own headers,
// and the Anthropic request shape its client sends.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const machineIdSync = machineIdPkg.machineIdSync;
const decisions = new Map();
const TTL_SURE_MS = 10 * 60_000;
const TTL_UNSURE_MS = 60_000;

let promptCache = null;
function zcodePrompt() {
  if (!promptCache) {
    promptCache = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../config/zcode-prompt.json"), "utf8"),
    );
  }
  return promptCache;
}

export function startPlanConfig(provider = "glm") {
  return PROVIDERS[provider]?.startPlan || null;
}

function uuidOf(seed, version = 4) {
  const hex = crypto.createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    String(version) + hex.slice(13, 16),
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

// A stable, uuid-shaped identifier for this machine. It is not read from the
// ZCode app and is never derived from the account token.
let deviceMidCache = null;
export function deviceMid() {
  if (deviceMidCache) return deviceMidCache;
  let rawId;
  try {
    const machineIdSync = machineIdPkg.machineIdSync || machineIdPkg.default?.machineIdSync;
    if (typeof machineIdSync !== "function") throw new Error("node-machine-id is unavailable");
    rawId = machineIdSync();
  } catch {
    rawId = crypto.randomUUID();
  }
  deviceMidCache = uuidOf("zcode-device-mid:" + rawId);
  return deviceMidCache;
}

// ZCode's x-session-id is a bare UUID. Preserve a client-provided UUID;
// otherwise derive a stable v3-shaped UUID from the conversation seed.
export function zcodeSessionId(seed) {
  const value = typeof seed === "string" ? seed.trim() : "";
  if (value) {
    const bare = value.toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bare)) return bare;
    const withoutTurn = bare.replace(/-\d+$/, "");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(withoutTurn)) return withoutTurn;
    return uuidOf("session\u0000" + value, 3);
  }
  return uuidOf("session\u0000" + deviceMid(), 3);
}

export function decodeJwtExp(jwt) {
  try {
    const parts = String(jwt || "").split(".");
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return Number(payload.exp) || 0;
  } catch {
    return 0;
  }
}

export function isJwtExpired(jwt) {
  const exp = decodeJwtExp(jwt);
  return exp > 0 && Date.now() / 1000 > exp;
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function fetchJson(url, headers, proxyOptions = null) {
  const response = await proxyAwareFetch(url, { headers }, proxyOptions);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Handled below as an invalid success payload or an HTTP error.
  }
  if (!response.ok) {
    const error = new Error("HTTP " + response.status + ": " + text.slice(0, 200));
    error.status = response.status;
    throw error;
  }
  // Z.ai business endpoints wrap payloads in { code, msg, data }.
  if (json && typeof json === "object" && !Array.isArray(json) && "code" in json) {
    const code = Number(json.code);
    if (code === 0 || code === 200) return json.data;
    const error = new Error("code " + json.code + ": " + String(json.msg || "Z.ai request failed"));
    error.code = json.code;
    throw error;
  }
  return json;
}

async function fetchSubscriptions(provider, key, proxyOptions) {
  const cfg = startPlanConfig(provider);
  if (!cfg) throw new Error("ZCode Start Plan is not configured for " + provider);
  // This endpoint takes the coding-plan key bare, without "Bearer".
  const subscriptions = await fetchJson(cfg.subscriptionListUrl, {
    Authorization: key,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "ZCode/" + cfg.appVersion,
  }, proxyOptions);
  if (!Array.isArray(subscriptions)) throw new Error("Unexpected Z.ai subscription response");
  return subscriptions;
}

export async function fetchStartBalance(provider, jwt, proxyOptions = null) {
  const cfg = startPlanConfig(provider);
  if (!cfg) throw new Error("ZCode Start Plan is not configured for " + provider);
  if (!jwt) throw new Error("Not signed in to ZCode");
  if (isJwtExpired(jwt)) {
    const error = new Error("ZCode's sign-in has expired; sign in to ZCode again");
    error.status = 401;
    throw error;
  }
  const data = await fetchJson(cfg.balanceUrl + "?app_version=" + encodeURIComponent(cfg.appVersion), {
    Authorization: "Bearer " + jwt,
    Accept: "application/json",
    "User-Agent": "ZCode/" + cfg.appVersion,
    "X-Device-Mid": deviceMid(),
  }, proxyOptions);
  if (!data || typeof data !== "object") throw new Error("Unexpected ZCode balance response");
  return data;
}

function isStartPlanName(value) {
  return /start[- ]plan|体验/i.test(String(value || ""));
}

export function balanceActivePlan(balance, nowSec = Date.now() / 1000) {
  nowSec = num(balance?.server_time) ?? nowSec;
  for (const plan of Array.isArray(balance?.plans) ? balance.plans : []) {
    if (String(plan?.status || "").trim().toLowerCase() !== "active") continue;
    const id = String(plan?.plan_id || "").trim();
    const name = String(plan?.name || "").trim();
    if ((id || name) && !isStartPlanName(id) && !isStartPlanName(name)) continue;
    const end = num(plan?.ends_at) || 0;
    if (end > 0 && end <= nowSec) continue;
    return {
      name: name || "Start Plan",
      until: end > 0 ? new Date(end * 1000).toISOString() : null,
    };
  }
  return null;
}

function cacheDecision(cacheKey, start, sure) {
  decisions.set(cacheKey, { start, at: Date.now(), ttl: sure ? TTL_SURE_MS : TTL_UNSURE_MS });
  return start;
}

function decisionKey(provider, credentials) {
  const jwt = credentials?.providerSpecificData?.zcodeJwtToken || "";
  const key = credentials?.apiKey || credentials?.accessToken || "";
  return provider + "\u0000" + key + "\u0000" + jwt;
}

export function invalidateGlmPlanMode(provider, credentials) {
  decisions.delete(decisionKey(provider, credentials));
}

// Decide per account, with magpie's sure/unsure TTLs. An expired JWT is still
// kept on the Start Plan path when the account has no Coding Plan so the
// executor can return an actionable re-login error instead of a paid-plan 1113.
export async function resolveGlmPlanMode(provider, credentials, proxyOptions = null, log = null) {
  const jwt = credentials?.providerSpecificData?.zcodeJwtToken;
  if (!jwt) return { start: false };
  const key = credentials?.apiKey || credentials?.accessToken || "";
  if (!key) return { start: true };

  const cacheKey = decisionKey(provider, credentials);
  const cached = decisions.get(cacheKey);
  if (cached && Date.now() - cached.at < cached.ttl) return { start: cached.start };

  try {
    const subscriptions = await fetchSubscriptions(provider, key, proxyOptions);
    const hasCodingPlan = subscriptions.some(
      (item) => String(item?.status || "").toLowerCase() === "valid" && Boolean(item?.productName),
    );
    return { start: cacheDecision(cacheKey, !hasCodingPlan, true) };
  } catch (subscriptionError) {
    try {
      const balance = await fetchStartBalance(provider, jwt, proxyOptions);
      if (balanceActivePlan(balance)) return { start: cacheDecision(cacheKey, true, true) };
    } catch (balanceError) {
      log?.debug?.("ZCODE", "plan decision fallback failed: " + (balanceError?.message || balanceError));
    }
    log?.debug?.("ZCODE", "subscription check failed: " + (subscriptionError?.message || subscriptionError));
    return { start: cacheDecision(cacheKey, false, false) };
  }
}

function zcodePlatform() {
  return process.platform;
}

function zcodeArch() {
  return process.arch;
}

// The environment prompt retains the built-in's platform/release/arch text.
function zcodePromptOsVersion() {
  return [zcodePlatform(), os.release(), zcodeArch()].join(" ");
}

// Exact 0.1.32 plugin source-header allowlist. Agent headers (anthropic-beta,
// x-app, x-stainless-*, request/trace ids, ...) are deliberately absent.
export function zcodeSourceHeaders(provider = "glm", sessionId = "") {
  const cfg = startPlanConfig(provider);
  const appVersion = cfg?.appVersion;
  const platform = zcodePlatform();
  const category = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "User-Agent": "ZCode/" + appVersion,
    "X-ZCode-App-Version": appVersion,
    "X-Platform": platform + "-" + zcodeArch(),
    "X-Os-Category": category,
    "X-Os-Version": os.release(),
    "X-Release-Channel": "production",
    "X-Client-Language": "unknown",
    "X-Client-Timezone": "unknown",
  };
  if (sessionId) headers["x-session-id"] = sessionId;
  return headers;
}

export function zcodeUserId(sessionId = "") {
  return JSON.stringify({ device_id: deviceMid(), account_uuid: "", session_id: sessionId });
}

const CWD_RE = /(?:^\s*-?\s*(?:Primary working directory|Working directory):[ \t]*([^\r\n]+?)[ \t]*$|<cwd>([^<\r\n]+)<\/cwd>)/m;

function gitSaid(text) {
  const matches = [...String(text || "").matchAll(/^\s*(?:- )?Is (?:a git repository|directory a git repo): (true|false|yes|no)\s*$/gim)];
  if (!matches.length) return "";
  return /^(?:true|yes)$/i.test(matches[matches.length - 1][1]) ? "yes" : "no";
}

function gitOnDisk(directory) {
  try {
    if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) return "";
    let current = path.resolve(directory);
    while (true) {
      if (fs.existsSync(path.join(current, ".git"))) return "yes";
      const parent = path.dirname(current);
      if (parent === current) return "no";
      current = parent;
    }
  } catch {
    return "";
  }
}

function zcodePlace(texts) {
  for (const text of texts) {
    const match = CWD_RE.exec(text || "");
    if (!match) continue;
    const directory = String(match[1] || match[2] || "").trim();
    const said = gitSaid(text);
    return { directory, git: said || (directory ? gitOnDisk(directory) : "") };
  }
  return { directory: "", git: "" };
}

function zcodeSystemBlocks(providerName, model, directory, git, ownSections = []) {
  const prompt = zcodePrompt();
  const env = prompt.environment;
  const lines = [env.heading, env.invokedLine];
  if (directory) {
    lines.push("- " + env.cwdLabel + ": " + directory);
    if (git === "yes") lines.push("- " + env.gitLabel + ": yes");
    if (git === "no") lines.push("- " + env.gitLabel + ": " + env.gitNo);
  }
  lines.push("- " + env.platformLabel + ": " + zcodePlatform());
  lines.push("- " + env.osVersionLabel + ": " + zcodePromptOsVersion());
  if (model) {
    lines.push(String(env.poweredByLine).replace("{provider}", providerName).replace("{model}", model));
  }
  const cached = (text) => ({ type: "text", text, cache_control: { type: "ephemeral" } });
  const dynamic = "\n\n" + [prompt.beforeEnvironment, lines.join("\n"), ...ownSections, prompt.afterEnvironment].join("\n\n");
  return [
    cached(prompt.prefix),
    cached(prompt.stable + "\n\n" + prompt.desktop),
    cached(dynamic),
  ];
}

function localDate(now) {
  const date = now || new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function zcodeDateReminder(now) {
  const context = zcodePrompt().context;
  const text = [
    context.intro,
    context.currentDateHeading + "\n" + String(context.currentDateLine).replace("{date}", localDate(now)),
    "",
    context.outro,
  ].join("\n");
  return {
    role: "user",
    content: [{ type: "text", text: "<system-reminder>" + text + "</system-reminder>" }],
  };
}

export const ZCODE_TOOL_SEARCH = "ToolSearch";
export const ZCODE_TOOL_SEARCH_ALIAS = "ToolSearchTool";

function containsToolSearch(value) {
  if (Array.isArray(value)) return value.some(containsToolSearch);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "name" && child === ZCODE_TOOL_SEARCH) return true;
    if (key === "type" && typeof child === "string" && child.startsWith("tool_search_tool_result_")) return true;
    if (containsToolSearch(child)) return true;
  }
  return false;
}

function rewriteToolSearch(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((child) => {
      const next = rewriteToolSearch(child);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? output : value;
  }
  if (!value || typeof value !== "object") return value;
  let output = null;
  for (const [key, child] of Object.entries(value)) {
    if (key === "defer_loading") {
      output ||= { ...value };
      delete output[key];
      continue;
    }
    let next;
    if (key === "name" && child === ZCODE_TOOL_SEARCH) next = ZCODE_TOOL_SEARCH_ALIAS;
    else if (key === "type" && typeof child === "string" && child.startsWith("tool_search_tool_result_")) next = "tool_result";
    else next = rewriteToolSearch(child);
    if (next !== child) {
      output ||= { ...value };
      output[key] = next;
    }
  }
  return output || value;
}

// Claude Code's ToolSearch is named ToolSearchTool on ZCode's plans; deferred
// schemas are sent inline. Responses are mapped back by GlmExecutor.
export function renameZcodeToolSearch(body) {
  if (!containsToolSearch(body)) return { body, renamed: false };
  return { body: rewriteToolSearch(body), renamed: true };
}

// Port of the 0.1.32 plugin's dress(). The input must already be an
// Anthropic messages body; other clients are translated before this runs.
export function buildStartBody(body, providerName, model, options = {}) {
  if (!body || !Array.isArray(body.messages)) return body;
  const prepared = options.prepared || renameZcodeToolSearch(body);
  body = prepared.body;
  const now = options.now || null;
  const sessionId = options.sessionId || "";

  const own = [];
  if (typeof body.system === "string") {
    if (body.system.trim()) own.push({ type: "text", text: body.system });
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block?.type !== "text" || !block.text) continue;
      if (block.text === zcodePrompt().prefix && own.length === 0) return body;
      own.push({ type: "text", text: block.text });
    }
  } else if (body.system != null) {
    return body;
  }

  const texts = own.map((block) => block.text);
  const firstContent = body.messages[0]?.content;
  if (typeof firstContent === "string") {
    texts.push(firstContent);
  } else if (Array.isArray(firstContent)) {
    for (const block of firstContent) {
      if (block && typeof block === "object" && typeof block.text === "string") texts.push(block.text);
    }
  }
  const { directory, git } = zcodePlace(texts);

  const messages = body.messages.map((message) => ({
    ...message,
    content: Array.isArray(message?.content)
      ? message.content.map((block) => {
          if (block && typeof block === "object" && "cache_control" in block) {
            const { cache_control, ...rest } = block;
            return rest;
          }
          return block;
        })
      : message?.content,
  }));

  let lastAt = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== "system") lastAt = i;
  }
  if (lastAt >= 0) {
    const message = messages[lastAt];
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(message.content) && message.content.length) {
      const block = message.content[message.content.length - 1];
      if (block && typeof block === "object") block.cache_control = { type: "ephemeral" };
    }
  }

  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => {
        if (tool && typeof tool === "object" && "cache_control" in tool) {
          const { cache_control, ...rest } = tool;
          return rest;
        }
        return tool;
      })
    : body.tools;
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? { ...body.metadata }
    : {};
  metadata.user_id = zcodeUserId(sessionId);

  return {
    ...body,
    system: zcodeSystemBlocks(providerName, model, directory, git, own.map((block) => block.text)),
    messages: [zcodeDateReminder(now), ...messages],
    tools,
    metadata,
  };
}

function entitlementPeriod(bucket, plan) {
  const entitlement = plan?.entitlements?.find(
    (item) => (item.entitlement_id || item.id) === bucket.entitlement_id,
  );
  const period = String(entitlement?.period || "").toLowerCase();
  // Enumerate ZCode's period values explicitly (daily_night included).
  if (period === "day" || period.slice(0, 5) === "daily") return "daily";
  if (period.slice(0, 4) === "week") return "weekly";
  if (period.slice(0, 5) === "month") return "monthly";
  return null;
}

function periodSeconds(period) {
  if (period === "daily") return 86_400;
  if (period === "weekly") return 7 * 86_400;
  if (period === "monthly") return 30 * 86_400;
  return null;
}

// Parse every gift bucket (Start Plan, weekend bonus, referral, ...), drop
// buckets belonging to expired plans, and retain model-alternative metadata.
export function parseStartBalance(balance, nowSec = Date.now() / 1000) {
  nowSec = num(balance?.server_time) ?? nowSec;
  const plans = Array.isArray(balance?.plans) ? balance.plans : [];
  const expired = new Set();
  for (const plan of plans) {
    const end = num(plan?.ends_at);
    const status = String(plan?.status || "").trim().toLowerCase();
    if (status === "expired" || (status === "active" && end !== null && end > 0 && end <= nowSec)) {
      expired.add((plan.user_plan_id || "") + "\u0000" + (plan.plan_id || ""));
    }
  }
  const samePlan = (bucket, plan) => (
    (bucket.user_plan_id && plan.user_plan_id && bucket.user_plan_id === plan.user_plan_id) ||
    ((!bucket.user_plan_id || !plan.user_plan_id) && bucket.plan_id === plan.plan_id)
  );
  const planOf = (bucket) => plans.find((plan) => samePlan(bucket, plan));
  const active = balanceActivePlan(balance, nowSec);
  const buckets = [];

  for (const bucket of Array.isArray(balance?.balances) ? balance.balances : []) {
    let keep = true;
    for (const plan of plans) {
      if (!samePlan(bucket, plan)) continue;
      keep = !expired.has((plan.user_plan_id || "") + "\u0000" + (plan.plan_id || ""));
      if (keep) break;
    }
    if (!keep) continue;

    const total = num(bucket.total_units);
    const usedValue = num(bucket.used_units);
    const remaining = num(bucket.remaining_units);
    if (total === null && usedValue === null && remaining === null) continue;
    const used = usedValue ?? Math.max(0, (total ?? 0) - (remaining ?? 0));
    const totalUnits = total ?? used + (remaining ?? 0);
    const models = [];
    for (const capability of Array.isArray(bucket.capabilities) ? bucket.capabilities : []) {
      const value = String(capability || "").trim();
      if (!value.startsWith("model:")) continue;
      const model = value.slice(6).trim();
      if (model) models.push(model);
    }
    const plan = planOf(bucket);
    let period = entitlementPeriod(bucket, plan);
    let spanSeconds = periodSeconds(period);
    if (!spanSeconds) {
      const start = num(bucket.period_start);
      const end = num(bucket.period_end);
      if (start !== null && end !== null && end > start) {
        spanSeconds = end - start;
        if (spanSeconds === 86_400) period = "daily";
        else if (spanSeconds === 7 * 86_400) period = "weekly";
        else if (spanSeconds === 30 * 86_400) period = "monthly";
      }
    }
    const expires = num(bucket.expires_at);
    const usedPercent = totalUnits > 0 ? Math.min(100, Math.max(0, Math.round((1000 * used) / totalUnits) / 10)) : 0;
    buckets.push({
      name: bucket.show_name || models.join(", ") || "Credits",
      planName: plan?.name || null,
      models,
      used: usedPercent,
      usedUnits: used,
      totalUnits,
      remainingUnits: remaining ?? totalUnits - used,
      resetsAt: expires && expires > 0 ? new Date(expires * 1000).toISOString() : null,
      period,
      periodSeconds: spanSeconds,
      spent: (remaining !== null && remaining <= 0) || (totalUnits > 0 && used >= totalUnits),
      aside: false,
    });
  }

  // When several plans grant the same model, only the best live bucket is the
  // model's primary quota; other buckets remain visible as alternatives.
  const best = new Map();
  buckets.forEach((bucket, index) => {
    for (const model of bucket.models) {
      const key = model.toLowerCase();
      const current = best.get(key);
      if (current === undefined || (buckets[current].spent && !bucket.spent) ||
          (buckets[current].spent === bucket.spent && bucket.used < buckets[current].used)) {
        best.set(key, index);
      }
    }
  });
  buckets.forEach((bucket, index) => {
    if (bucket.models.length && !bucket.models.some((model) => best.get(model.toLowerCase()) === index)) {
      bucket.aside = true;
    }
  });

  return { active, buckets };
}
