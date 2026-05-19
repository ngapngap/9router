// tests/integration/quota-guard.test.js
// P11 (#22): Verify quota guard pre-flight 402 + overrun audit.
// Refs: https://github.com/ngapngap/9router/issues/22

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalQuotaEnabled = process.env.QUOTA_GUARD_ENABLED;

beforeEach(() => {
  process.env.QUOTA_GUARD_ENABLED = "true";
  vi.resetModules();
});

afterEach(() => {
  if (originalQuotaEnabled === undefined) delete process.env.QUOTA_GUARD_ENABLED;
  else process.env.QUOTA_GUARD_ENABLED = originalQuotaEnabled;
});

describe("assertQuotaForRequest (P11)", () => {
  it("returns allowed:true when QUOTA_GUARD_ENABLED is false", async () => {
    process.env.QUOTA_GUARD_ENABLED = "false";
    const { assertQuotaForRequest } = await import("@/lib/saas/quotaGuard.js");
    const result = await assertQuotaForRequest({ userId: 1, model: "gpt-4", provider: "openai" });
    expect(result.allowed).toBe(true);
  });

  it("returns allowed:true when user has sufficient quota", async () => {
    vi.doMock("@/lib/saas/query.js", () => ({
      saasQuery: async () => ({ rows: [{ quota: 1000, used_quota: 100 }] }),
    }));
    vi.doMock("@/lib/saas/auditLog.js", () => ({
      writeAuditLog: vi.fn(),
    }));
    const { assertQuotaForRequest } = await import("@/lib/saas/quotaGuard.js");
    const result = await assertQuotaForRequest({ userId: 1, model: "gpt-4", provider: "openai" });
    expect(result.allowed).toBe(true);
  });

  it("returns allowed:false (402) when quota exhausted", async () => {
    const mockAudit = vi.fn();
    vi.doMock("@/lib/saas/query.js", () => ({
      saasQuery: async () => ({ rows: [{ quota: 10, used_quota: 10 }] }),
    }));
    vi.doMock("@/lib/saas/auditLog.js", () => ({
      writeAuditLog: mockAudit,
    }));
    const { assertQuotaForRequest } = await import("@/lib/saas/quotaGuard.js");
    const result = await assertQuotaForRequest({ userId: 1, model: "gpt-4", provider: "openai" });
    expect(result.allowed).toBe(false);
    expect(result.error.code).toBe("quota_exhausted");
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ event: "quota.exhausted" }));
  });

  it("returns allowed:true when quota=0 (unlimited)", async () => {
    vi.doMock("@/lib/saas/query.js", () => ({
      saasQuery: async () => ({ rows: [{ quota: 0, used_quota: 500 }] }),
    }));
    vi.doMock("@/lib/saas/auditLog.js", () => ({
      writeAuditLog: vi.fn(),
    }));
    const { assertQuotaForRequest } = await import("@/lib/saas/quotaGuard.js");
    const result = await assertQuotaForRequest({ userId: 1, model: "gpt-4", provider: "openai" });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("fail-open when Postgres query errors", async () => {
    vi.doMock("@/lib/saas/query.js", () => ({
      saasQuery: async () => { throw new Error("connection refused"); },
    }));
    vi.doMock("@/lib/saas/auditLog.js", () => ({
      writeAuditLog: vi.fn(),
    }));
    const { assertQuotaForRequest } = await import("@/lib/saas/quotaGuard.js");
    const result = await assertQuotaForRequest({ userId: 1, model: "gpt-4", provider: "openai" });
    expect(result.allowed).toBe(true); // fail-open
  });
});
