import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const setTenantUserId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/saas/tenantContext.js", () => ({
  setTenantUserId,
}));

// Mock dataDir to use temp dir so we control the user SQLite files
vi.mock("@/lib/dataDir.js", () => ({
  get DATA_DIR() {
    return tmpdir();
  },
}));

// Mock the cache to allow testing without 60s wait
vi.mock("@/lib/db/repos/apiKeysRepo.js", async () => {
  const actual = await vi.importActual("@/lib/db/repos/apiKeysRepo.js");
  return {
    ...actual,
    // Keep the module but reset the cache between tests
  };
});

function createUserSQLite(userId, apiKey) {
  const userDir = join(tmpdir(), "saas", "users", String(userId));
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "data.sqlite"), "");
  // Use better-sqlite3 to create the api_keys table and insert a key
  const Database = require("better-sqlite3");
  const db = new Database(join(userDir, "data.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS apiKeys (id INTEGER PRIMARY KEY, key TEXT, isActive INTEGER DEFAULT 1)");
  db.exec("INSERT OR REPLACE INTO apiKeys (key, isActive) VALUES (?, 1)", [apiKey]);
  db.close();
}

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

  it("accepts token row and sets tenant user id", async () => {
    createUserSQLite(42, "sk-live");
    const apiKeysRepo = await import("@/lib/db/repos/apiKeysRepo.js");
    // Clear the in-memory cache so our fresh DB is used
    apiKeysRepo._keyOwnerCache.clear();
    expect(await apiKeysRepo.validateApiKey("sk-live")).toBe(true);
    expect(setTenantUserId).toHaveBeenCalledWith(42);
  });

  it("returns false when findToken returns null", async () => {
    const { validateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    expect(await validateApiKey("missing")).toBe(false);
    expect(setTenantUserId).not.toHaveBeenCalled();
  });
});
