// tests/unit/security/redact-secrets.test.js
// P12 (#24) HIGH-7: Verify redactSecrets strips sensitive patterns.
import { describe, it, expect } from "vitest";
import { redactSecrets } from "@/lib/security/redactSecrets.js";

describe("redactSecrets (P12)", () => {
  it("redacts Bearer token", () => {
    const input = "Authorization: Bearer sk-abc123.xyz_456-789";
    expect(redactSecrets(input)).toContain("Bearer [REDACTED]");
    expect(redactSecrets(input)).not.toContain("sk-abc123");
  });

  it("redacts sk- API key", () => {
    const input = "Using key sk-proj1234567890abcdefghij for request";
    expect(redactSecrets(input)).toContain("sk-[REDACTED]");
    expect(redactSecrets(input)).not.toContain("proj1234567890");
  });

  it("redacts Basic auth", () => {
    const input = "Header: Basic dXNlcjpwYXNzd29yZA==";
    expect(redactSecrets(input)).toContain("Basic [REDACTED]");
    expect(redactSecrets(input)).not.toContain("dXNlcjpwYXNzd29yZA==");
  });

  it("redacts key= pattern", () => {
    const input = 'config key=abcdefghijklmnopqrstuvwxyz123';
    expect(redactSecrets(input)).toContain("key=[REDACTED]");
  });

  it("handles non-string input", () => {
    expect(redactSecrets(null)).toBe("");
    expect(redactSecrets(undefined)).toBe("");
    expect(redactSecrets(123)).toBe("123");
  });

  it("preserves non-sensitive content", () => {
    const input = "Normal log message without secrets";
    expect(redactSecrets(input)).toBe(input);
  });
});
