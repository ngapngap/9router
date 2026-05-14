import { describe, it, expect } from "vitest";
import { maskTokenKey } from "@/lib/saas/tokensRepo.js";
import { assertSafeUserId } from "@/lib/saas/userDataRoot.js";

describe("maskTokenKey", () => {
  // Given: key dài
  // When: mask
  // Then: 8 ký tự + …
  it("masks long keys", () => {
    expect(maskTokenKey("12345678901234567890")).toBe("12345678…");
  });

  // Given: key ngắn
  // When: mask
  // Then: placeholder an toàn
  it("short key returns minimal mask", () => {
    expect(maskTokenKey("abc")).toBe("…");
  });
});

describe("assertSafeUserId", () => {
  it("accepts numeric user id string", () => {
    expect(assertSafeUserId("42")).toBe("42");
  });

  it("rejects invalid user id", () => {
    expect(() => assertSafeUserId("../x")).toThrow();
  });
});
