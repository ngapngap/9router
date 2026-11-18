import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// AutoClaw answers a history past what its gateway parses with HTTP 500
// {"message":"parse response failed"} after ~25s. Every account in the pool answers the
// same 500 for the same body, so treating it as an account fault walked the whole pool
// into `unavailable` (27/27) on the first oversized request and left unrelated requests
// with no account at all. It is a fault of the REQUEST: no cooldown, no eviction.
describe("parse response failed is request-scoped", () => {
  it("reports requestScoped and no account cooldown", () => {
    const v = checkFallbackError(500, '{"message":"parse response failed"}', 0, "autoclaw");
    expect(v.requestScoped).toBe(true);
    expect(v.shouldFallback).toBe(false);
    expect(v.cooldownMs).toBe(0);
  });

  it("matches when the error arrives already decorated", () => {
    const decorated = 'upstream error: do request failed {"message":"parse response failed"}';
    const v = checkFallbackError(500, decorated, 0, "autoclaw");
    expect(v.requestScoped).toBe(true);
    expect(v.shouldFallback).toBe(false);
  });

  it("does not leak across providers as an account fault", () => {
    // Same wording from an unrelated provider must not silently become request-scoped
    // elsewhere; the rule is text-global but must still never cool an account.
    const v = checkFallbackError(500, '{"message":"parse response failed"}', 0, "openai");
    expect(v.shouldFallback).toBe(false);
    expect(v.cooldownMs).toBe(0);
  });

  it("leaves a genuine 500 (no parse marker) as an account fault", () => {
    const v = checkFallbackError(500, '{"message":"internal server error"}', 0, "autoclaw");
    expect(v.shouldFallback).toBe(true);
    expect(v.requestScoped).toBeUndefined();
  });

  it("keeps rate limits backing off", () => {
    const v = checkFallbackError(429, "rate limit exceeded", 0, "autoclaw");
    expect(v.shouldFallback).toBe(true);
    expect(v.newBackoffLevel).toBe(1);
  });
});
