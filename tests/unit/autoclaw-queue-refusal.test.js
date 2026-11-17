import { describe, it, expect, vi, beforeEach } from "vitest";

// The executor reaches upstream through proxyAwareFetch, so that module is the seam.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { AutoClawExecutor } from "../../open-sse/executors/autoclaw.js";

// AutoClaw's queue system refuses a request it will not start right now with HTTP 200 and an
// SSE stream whose only payload is a queue event:
//   event: zwork_queue
//   data: {"cancel_button_content":"Try again later","status":"queueing",
//          "subtitle":"You're in the queue. Upgrade to a subscription for a dedicated
//                      priority queue.","title":"High demand right now",
//          "upgrade_button_content":"Upgrade now"}
// Because the status is 200 the account loop, the combo loop and the usage log all read the
// turn as a success, so the client receives the queue notice as its answer and no fallback
// ever runs. These tests pin the conversion to a real 429 so the account rotates.

const QUEUE_SSE = [
  "event:zwork_queue",
  'data:{"cancel_button_content":"Try again later","status":"queueing","subtitle":"You\'re in the queue. Upgrade to a subscription for a dedicated priority queue.","title":"High demand right now","upgrade_button_content":"Upgrade now"}',
  "",
  "",
].join("\n");

const HEALTHY_SSE = [
  'data: {"id":"1","object":"chat.completion.chunk","model":"glm-5.3-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}',
  'data: {"id":"1","object":"chat.completion.chunk","model":"glm-5.3-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  "data: [DONE]",
  "",
].join("\n");

const credentials = () => ({ accessToken: "jwt.token.sig", providerSpecificData: {} });

const execute = (executor, body = { model: "zai_glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }) =>
  executor.execute({
    model: "zai_glm-5.3-flash",
    body: { ...body, stream: true },
    stream: true,
    credentials: credentials(),
  });

const sse = (text, status = 200) =>
  new Response(text, { status, headers: { "Content-Type": "text/event-stream;charset=UTF-8" } });

describe("AutoClaw zwork_queue refusal behind HTTP 200", () => {
  beforeEach(() => {
    vi.mocked(proxyAwareFetch).mockReset();
  });

  it("turns a 200 queue stream into a 429 rate limit", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(sse(QUEUE_SSE));

    const { response } = await execute(new AutoClawExecutor());

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toContain("You're in the queue");
    // The queue payload must never reach the client as assistant content.
    expect(body.choices).toBeUndefined();
  });

  it("marks the refusal so chatCore skips the token refresh and rotates the account", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(sse(QUEUE_SSE));

    const executor = new AutoClawExecutor();
    expect(executor.lastRefusalWasPaywall()).toBe(false);
    const { response } = await execute(executor);

    expect(response.status).toBe(429);
    expect(executor.lastRefusalWasPaywall()).toBe(true);
  });

  it("leaves a healthy stream byte-identical and un-delayed", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(sse(HEALTHY_SSE));

    const { response } = await execute(new AutoClawExecutor());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe(HEALTHY_SSE);
  });

  it("does not treat a normal completion as queued", async () => {
    vi.mocked(proxyAwareFetch).mockResolvedValue(sse(HEALTHY_SSE));

    const executor = new AutoClawExecutor();
    await execute(executor);

    expect(executor.lastRefusalWasPaywall()).toBe(false);
  });

  it("leaves a JSON 200 body (non-SSE) alone", async () => {
    const json = JSON.stringify({ choices: [{ message: { content: "ok" } }] });
    vi.mocked(proxyAwareFetch).mockResolvedValue(
      new Response(json, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const { response } = await execute(new AutoClawExecutor());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(json);
  });

  it("detects the queue frame even when it is split across chunks", async () => {
    // The upstream writes the event line and its payload separately; neither chunk matches on
    // its own, so detection must work on the accumulating buffer.
    const parts = [
      "event:zwork_queue\n",
      'data:{"status":"queueing","title":"High demand right now",',
      '"subtitle":"You\'re in the queue. Upgrade to a subscription for a dedicated priority queue."}\n\n',
    ];
    let i = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (i >= parts.length) { controller.close(); return; }
        controller.enqueue(new TextEncoder().encode(parts[i++]));
      },
    });
    vi.mocked(proxyAwareFetch).mockResolvedValue(
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );

    const { response } = await execute(new AutoClawExecutor());

    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toContain("You're in the queue");
  });

  it("does not fire on a stream that mentions the queue wording in its answer text", async () => {
    const answer = [
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"You\'re in the queue is what the UI says"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    vi.mocked(proxyAwareFetch).mockResolvedValue(sse(answer));

    const { response } = await execute(new AutoClawExecutor());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(answer);
  });

  it("leaves a 403 pay-view refusal for parseError to map, exactly as before", async () => {
    const body = JSON.stringify({
      action: { kind: "pay-view" },
      code: 810001,
      message: "We're experiencing high demand right now. Please try again shortly, or upgrade to a monthly subscription for priority access.",
    });
    vi.mocked(proxyAwareFetch).mockResolvedValue(
      new Response(body, { status: 403, headers: { "Content-Type": "application/json" } }),
    );

    const executor = new AutoClawExecutor();
    const { response } = await execute(executor);

    // execute() hands the 403 through untouched (the peek only reads 2xx SSE); chatCore's
    // parseUpstreamError is what turns it into a 429 via parseError.
    expect(response.status).toBe(403);
    expect(executor.lastRefusalWasPaywall()).toBe(false); // the peek did not claim it
    expect(executor.parseError(response, body)?.status).toBe(429);
    expect(executor.lastRefusalWasPaywall()).toBe(true); // parseError did
  });
});
