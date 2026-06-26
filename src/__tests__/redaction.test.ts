import { redactLegacy } from "../observability/redaction.js";

describe("Redaction Utility (Legacy)", () => {
  it("should redact sensitive top-level fields", () => {
    const payload = {
      user: "admin",
      password: "supersecretpassword",
      apiKey: "12345",
    };
    const result = redactLegacy(payload);

    expect(result.user).toBe("admin");
    expect(result.password).toBe("[REDACTED]");
    expect(result.apiKey).toBe("[REDACTED]");
  });

  it("should recursively redact nested objects", () => {
    const payload = {
      action: "login",
      metadata: {
        token: "jwt-abc-123",
        safeData: "visible",
      },
    };
    const result = redactLegacy(payload);

    expect(result.metadata.token).toBe("[REDACTED]");
    expect(result.metadata.safeData).toBe("visible");
  });

  it("should safely handle arrays", () => {
    const payload = [{ secret: "hide-me" }, "safe-string", null];
    const result = redactLegacy(payload);

    expect(result[0].secret).toBe("[REDACTED]");
    expect(result[1]).toBe("safe-string");
    expect(result[2]).toBeNull();
  });
});
