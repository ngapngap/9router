import { describe, it, expect } from "vitest";
import { UpstreamError, asUpstreamError, throwUpstreamError } from "../../open-sse/utils/upstreamError.js";

// Some upstream refusals only exist as a Response (Z.ai: HTTP 200 + {code:1005}).
// chatCore adopts them via asUpstreamError so the normal error path sees a real
// status; these tests pin the shape that adoption depends on.

const errorResponse = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("upstreamError", () => {
  it("carries the response and its status", () => {
    const response = errorResponse({ code: 1005 }, 429);
    const error = new UpstreamError(response, "exceed quota limit");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("UpstreamError");
    expect(error.status).toBe(429);
    expect(error.response).toBe(response);
  });

  it("finds itself through a cause chain and ignores unrelated errors", () => {
    const inner = new UpstreamError(errorResponse({ code: 1005 }, 429), "quota");
    const wrapped = new Error("fetch failed", { cause: inner });
    expect(asUpstreamError(wrapped)).toBe(inner);
    expect(asUpstreamError(new Error("plain"))).toBeNull();
  });

  it("recognises a marker from another module copy", () => {
    const response = errorResponse({ code: 1005 }, 429);
    const foreign = Object.assign(new Error("quota"), { name: "UpstreamError", response });
    const adopted = asUpstreamError(foreign);
    expect(adopted).not.toBeNull();
    expect(adopted.status).toBe(429);
    expect(adopted.response).toBe(response);
  });

  it("throwUpstreamError throws an adoptable error", () => {
    const response = errorResponse({ code: 1005 }, 429);
    let caught;
    try {
      throwUpstreamError(response, "exceed quota limit");
    } catch (error) {
      caught = error;
    }
    expect(asUpstreamError(caught)?.response).toBe(response);
  });
});
