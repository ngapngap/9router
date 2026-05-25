import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";

const setTenantUserId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/saas/tenantContext.js", () => ({
  setTenantUserId,
}));

// Mock dataDir to use temp dir
vi.mock("@/lib/dataDir.js", () => ({
  get DATA_DIR() {
    return tmpdir();
  },
}));

describe("validateApiKey SaaS branch", () => {
  beforeEach(() => {
    process.env.SAAS_ENABLED = "true";
    setTenantUserId.mockReset();
  });

  afterEach(() => {
    delete process.env.SAAS_ENABLED;
  });

  it("returns false for whitespace-only key without scanning", async () => {
    const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(await validateApiKey("   ")).toBe(false);
    expect(setTenantUserId).not.toHaveBeenCalled();
  });

  it("returns false when key not found (no user SQLite files)", async () => {
    const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(await validateApiKey("missing")).toBe(false);
    expect(setTenantUserId).not.toHaveBeenCalled();
  });
});

  afterEach(() => {
    delete process.env.SAAS_ENABLED;
  });

  it("returns false for whitespace-only key without scanning", async () => {
    const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(await validateApiKey("   ")).toBe(false);
    expect(setTenantUserId).not.toHaveBeenCalled();
  });

  it("returns false when key not found", async () => {
    const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(await validateApiKey("missing")).toBe(false);
    expect(setTenantUserId).not.toHaveBeenCalled();
  });
});