import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findTokenByKeyForProxy = vi.hoisted(() => vi.fn());
const setTenantUserId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/saas/tokensRepo.js", () => ({
  findTokenByKeyForProxy,
}));

vi.mock("@/lib/saas/tenantContext.js", () => ({
  setTenantUserId,
}));

describe("validateApiKey SaaS branch", () => {
  beforeEach(() => {
    process.env.SAAS_ENABLED = "true";
    findTokenByKeyForProxy.mockReset();
    setTenantUserId.mockReset();
  });

  afterEach(() => {
    delete process.env.SAAS_ENABLED;
  });

  // Given: SAAS và key rỗng / chỉ khoảng trắng
  // When: validateApiKey
  // Then: false, không gọi Postgres
  it("returns false for whitespace-only key without PG lookup", async () => {
    const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(await validateApiKey("   ")).toBe(false);
    expect(findTokenByKeyForProxy).not.toHaveBeenCalled();
  });

  // Given: token Postgres active với user_id
  // When: validateApiKey
  // Then: true và setTenantUserId
  it("accepts token row and sets tenant user id", async () => {
    findTokenByKeyForProxy.mockResolvedValue({ user_id: 42, status: 1 });
    const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(await validateApiKey("sk-live")).toBe(true);
    expect(findTokenByKeyForProxy).toHaveBeenCalledWith("sk-live");
    expect(setTenantUserId).toHaveBeenCalledWith(42);
  });

  // Given: row không có user_id
  // When: validateApiKey
  // Then: false, không set tenant
  it("returns false when row lacks user_id", async () => {
    findTokenByKeyForProxy.mockResolvedValue({ user_id: null, status: 1 });
    const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(await validateApiKey("x")).toBe(false);
    expect(setTenantUserId).not.toHaveBeenCalled();
  });

  // Given: không có token
  // When: validateApiKey
  // Then: false
  it("returns false when findToken returns null", async () => {
    findTokenByKeyForProxy.mockResolvedValue(null);
    const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(await validateApiKey("missing")).toBe(false);
    expect(setTenantUserId).not.toHaveBeenCalled();
  });
});
