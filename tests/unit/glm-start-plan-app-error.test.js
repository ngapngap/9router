import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirror unit/zcode-start.test.js: the executor goes through proxyAwareFetch, so
// the seam to stub is that module, not global fetch.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { GlmExecutor } from "../../open-sse/executors/glm.js";

// Z.ai answers a request it will not serve with HTTP 200 and `{code, msg}`
// instead of an Anthropic message. Observed in production: all six Start Plan
// accounts answered
//   200 {"code":1005,"msg":"exceed quota limit","logid":"..."}
// and the gateway recorded the turn as a success with IN 0 / OUT 0 — the empty
// reply clients see. These tests pin the conversion to a real HTTP error and the
// single-URL rule that keeps that error from being overwritten.

const jwt = (exp = Math.floor(Date.now() / 1000) + 3600) =>
  "header." + Buffer.from(JSON.stringify({ exp })).toString("base64url") + ".signature";

const credentials = () => ({
  apiKey: "",
  accessToken: "",
  zcodeStartPlan: true,
  providerSpecificData: { zcodeJwtToken: jwt() },
});

const execute = (executor, stream) => executor.execute({
  model: "glm-5.3-flash",
  body: { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
  stream,
  credentials: credentials(),
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("GlmExecutor Start Plan app-level errors", () => {
  beforeEach(() => {
    vi.mocked(proxyAwareFetch).mockReset();
  });

  it("turns 200 + code 1005 into a 429 so the turn is not recorded as success", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonResponse({ code: 1005, msg: "exceed quota limit", logid: "x" }));

    const { response } = await execute(new GlmExecutor("glm"), true);

    expect(response.status).toBe(429);
    const body = await response.text();
    expect(body).toMatch(/1005/);
    expect(body).toMatch(/quota/i);
  });

  it("maps an unknown refusal code to 502 instead of an empty success", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonResponse({ code: 4402, msg: "nope" }));

    const { response } = await execute(new GlmExecutor("glm"), true);

    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/4402/);
  });

  it("leaves a real Anthropic message body untouched", async () => {
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonResponse(message));

    const { response } = await execute(new GlmExecutor("glm"), false);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(message);
  });

  it("keeps a 200 SSE stream as a stream", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3}}}\n\n';
    vi.mocked(proxyAwareFetch).mockResolvedValue(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const { response } = await execute(new GlmExecutor("glm"), true);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sse);
  });

  it("retries a plain-text 429 'Rate limit exceeded' then succeeds (zcode-plan gateway)", async () => {
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    vi.mocked(proxyAwareFetch)
      .mockResolvedValueOnce(new Response("Rate limit exceeded", { status: 429 }))
      .mockResolvedValueOnce(new Response("Rate limit exceeded", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(message));

    const { response } = await execute(new GlmExecutor("glm"), false);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(message);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
  });

  it("gives up with the plain-text 429 after busy retries exhaust", async () => {
    vi.mocked(proxyAwareFetch).mockImplementation(async () =>
      new Response("Rate limit exceeded", { status: 429 }));

    const { response } = await execute(new GlmExecutor("glm"), false);

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("Rate limit exceeded");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(7); // 1 + BUSY_WAITS.length (6)
  }, 30000);

  it("issues exactly one upstream request (a second URL could overwrite the refusal)", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(jsonResponse({ code: 1005, msg: "exceed quota limit" }));

    const { response } = await execute(new GlmExecutor("glm"), true);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(429);
  });
});
