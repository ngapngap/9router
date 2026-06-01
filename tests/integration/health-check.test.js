// tests/integration/health-check.test.js
// P10 (#23): Verify /api/health deep check + /api/health/live liveness.
// Refs: https://github.com/ngapngap/9router/issues/23

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, opts) => ({ body, status: opts?.status ?? 200 }),
  },
}));

const originalSaasEnabled = process.env.SAAS_ENABLED;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (originalSaasEnabled === undefined) delete process.env.SAAS_ENABLED;
  else process.env.SAAS_ENABLED = originalSaasEnabled;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("/api/health — deep check (P10)", () => {
  it("returns 200 with ok:true when all checks pass (non-SaaS)", async () => {
    process.env.SAAS_ENABLED = "false";
    process.env.DATA_DIR = process.cwd(); // cwd is writable
    const { GET } = await import("@/app/api/health/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.pg.status).toBe("skip");
    expect(res.body.checks.dataDir.status).toBe("ok");
  });

  it("returns 200 with ok:false when DATA_DIR not writable (degraded but server alive)", async () => {
    process.env.SAAS_ENABLED = "false";
    process.env.DATA_DIR = "/nonexistent-path-xyz-9router-test";
    const { GET } = await import("@/app/api/health/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.checks.dataDir.status).toBe("fail");
  });

  it("returns 200 with ok:false when Postgres down (SaaS mode, mock)", async () => {
    process.env.SAAS_ENABLED = "true";
    process.env.DATA_DIR = process.cwd();
    vi.doMock("@/lib/saas/query.js", () => ({
      saasQuery: async () => { throw new Error("connection refused"); },
    }));
    const { GET } = await import("@/app/api/health/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.checks.pg.status).toBe("fail");
  });

  it("returns 200 with booting:true when global DB adapter not yet ready", async () => {
    process.env.SAAS_ENABLED = "false";
    process.env.DATA_DIR = process.cwd();
    delete global._dbAdapter;
    const { GET } = await import("@/app/api/health/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.booting).toBe(true);
  });
});

describe("/api/health/live — liveness (P10)", () => {
  it("always returns 200", async () => {
    const { GET } = await import("@/app/api/health/live/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
