import { DefaultExecutor } from "./default.js";
import {
  isJwtExpired,
  buildStartBody,
  zcodeSourceHeaders,
  startPlanConfig,
  zcodeSessionId,
  renameZcodeToolSearch,
  invalidateGlmPlanMode,
  markEmptyStream,
  isEmptyStreamCooledDown,
  ZCODE_TOOL_SEARCH,
  ZCODE_TOOL_SEARCH_ALIAS,
} from "../services/zcodeStart.js";
import { errorResponse } from "../utils/error.js";

// GLM Coding Plan accounts keep DefaultExecutor's existing api.z.ai flow.
// Start Plan accounts follow @magpie-community/opencode-zcode-auth 0.1.32.
const BUSY_WAITS = [250, 500, 900, 1600, 2800, 4000];
const BUSY_CODES = new Set(["3008", "3009"]);
const BUSY_HINT = "ZCode limits concurrent requests per account/model; the same request was retried for about ten seconds. Reduce parallel sessions or retry shortly.";
const START_REFUSED = /unusual activity|request has been blocked|"code"\s*:\s*"?3012\b/i;
const EDGE_PAGE = /errors\.aliyun\.com|<html/i;
const START_RESTRICTED = "ZCode's risk control blocked this account for unusual activity (code 3012). If the ZCode app fails on this account too, only ZCode support can lift the block.";
const START_EDGE = "ZCode's network firewall blocked requests from this IP; wait a while, or switch to another network or proxy.";
const OVERRIDE_HEADERS = new Set(["content-type", "anthropic-version", "accept", "accept-encoding"]);

// Z.ai answers a request it will not serve with HTTP 200 and an application-level
// `{code,msg}` envelope instead of an Anthropic message. 1005 is the Start Plan's
// "this account has no grant left" (the same answer the balance endpoint gives
// when `plans` is empty). Without this mapping the turn completes as a success
// with zero tokens — the empty reply clients see — so every refusal in the table
// below is raised as a real HTTP error: the client fails loudly and the account
// pool falls back instead of silently answering nothing.
const START_APP_ERROR_STATUS = [
  { match: /^1005$/, message: "ZCode Start Plan has no remaining quota for this account (code 1005 exceed quota limit)" },
  { match: /^1006$/, message: "ZCode Start Plan quota is exhausted for today (code 1006)" },
  { match: /^3011$/, message: "ZCode rejected the Start Plan request (code 3011); sign in to ZCode again if this persists" },
];
const APP_ERROR_CODE = /^\d{3,5}$/;

// App-level error envelope → status. Returns null when the body is a normal
// Anthropic message (no `code`), an SSE stream, or a code we do not know.
function startAppError(status, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || trimmed.startsWith('{"type"')) return null;
  let body;
  try {
    body = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const code = body?.code;
  if (code == null || typeof code === "object" || !APP_ERROR_CODE.test(String(code).trim())) return null;
  const scalar = (value) => (value == null || typeof value === "object" ? "" : String(value));
  const msg = scalar(body.msg) || scalar(body.message) || "ZCode refused the request";
  const known = START_APP_ERROR_STATUS.find((entry) => entry.match.test(String(code).trim()));
  return {
    status: known ? 429 : (status >= 400 ? status : 502),
    message: known ? known.message : `ZCode error ${code}: ${msg}`,
  };
}

function onStart(credentials) {
  // `zcodeStartPlan` is set by the chat core only when the plan decision holds, and it is
  // never set while the account sits in its empty-stream cooldown. Re-checking the cooldown
  // here keeps every entry point (buildUrl, headers, execute) on the account's normal z.ai
  // transport even if a caller cached `zcodeStartPlan` before the cooldown was marked.
  if (credentials && isEmptyStreamCooledDown("glm", credentials)) return false;
  return Boolean(credentials?.zcodeStartPlan && credentials?.providerSpecificData?.zcodeJwtToken);
}

function isBusy(status, text) {
  if (status !== 429) return false;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  if (!body || typeof body !== "object") return false;
  const scalar = (value) => (value == null || typeof value === "object" ? "" : String(value));
  if (BUSY_CODES.has(scalar(body.code) || scalar(body.error?.code))) return true;
  return /concurrency limit exceeded/i.test(
    scalar(body.msg) + " " + scalar(body.message) + " " + scalar(body.error?.message) + " " + scalar(body.error),
  );
}

function responseWithText(response, text) {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function busyResponse(response, text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (body && typeof body === "object") {
    const said = body.msg || body.message || body.error?.message ||
      (typeof body.error === "string" ? body.error : "") || String(response.status);
    const message = said + " — " + BUSY_HINT;
    const output = body.error && typeof body.error === "object"
      ? { ...body, error: { ...body.error, message } }
      : { ...body, msg: message };
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(output), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return responseWithText(response, text);
}

function startRefused(status, text) {
  return status >= 400 && (status === 405 || START_REFUSED.test(text) || EDGE_PAGE.test(text));
}

function sleep(ms, signal) {
  if (signal?.aborted) {
    const error = new Error("Request aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      const error = new Error("Request aborted");
      error.name = "AbortError";
      reject(error);
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function renameToolBlock(block) {
  if (block?.type === "tool_use" && block.name === ZCODE_TOOL_SEARCH_ALIAS) {
    block.name = ZCODE_TOOL_SEARCH;
    return true;
  }
  return false;
}

// Restore Claude Code's ToolSearch name after ZCode answered ToolSearchTool.
async function restoreToolSearchResponse(response) {
  if (!response?.body) return response;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let held = "";
    const renameLine = (line) => {
      if (!line.startsWith("data:") || !line.includes('"' + ZCODE_TOOL_SEARCH_ALIAS + '"')) return line;
      try {
        const data = JSON.parse(line.slice(5));
        return renameToolBlock(data?.content_block) ? "data: " + JSON.stringify(data) : line;
      } catch {
        return line;
      }
    };
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        held += decoder.decode(chunk, { stream: true });
        const lastNewline = held.lastIndexOf("\n");
        if (lastNewline < 0) return;
        controller.enqueue(encoder.encode(held.slice(0, lastNewline + 1).split("\n").map(renameLine).join("\n")));
        held = held.slice(lastNewline + 1);
      },
      flush(controller) {
        held += decoder.decode();
        if (held) controller.enqueue(encoder.encode(renameLine(held)));
      },
    }));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  if (contentType.includes("json")) {
    const text = await response.text();
    let output = text;
    try {
      const body = JSON.parse(text);
      if (Array.isArray(body?.content) && body.content.map(renameToolBlock).some(Boolean)) {
        output = JSON.stringify(body);
      }
    } catch {
      // Preserve a non-JSON error response byte for byte.
    }
    return responseWithText(response, output);
  }
  return response;
}

// Apply startAppError() to a response: read the body once, hand back either an
// errorResponse carrying the real status or a byte-identical clone.
async function withStartAppError(response) {
  if (!response || !response.body) return response;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  // Only a JSON body can be an app-level envelope; never buffer an SSE stream.
  if (contentType.includes("text/event-stream")) return response;
  const text = await response.text();
  const appError = startAppError(response.status, text);
  if (!appError) return responseWithText(response, text);
  return errorResponse(appError.status, appError.message);
}

export class GlmExecutor extends DefaultExecutor {
  constructor(provider = "glm") {
    super(provider);
    // Account of the most recent Start-Plan turn, set at the top of execute().
    this._lastStartAccount = null;
    this.markLastRequestAccountEmptyStream = this.markLastRequestAccountEmptyStream.bind(this);
  }

  // Cool down the Start-Plan account of the last turn after its stream ended with no
  // content at all (see zcodeStart.markEmptyStream). Returns true when a cooldown was set.
  markLastRequestAccountEmptyStream() {
    if (!this._lastStartAccount) return false;
    return markEmptyStream(this.provider, this._lastStartAccount) > 0;
  }

  // Start Plan owns exactly one endpoint: base.js iterates
  // `getBaseUrls().length || 1` URLs and returns the LAST url's error when every
  // one fails, so a second (unrelated) mirror URL would replace the Start Plan
  // refusal — the quota error the executor just built — with its own.
  getFallbackCount() {
    return 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (onStart(credentials)) return startPlanConfig(this.provider)?.baseUrl;
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    if (!onStart(credentials)) return super.buildHeaders(credentials, stream, url, model, body);
    return {
      ...zcodeSourceHeaders(this.provider, credentials.zcodeSessionId),
      Authorization: "Bearer " + credentials.providerSpecificData.zcodeJwtToken,
      Accept: stream ? "text/event-stream" : "application/json",
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (!onStart(credentials)) return super.transformRequest(model, body, stream, credentials);
    const providerName = this.provider === "glm-cn" ? "bigmodel-api" : "zai-api";
    const prepared = renameZcodeToolSearch(body);
    credentials.zcodeToolSearchRenamed = prepared.renamed;
    return buildStartBody(prepared.body, providerName, prepared.body?.model || model, {
      sessionId: credentials.zcodeSessionId,
      prepared,
    });
  }

  parseError(response, bodyText) {
    const text = bodyText || "";
    if (response.status >= 400 && EDGE_PAGE.test(text)) {
      return { status: response.status, message: START_EDGE };
    }
    if (startRefused(response.status, text)) {
      return { status: response.status, message: START_RESTRICTED };
    }
    // Busy responses already contain BUSY_HINT after execute() exhausts retries.
    // Keep parseUpstreamError's generic GLM 1113 guidance on paid accounts.
    return null;
  }

  async execute(options) {
    const { credentials } = options;
    if (!onStart(credentials)) return super.execute(options);

    const cfg = startPlanConfig(this.provider);
    if (isJwtExpired(credentials.providerSpecificData.zcodeJwtToken)) {
      return {
        response: errorResponse(
          401,
          "ZCode's sign-in has expired; sign in to ZCode again by re-adding the GLM OAuth account in Providers.",
        ),
        url: cfg?.baseUrl,
        headers: {},
        transformedBody: options.body,
      };
    }

    // One bare session UUID is shared by x-session-id and metadata.user_id.
    const requestCredentials = {
      ...credentials,
      zcodeSessionId: zcodeSessionId(options.providerSessionId),
    };
    // Remember which account this turn ran on, so an empty stream reported later (the
    // combo peeks the response after the executor returned) can cool exactly that account
    // down. Bound at construction: the combo only reaches the memoized executor instance.
    // Instance state, so a concurrent Start-Plan turn on another account can overwrite it
    // between execute() and the peek; the worst case is a cooldown on the wrong Start-Plan
    // account, which only deprioritises its zcode route for a few minutes.
    this._lastStartAccount = requestCredentials;
    let executeOptions = { ...options, credentials: requestCredentials };
    if (options.providerOverrides) {
      const headers = {};
      for (const [name, value] of Object.entries(options.providerOverrides.headers || {})) {
        if (OVERRIDE_HEADERS.has(name.toLowerCase())) headers[name] = value;
      }
      const { baseUrl, ...overrides } = options.providerOverrides;
      executeOptions.providerOverrides = { ...overrides, headers };
    }

    let result;
    for (let attempt = 0; ; attempt++) {
      result = await super.execute(executeOptions);
      const response = result.response;
      if (!response || response.status < 400) break;

      const text = await response.text();
      if (isBusy(response.status, text)) {
        if (attempt < BUSY_WAITS.length) {
          const wait = BUSY_WAITS[attempt];
          await sleep(Math.round(wait * (0.75 + Math.random() * 0.5)), options.signal);
          continue;
        }
        result = { ...result, response: busyResponse(response, text) };
        break;
      }
      if (startRefused(response.status, text)) {
        // A newly purchased Coding Plan must be discovered on the next try.
        invalidateGlmPlanMode(this.provider, credentials);
      }
      // A 200 + `{code,msg}` refusal carries no message: surface it as the real
      // status so this request reports an ERROR instead of an empty success.
      const appError = startAppError(response.status, text);
      if (appError) {
        // The plan state this account was routed on is no longer true.
        invalidateGlmPlanMode(this.provider, credentials);
        result = { ...result, response: errorResponse(appError.status, appError.message) };
        break;
      }
      result = { ...result, response: responseWithText(response, text) };
      break;
    }

    if (requestCredentials.zcodeToolSearchRenamed) {
      result = { ...result, response: await restoreToolSearchResponse(result.response) };
    }
    // proxyAwareFetch/undici uses HTTP/1.1 unless allowH2 is explicitly set;
    // no executor or proxy dispatcher in this repo enables it for this path.
    //
    // An app-level refusal arrives as a 2xx, so it never reaches the loop above.
    // The pass below rewrites such a response into a real 4xx/5xx; a genuine
    // Anthropic message or SSE stream never matches `startAppError` and is
    // returned with its body intact.
    // Stamp the account on the result too: a caller that still holds it (e.g. a fallback
    // chain caching per-account results) can cool the right account without the field.
    result = { ...result, response: await withStartAppError(result.response), lastStartAccount: requestCredentials };
    return result;
  }
}
