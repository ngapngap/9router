import { describe, it, expect } from "vitest";
import { AutoClawExecutor } from "../../open-sse/executors/autoclaw.js";

// AutoClaw refuses an exhausted / under-privileged account two ways:
//   402 {"message":"Insufficient points"}
//   403 {"action":{"kind":"pay-view"},"code":810001,"message":"We're experiencing high demand…"}
// Both are account-scoped and not recoverable by refreshing the token, so the
// executor reports them as 429 (the status the account loop reads as "move on")
// and remembers that the last error was a refusal so chatCore skips the refresh.

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("AutoClaw paywall refusals", () => {
  it("maps 'Insufficient points' (402) to 429", () => {
    const ex = new AutoClawExecutor();
    const parsed = ex.parseError(json({ message: "Insufficient points" }, 402), JSON.stringify({ message: "Insufficient points" }));
    expect(parsed?.status).toBe(429);
    expect(parsed?.message).toContain("Insufficient points");
    expect(ex.lastRefusalWasPaywall()).toBe(true);
  });

  it("maps the 810001 pay-view envelope (403) to 429", () => {
    const ex = new AutoClawExecutor();
    const body = JSON.stringify({
      action: { kind: "pay-view" },
      code: 810001,
      image_url: "https://example.invalid/x.png",
      message: "We're experiencing high demand right now. Please try again shortly, or upgrade to a monthly subscription for priority access.",
    });
    const parsed = ex.parseError(json(JSON.parse(body), 403), body);
    expect(parsed?.status).toBe(429);
    expect(ex.lastRefusalWasPaywall()).toBe(true);
  });

  it("leaves a real auth refusal (403, no paywall markers) alone", () => {
    const ex = new AutoClawExecutor();
    const body = JSON.stringify({ message: "invalid token" });
    const parsed = ex.parseError(json(JSON.parse(body), 403), body);
    expect(parsed?.status).not.toBe(429);
    expect(ex.lastRefusalWasPaywall()).toBe(false);
  });

  it("leaves a rate limit (429) alone and does not remember it as a paywall", () => {
    const ex = new AutoClawExecutor();
    const body = JSON.stringify({ message: "rate limit exceeded" });
    ex.parseError(json(JSON.parse(body), 429), body);
    expect(ex.lastRefusalWasPaywall()).toBe(false);
  });
});
