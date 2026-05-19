// tests/unit/db-driver-no-fallback.test.js
// P09 (#21): Verify getAdapter() throws khi SAAS_ENABLED=true + no tenant context + no system context.
// Refs: https://github.com/ngapngap/9router/issues/21

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock next/headers — driver.js imports nó qua sessionServer path
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

// Mock sessionServer to always return null (no SaaS session from request)
vi.mock("@/lib/saas/sessionServer.js", () => ({
  getSaasUserIdFromRequest: async () => null,
}));

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalSaasEnabled = process.env.SAAS_ENABLED;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-no-fallback-"));
  process.env.DATA_DIR = tempDir;
  process.env.SAAS_ENABLED = "true";
  delete global._dbAdapter;
  delete global._dbAdapterPathsLogged;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._dbAdapterPathsLogged;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalSaasEnabled === undefined) delete process.env.SAAS_ENABLED;
  else process.env.SAAS_ENABLED = originalSaasEnabled;
});

describe("getAdapter() — SaaS mode no-fallback guard (P09)", () => {
  it("throws when SAAS_ENABLED=true and no tenant context", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    await expect(getAdapter()).rejects.toThrow("missing tenant context");
  });

  it("does NOT throw when running inside runAsSystem", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { runAsSystem } = await import("@/lib/saas/tenantContext.js");
    // runAsSystem marks __system=true → allows fallback to default adapter
    const result = await runAsSystem(() => getAdapter());
    expect(result).toBeDefined();
    expect(result).toHaveProperty("driver");
  });

  it("does NOT throw when SAAS_ENABLED is not true", async () => {
    process.env.SAAS_ENABLED = "false";
    vi.resetModules();
    const { getAdapter } = await import("@/lib/db/driver.js");
    const result = await getAdapter();
    expect(result).toBeDefined();
    expect(result).toHaveProperty("driver");
  });
});
