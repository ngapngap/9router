// tests/unit/security/jwt-claims.test.js
// P12 (#24) MED-4: Verify JWT aud/iss claims enforced.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

const originalJwtSecret = process.env.JWT_SECRET;
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long!!";
  process.env.NODE_ENV = "test";
  vi.resetModules();
});

afterEach(() => {
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("JWT claims (P12)", () => {
  it("createDashboardAuthToken includes iss and aud", async () => {
    const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const token = await createDashboardAuthToken({ sub: "123", isAdmin: false });
    expect(token).toBeTruthy();
    // Decode payload (JWT is base64url)
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    expect(payload.iss).toBe("9router-saas");
    expect(payload.aud).toBe("9router-dashboard");
  });

  it("verifyDashboardAuthToken rejects token without correct iss", async () => {
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode("test-secret-at-least-32-characters-long!!");
    // Create token with wrong issuer
    const badToken = await new SignJWT({ sub: "123" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .setIssuer("wrong-issuer")
      .setAudience("9router-dashboard")
      .sign(secret);

    const { verifyDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
    const result = await verifyDashboardAuthToken(badToken);
    expect(result).toBeFalsy(); // returns false or null on invalid token
  });
});
