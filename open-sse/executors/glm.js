import { DefaultExecutor } from "./default.js";
import {
  isJwtExpired,
  buildStartBody,
  zcodeSourceHeaders,
  startPlanConfig,
  zcodeSessionId,
  renameZcodeToolSearch,
  invalidateGlmPlanMode,
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

function onStart(credentials) {
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

export class GlmExecutor extends DefaultExecutor {
  constructor(provider = "glm") {
    super(provider);
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
      result = { ...result, response: responseWithText(response, text) };
      break;
    }

    if (requestCredentials.zcodeToolSearchRenamed) {
      result = { ...result, response: await restoreToolSearchResponse(result.response) };
    }
    // proxyAwareFetch/undici uses HTTP/1.1 unless allowH2 is explicitly set;
    // no executor or proxy dispatcher in this repo enables it for this path.
    return result;
  }
}
