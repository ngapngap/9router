import { describe, it, expect } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { unavailableResponse } from "../../open-sse/utils/error.js";

// Passthrough lane (autoclaw): upstream forwards its own `data: [DONE]`, so
// flush() must not enqueue a second sentinel.
const chunk = (delta, extra = {}) => `data: ${JSON.stringify({
  id: "chatcmpl-x",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
  ...(extra.usage ? { usage: extra.usage } : {}),
})}\n\n`;

const FRAMES = [
  chunk({ role: "assistant", content: "" }),
  chunk({ content: "ok" }),
  chunk({ content: "" }, { finish_reason: "stop", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
  "data: [DONE]\n\n",
];

async function runThrough(frames) {
  const transform = createPassthroughStreamWithLogger("autoclaw", null, "m");
  const source = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      setTimeout(() => controller.close(), 50);
    },
  });
  const reader = source.pipeThrough(transform).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("passthrough relay close", () => {
  it("emits exactly one [DONE] when upstream sent one", async () => {
    const out = await runThrough(FRAMES);
    expect(out.match(/data: \[DONE\]/g) || []).toHaveLength(1);
    expect(out).toContain('"content":"ok"');
  });

  it("emits the sentinel itself when upstream never sent one", async () => {
    const out = await runThrough(FRAMES.slice(0, 3));
    expect(out.match(/data: \[DONE\]/g) || []).toHaveLength(1);
  });
});

describe("unavailableResponse retryAfter shape", () => {
  it("puts retryAfter at top level for combo readers", async () => {
    const retryAfter = new Date(Date.now() + 30_000).toISOString();
    const res = unavailableResponse(503, "all locked", retryAfter, "reset after 30s");
    const body = await res.json();
    expect(body.retryAfter).toBe(retryAfter);
    expect(body.retryAfterHuman).toBe("reset after 30s");
    expect(body.error.message).toContain("all locked");
    expect(res.headers.get("retry-after")).toBe("30");
  });
});
