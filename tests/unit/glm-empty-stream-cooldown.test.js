// Per-account GLM Start-Plan cooldown after a stream that ended with no content at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

// The executor path below builds real streaming responses; keep request-detail writes off disk.
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const {
  markEmptyStream,
  emptyStreamCooldownRemainingMs,
  isEmptyStreamCooledDown,
  clearEmptyStream,
  resolveGlmPlanMode,
  invalidateGlmPlanMode,
} = await import("../../open-sse/services/zcodeStart.js");
const { GLM_EMPTY_STREAM_COOLDOWN_MS, HTTP_STATUS } = await import("../../open-sse/config/runtimeConfig.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createStreamController } = await import("../../open-sse/utils/streamHandler.js");
const { handleStreamingResponse, buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");
const { GlmExecutor } = await import("../../open-sse/executors/glm.js");
const { initTranslators } = await import("../../open-sse/translator/index.js");
await initTranslators();

const enc = new TextEncoder();
const dec = new TextDecoder();
const LOG = { line: vi.fn(), errorLine: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// A Start-Plan account: one per API key + Start-Plan JWT, exactly as the key is built.
function account(apiKey) {
  return { apiKey, providerSpecificData: { zcodeJwtToken: `jwt-${apiKey}` } };
}

const ROLE = `data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`;
const CONTENT = `data: {"id":"x","choices":[{"index":0,"delta":{"content":"from-m0"},"finish_reason":null}]}\n\n`;
const STOP = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`;
const DONE = `data: [DONE]\n\n`;

function sseStream(frames) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= frames.length) { controller.close(); return; }
      controller.enqueue(enc.encode(frames[i]));
      i++;
    },
  });
}

// One combo member's Response, built by the real streaming pipeline (upstream bytes → client).
async function memberResponse(frames, model) {
  const body = { model, stream: true, messages: [{ role: "user", content: "hi" }] };
  const { onStreamComplete, streamDetailId } = buildOnStreamComplete({
    provider: "openai", model, connectionId: "conn", apiKey: "sk-x", requestStartTime: Date.now(), body, stream: true,
    clientRawRequest: { endpoint: "/v1/chat/completions" }, reqTag: "t", log: LOG,
  });
  const res = await handleStreamingResponse({
    providerResponse: new Response(sseStream(frames), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    provider: "openai", model, sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI, body, stream: true,
    requestStartTime: Date.now(), connectionId: "conn", apiKey: "sk-x",
    streamController: createStreamController({ log: LOG, provider: "openai", model }),
    onStreamComplete, streamDetailId, reqTag: "t", log: LOG,
  });
  return res.response;
}

describe("empty-stream cooldown store", () => {
  beforeEach(() => {
    clearEmptyStream("glm", account("k1"));
    clearEmptyStream("glm", account("k2"));
  });

  it("default cooldown constant is three minutes", () => {
    expect(GLM_EMPTY_STREAM_COOLDOWN_MS).toBe(3 * 60_000);
  });

  it("mark → cooled for the window, then expires", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const until = markEmptyStream("glm", account("k1"));
      expect(until).toBe(1_000_000 + GLM_EMPTY_STREAM_COOLDOWN_MS);
      expect(isEmptyStreamCooledDown("glm", account("k1"))).toBe(true);

      now.mockReturnValue(1_000_000 + GLM_EMPTY_STREAM_COOLDOWN_MS - 1);
      expect(emptyStreamCooldownRemainingMs("glm", account("k1"))).toBe(1);

      now.mockReturnValue(1_000_000 + GLM_EMPTY_STREAM_COOLDOWN_MS);
      expect(isEmptyStreamCooledDown("glm", account("k1"))).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it("is per account: one cooled account does not cool another", () => {
    markEmptyStream("glm", account("k1"));
    expect(isEmptyStreamCooledDown("glm", account("k1"))).toBe(true);
    expect(isEmptyStreamCooledDown("glm", account("k2"))).toBe(false);
  });

  it("never marks a credential with nothing to key on", () => {
    expect(markEmptyStream("glm", {})).toBe(0);
    expect(markEmptyStream("glm", null)).toBe(0);
    expect(isEmptyStreamCooledDown("glm", {})).toBe(false);
  });

  it("clearEmptyStream drops the cooldown; invalidateGlmPlanMode also does", () => {
    markEmptyStream("glm", account("k1"));
    clearEmptyStream("glm", account("k1"));
    expect(isEmptyStreamCooledDown("glm", account("k1"))).toBe(false);

    markEmptyStream("glm", account("k1"));
    invalidateGlmPlanMode("glm", account("k1"));
    expect(isEmptyStreamCooledDown("glm", account("k1"))).toBe(false);
  });
});

describe("resolveGlmPlanMode honours the cooldown", () => {
  it("a cooled account reports start:false without any subscription lookup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      markEmptyStream("glm", account("k3"));
      const { start, cooledDown } = await resolveGlmPlanMode("glm", account("k3"));
      expect(start).toBe(false);
      expect(cooledDown).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      clearEmptyStream("glm", account("k3"));
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("GlmExecutor empty-stream hook", () => {
  it("is the executor the combo reaches for glm", () => {
    expect(getExecutor("glm")).toBeInstanceOf(GlmExecutor);
  });

  it("marks the account of its last Start-Plan turn, and only that one", async () => {
    const executor = new GlmExecutor("glm");
    const mine = account("mine");
    const other = account("other");
    clearEmptyStream("glm", mine);
    clearEmptyStream("glm", other);

    executor._lastStartAccount = mine; // what execute() records before dispatching upstream
    expect(executor.markLastRequestAccountEmptyStream()).toBe(true);
    expect(isEmptyStreamCooledDown("glm", mine)).toBe(true);
    expect(isEmptyStreamCooledDown("glm", other)).toBe(false);
    clearEmptyStream("glm", mine);
  });

  it("is a no-op before any turn ran", () => {
    const executor = new GlmExecutor("glm");
    expect(executor.markLastRequestAccountEmptyStream()).toBe(false);
  });
});

describe("combo marks the account on an entirely empty stream", () => {
  async function combo(memberFrames) {
    const tried = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: memberFrames.map((_, i) => `openai/m${i}`),
      handleSingleModel: async (_b, m) => {
        tried.push(m);
        return memberResponse(memberFrames[Number(m.slice(-1))], m);
      },
      log: LOG, comboName: `c-${Math.random()}`, comboStrategy: "fallback",
    });
    return { res, out: await res.text(), tried };
  }

  it("last candidate with prefill only → 502 error body, never an empty 200", async () => {
    const executor = getExecutor("openai");
    const spy = vi.fn();
    executor.markLastRequestAccountEmptyStream = spy;
    try {
      // Prefill only: a role frame, then the upstream closes without any delta.
      const { res, out } = await combo([[ROLE, DONE], [ROLE, DONE]]);
      expect(res.status).toBe(HTTP_STATUS.BAD_GATEWAY);
      expect(JSON.parse(out).error.message).toBe("upstream stream ended with no content");
      expect(spy).toHaveBeenCalledTimes(2); // every discarded candidate is marked, not only the last
    } finally {
      delete executor.markLastRequestAccountEmptyStream;
    }
  });

  it("an empty stop (role frame only, then a close) is also an abandoned turn → 502", async () => {
    const { res, out } = await combo([[ROLE], [ROLE, STOP, DONE]]);
    expect(res.status).toBe(HTTP_STATUS.BAD_GATEWAY);
    expect(JSON.parse(out).error.message).toBe("upstream stream ended with no content");
  });

  it("a tool-call-only answer is not an abandoned turn", async () => {
    const toolCall = `data: {"id":"x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":null}]}\n\n`;
    const finishTool = `data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`;
    const { res } = await combo([[toolCall, finishTool, DONE]]);
    expect(res.status).toBe(200);
  });

  it("a truncated stream did produce content, so it does not trigger the cooldown", async () => {
    const executor = getExecutor("openai");
    const spy = vi.fn();
    executor.markLastRequestAccountEmptyStream = spy;
    try {
      const { res, out } = await combo([[ROLE, CONTENT]]); // content, then the upstream dropped
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
      const frames = out.trim().split("\n\n");
      const last = frames[frames.length - 1];
      expect(last).toBe("data: [DONE]");
      expect(frames[frames.length - 2]).toContain('"code":"bad_gateway"');
      expect(dec.decode(new TextEncoder().encode(out))).toContain("from-m0");
    } finally {
      delete executor.markLastRequestAccountEmptyStream;
    }
  });
});
