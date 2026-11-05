import { describe, it, expect } from "vitest";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// A same-format (OpenAI -> OpenAI) relay whose upstream ends with its own
// `data: [DONE]` must hand the client exactly ONE sentinel. The relay forwards
// the upstream's line, and the lane's close used to add a second one — two
// `[DONE]` frames make strict clients read the turn as still open and hang.
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
  const transform = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI, "autoclaw", null, null, "m");
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

describe("same-format relay close", () => {
  it("forwards the content and emits exactly one [DONE]", async () => {
    const out = await runThrough(FRAMES);
    const sentinels = out.match(/data: \[DONE\]/g) || [];
    expect(sentinels).toHaveLength(1);
    expect(out).toContain('"content":"ok"');
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("emits the sentinel itself when the upstream never sent one", async () => {
    const out = await runThrough(FRAMES.slice(0, 3));
    console.log("NO-DONE OUT", JSON.stringify(out));
    const sentinels = out.match(/data: \[DONE\]/g) || [];
    expect(sentinels).toHaveLength(1);
  });
});
