import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("pg", () => ({
  default: {
    Pool: class MockPool {
      constructor() {
        this.query = queryMock;
      }
    },
  },
}));

describe("saas pgPool + saasQuery", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ ok: 1 }] });
    delete process.env.SAAS_ENABLED;
    delete process.env.SAAS_DATABASE_URL;
    delete globalThis[Symbol.for("9router.saasPgPool")];
  });

  // Given: SaaS không bật
  // When: getSaasPool()
  // Then: null
  it("getSaasPool returns null when SAAS_ENABLED is not true", async () => {
    process.env.SAAS_ENABLED = "false";
    const { getSaasPool } = await import("@/lib/saas/pgPool.js");
    expect(getSaasPool()).toBeNull();
  });

  // Given: SAAS bật nhưng không có URL
  // When: getSaasPool()
  // Then: null
  it("getSaasPool returns null when database URL is missing", async () => {
    process.env.SAAS_ENABLED = "true";
    const { getSaasPool } = await import("@/lib/saas/pgPool.js");
    expect(getSaasPool()).toBeNull();
  });

  // Given: đủ biến env
  // When: gọi query SELECT 1
  // Then: pool.query được gọi
  it("saasQuery runs SELECT when configured", async () => {
    process.env.SAAS_ENABLED = "true";
    process.env.SAAS_DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/new-api";
    const { saasQuery } = await import("@/lib/saas/query.js");
    await saasQuery("SELECT 1 AS ok");
    expect(queryMock).toHaveBeenCalledWith("SELECT 1 AS ok", []);
  });

  // Given: không cấu hình pool
  // When: saasQuery
  // Then: lỗi saas_db_not_configured
  it("saasQuery throws when pool not available", async () => {
    const { saasQuery } = await import("@/lib/saas/query.js");
    await expect(saasQuery("SELECT 1")).rejects.toThrow(/saas_db_not_configured/);
  });
});
