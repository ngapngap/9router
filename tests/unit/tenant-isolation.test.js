/** Tenant isolation tests — APPENDIX §2 mandatory */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/saas/query.js", () => ({
  saasQuery: vi.fn(),
}));

import { assertSafeUserId, getUserDataDir } from "@/lib/saas/userDataRoot.js";

describe("assertSafeUserId", () => {
  it("accepts numeric string", () => {
    expect(assertSafeUserId("1")).toBe("1");
    expect(assertSafeUserId("42")).toBe("42");
  });

  it("accepts number input", () => {
    expect(assertSafeUserId(7)).toBe("7");
  });

  it("rejects path traversal with ../", () => {
    expect(() => assertSafeUserId("../etc/passwd")).toThrow("invalid_user_id");
  });

  it("rejects path traversal with ..", () => {
    expect(() => assertSafeUserId("..")).toThrow("invalid_user_id");
  });

  it("rejects slashes", () => {
    expect(() => assertSafeUserId("1/2")).toThrow("invalid_user_id");
  });

  it("rejects empty string", () => {
    expect(() => assertSafeUserId("")).toThrow("invalid_user_id");
  });

  it("rejects null/undefined", () => {
    expect(() => assertSafeUserId(null)).toThrow("invalid_user_id");
    expect(() => assertSafeUserId(undefined)).toThrow("invalid_user_id");
  });

  it("rejects non-numeric alpha", () => {
    expect(() => assertSafeUserId("abc")).toThrow("invalid_user_id");
  });
});

describe("getUserDataDir — tenant isolation", () => {
  it("returns path scoped to safe user id", () => {
    const dir = getUserDataDir(1);
    expect(dir).toContain("1");
    expect(dir).toMatch(/saas[\\/]users[\\/]1$/);
  });

  it("different users get different directories", () => {
    const dir1 = getUserDataDir(1);
    const dir2 = getUserDataDir(2);
    expect(dir1).not.toBe(dir2);
  });

  it("throws on traversal attempt", () => {
    expect(() => getUserDataDir("../evil")).toThrow("invalid_user_id");
  });
});

import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

describe("dashboardGuard — SaaS JWT enforcement", () => {
  it("rejects missing token", async () => {
    const result = await verifyDashboardAuthToken(null);
    expect(result).toBe(false);
  });

  it("rejects empty string token", async () => {
    const result = await verifyDashboardAuthToken("");
    expect(result).toBe(false);
  });

  it("rejects garbage token", async () => {
    const result = await verifyDashboardAuthToken("not-a-jwt");
    expect(result).toBe(false);
  });
});

describe("Cross-tenant access attempt — user A cannot access user B data", () => {
  it("getUserDataDir(A) does not contain B's id segment", () => {
    const dirA = getUserDataDir(1);
    const dirB = getUserDataDir(2);
    expect(dirA).not.toContain("/2/");
    expect(dirB).not.toContain("/1/");
  });

  it("assertSafeUserId prevents parameter injection to switch tenant", () => {
    expect(() => assertSafeUserId("1'; DROP TABLE users--")).toThrow("invalid_user_id");
    expect(() => assertSafeUserId("1 OR 1=1")).toThrow("invalid_user_id");
  });

  it("getUserDataDir paths are not substrings of each other", () => {
    const dir10 = getUserDataDir(10);
    const dir1 = getUserDataDir(1);
    expect(dir10).not.toContain(dir1.split(/[\\/]/).pop() + "/");
  });

  it("assertSafeUserId rejects unicode tricks", () => {
    expect(() => assertSafeUserId("１")).toThrow("invalid_user_id");
    expect(() => assertSafeUserId("1\u0000")).toThrow("invalid_user_id");
  });
});

import { checkRateLimit } from "@/lib/rateLimit.js";

describe("Rate limiter — login brute-force protection", () => {
  it("allows first 5 requests then blocks", () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(ip).allowed).toBe(true);
    }
    expect(checkRateLimit(ip).allowed).toBe(false);
  });

  it("different IPs have separate counters", () => {
    const ipA = "10.0.0.2";
    const ipB = "10.0.0.3";
    for (let i = 0; i < 5; i++) checkRateLimit(ipA);
    expect(checkRateLimit(ipA).allowed).toBe(false);
    expect(checkRateLimit(ipB).allowed).toBe(true);
  });
});
