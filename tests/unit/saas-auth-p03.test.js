import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("@/lib/saas/query.js", () => ({
  saasQuery: vi.fn(),
}));

import { saasQuery } from "@/lib/saas/query.js";
import { findUserForLogin } from "@/lib/saas/usersRepo.js";
import { verifyPassword } from "@/lib/saas/password.js";
import { computeIsAdmin } from "@/lib/saas/adminPolicy.js";

describe("computeIsAdmin", () => {
  beforeEach(() => {
    delete process.env.SAAS_ADMIN_USER_IDS;
  });

  // Given: role điều hành 10
  // When: computeIsAdmin
  // Then: true
  it("returns true for role 10", () => {
    expect(computeIsAdmin({ id: 1, role: 10 })).toBe(true);
  });

  // Given: role thường
  // When: computeIsAdmin
  // Then: false
  it("returns false for role 1", () => {
    expect(computeIsAdmin({ id: 1, role: 1 })).toBe(false);
  });

  // Given: SAAS_ADMIN_USER_IDS chứa id
  // When: computeIsAdmin
  // Then: true dù role thấp
  it("respects SAAS_ADMIN_USER_IDS", () => {
    process.env.SAAS_ADMIN_USER_IDS = "99";
    expect(computeIsAdmin({ id: 99, role: 1 })).toBe(true);
  });
});

describe("verifyPassword", () => {
  // Given: bcrypt hash đúng
  // When: password khớp
  // Then: true
  it("returns true when plain matches hash", async () => {
    const hash = bcrypt.hashSync("correct", 10);
    await expect(verifyPassword("correct", hash)).resolves.toBe(true);
  });

  // Given: hash đúng
  // When: password sai
  // Then: false
  it("returns false when plain does not match", async () => {
    const hash = bcrypt.hashSync("correct", 10);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });
});

describe("findUserForLogin", () => {
  beforeEach(() => {
    vi.mocked(saasQuery).mockReset();
  });

  // Given: DB không có hàng
  // When: findUserForLogin
  // Then: null
  it("returns null when no row", async () => {
    vi.mocked(saasQuery).mockResolvedValue({ rows: [] });
    await expect(findUserForLogin("a@b.c")).resolves.toBeNull();
  });

  // Given: đúng một hàng
  // When: findUserForLogin
  // Then: row
  it("returns the user when exactly one row", async () => {
    const row = { id: 1, password: "x" };
    vi.mocked(saasQuery).mockResolvedValue({ rows: [row] });
    await expect(findUserForLogin("x")).resolves.toBe(row);
  });

  // Given: hai hàng (ambiguous)
  // When: findUserForLogin
  // Then: null
  it("returns null when more than one row", async () => {
    vi.mocked(saasQuery).mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
    await expect(findUserForLogin("dup")).resolves.toBeNull();
  });

  // Given: identifier rỗng
  // When: findUserForLogin
  // Then: null, không gọi DB
  it("returns null for blank identifier without querying", async () => {
    await expect(findUserForLogin("  ")).resolves.toBeNull();
    expect(saasQuery).not.toHaveBeenCalled();
  });
});
