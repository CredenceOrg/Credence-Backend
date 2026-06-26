import { describe, it, expect } from "vitest";
import {
  redact,
  redactLegacy,
  isPIIField,
  RedactionContext,
} from "../redaction.js";
import {
  LogEventType,
  LOG_SCHEMAS,
  getSchemaForEventType,
  getRegisteredEventTypes,
  PII_PATTERNS,
  STELLAR_SENSITIVE_FIELDS,
} from "../logSchemas.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Allowlist enforcement – unknown fields are dropped
// ─────────────────────────────────────────────────────────────────────────────
describe("Allowlist enforcement", () => {
  it("drops unknown fields not in schema", () => {
    const input = { message: "ok", secretData: "leak", internalId: 42 };
    const ctx: RedactionContext = {
      eventType: LogEventType.OUTBOX_PUBLISHER_PUBLISHED_EVENT,
    };
    const result = redact(input, ctx);
    expect(result).toEqual({ message: "ok" });
    expect(result).not.toHaveProperty("secretData");
    expect(result).not.toHaveProperty("internalId");
  });

  it("keeps all schema-defined fields", () => {
    const input = {
      message: "retry",
      provider: "webhook",
      attempt: 2,
      delayMs: 1000,
      webhookId: "wh-1",
      error: "timeout",
    };
    const ctx: RedactionContext = {
      eventType: LogEventType.WEBHOOK_DELIVERY_RETRY,
    };
    const result = redact(input, ctx);
    expect(result).toEqual(input);
  });

  it("drops fields explicitly denied in schema", () => {
    const schema = {
      message: { type: "string" as const },
      internalNote: { type: "string" as const, allowed: false },
    };
    const result = redact(
      { message: "hi", internalNote: "private" },
      { schema },
    );
    expect(result).toEqual({ message: "hi" });
    expect(result).not.toHaveProperty("internalNote");
  });

  it("returns empty object when no schema and no context", () => {
    const result = redact({ foo: "bar", baz: 123 });
    expect(result).toEqual({});
  });

  it("returns empty object for empty schema", () => {
    const result = redact({ foo: "bar" }, { schema: {} });
    expect(result).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PII pattern redaction
// ─────────────────────────────────────────────────────────────────────────────
describe("PII pattern redaction", () => {
  it("redacts all known PII fields", () => {
    const piiFields = [
      "password",
      "secret",
      "token",
      "email",
      "ssn",
      "apiKey",
      "creditCard",
      "phone",
      "bankAccount",
      "accessToken",
      "refreshToken",
      "privateKey",
      "authorization",
    ];
    for (const field of piiFields) {
      const schema = { [field]: { type: "string" as const } };
      const result = redact({ [field]: "sensitive" }, { schema });
      expect(result[field]).toBe("[REDACTED]");
    }
  });

  it("redacts PII case-insensitively", () => {
    const schema = { Password: { type: "string" as const } };
    const result = redact({ Password: "secret" }, { schema });
    expect(result.Password).toBe("[REDACTED]");
  });

  it("redacts PII even when field is in schema as allowed", () => {
    const schema = { email: { type: "string" as const } };
    const result = redact({ email: "user@example.com" }, { schema });
    expect(result.email).toBe("[REDACTED]");
  });

  it("isPIIField utility works", () => {
    expect(isPIIField("password")).toBe(true);
    expect(isPIIField("Password")).toBe(true);
    expect(isPIIField("message")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Stellar memo field handling
// ─────────────────────────────────────────────────────────────────────────────
describe("Stellar memo field handling", () => {
  it("redacts all Stellar memo fields", () => {
    const memoFields = [
      "memo",
      "memoValue",
      "memoData",
      "memo_hash",
      "memo_return",
      "memo_id",
      "memoText",
    ];
    for (const field of memoFields) {
      const schema = { [field]: { type: "string" as const } };
      const result = redact({ [field]: "user-private-data" }, { schema });
      expect(result[field]).toBe("[REDACTED]");
    }
  });

  it("redacts memo fields regardless of schema", () => {
    const ctx: RedactionContext = {
      eventType: LogEventType.STELLAR_TX_SUBMITTED,
    };
    const input = {
      message: "tx submitted",
      memo: "private",
      transactionHash: "abc",
    };
    const result = redact(input, ctx);
    expect(result.memo).toBe("[REDACTED]");
    expect(result.message).toBe("tx submitted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Deeply nested objects (3+ levels)
// ─────────────────────────────────────────────────────────────────────────────
describe("Deeply nested objects", () => {
  it("redacts through nested schema", () => {
    const ctx: RedactionContext = {
      eventType: LogEventType.OUTBOX_PUBLISHER_STARTING,
    };
    const input = {
      message: "Starting",
      config: {
        consumerId: "c1",
        leaseSeconds: 300,
        pollIntervalMs: 1000,
        cleanup: { retentionDays: 7 },
        extraNested: "dropped",
      },
    };
    const result = redact(input, ctx);
    expect(result.config.consumerId).toBe("c1");
    expect(result.config.cleanup.retentionDays).toBe(7);
    expect(result.config).not.toHaveProperty("extraNested");
  });

  it("drops unknown fields in nested objects", () => {
    const schema = {
      data: {
        type: "object" as const,
        nested: { id: { type: "string" as const } },
      },
    };
    const result = redact(
      { data: { id: "1", internalNote: "leak" } },
      { schema },
    );
    expect(result.data).toEqual({ id: "1" });
    expect(result.data).not.toHaveProperty("internalNote");
  });

  it("handles 3+ levels of nesting", () => {
    const schema = {
      level1: {
        type: "object" as const,
        nested: {
          level2: {
            type: "object" as const,
            nested: {
              level3: { type: "string" as const },
            },
          },
        },
      },
    };
    const input = { level1: { level2: { level3: "deep", extra: "gone" } } };
    const result = redact(input, { schema });
    expect(result.level1.level2.level3).toBe("deep");
    expect(result.level1.level2).not.toHaveProperty("extra");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Arrays of PII
// ─────────────────────────────────────────────────────────────────────────────
describe("Arrays of PII", () => {
  it("redacts PII fields inside array objects", () => {
    const schema = {
      users: {
        type: "array" as const,
        items: {
          type: "object" as const,
          nested: {
            name: { type: "string" as const },
            email: { type: "string" as const },
          },
        },
      },
    };
    const input = {
      users: [
        { name: "Alice", email: "a@b.com" },
        { name: "Bob", email: "b@c.com" },
      ],
    };
    const result = redact(input, { schema });
    expect(result.users[0].email).toBe("[REDACTED]");
    expect(result.users[1].email).toBe("[REDACTED]");
    expect(result.users[0].name).toBe("Alice");
  });

  it("handles arrays without item schema", () => {
    const schema = { items: { type: "array" as const } };
    const input = { items: [{ password: "bad" }, { safe: "ok" }] };
    const result = redact(input, { schema });
    expect(result.items[0].password).toBe("[REDACTED]");
    expect(result.items[1]).toEqual({});
  });

  it("handles top-level arrays", () => {
    const arr = [{ password: "secret" }, { name: "ok" }];
    const result = redact(arr);
    expect(result[0].password).toBe("[REDACTED]");
  });

  it("handles nested arrays of primitives", () => {
    const schema = {
      tags: { type: "array" as const, items: { type: "string" as const } },
    };
    const result = redact({ tags: ["a", "b", "c"] }, { schema });
    expect(result.tags).toEqual(["a", "b", "c"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe("Edge cases", () => {
  it("handles null input", () => {
    expect(redact(null)).toBeNull();
  });

  it("handles undefined input", () => {
    expect(redact(undefined)).toBeUndefined();
  });

  it("handles primitive string input", () => {
    expect(redact("hello")).toBe("hello");
  });

  it("handles primitive number input", () => {
    expect(redact(42)).toBe(42);
  });

  it("handles boolean input", () => {
    expect(redact(true)).toBe(true);
  });

  it("handles empty object", () => {
    expect(redact({})).toEqual({});
  });

  it("handles empty array", () => {
    expect(redact([])).toEqual([]);
  });

  it("handles Date objects", () => {
    const date = new Date("2025-01-01T00:00:00Z");
    const result = redact(date);
    expect(result).toBe("2025-01-01T00:00:00.000Z");
  });

  it("handles Buffer objects", () => {
    const buf = Buffer.from("sensitive");
    const result = redact(buf);
    expect(result).toBe("[Buffer]");
  });

  it("handles Map objects", () => {
    const map = new Map([
      ["message", "hello"],
      ["extraField", "bad"],
    ]);
    const schema = { message: { type: "string" as const } };
    const result = redact(map, { schema });
    expect(result.message).toBe("hello");
    expect(result).not.toHaveProperty("extraField");
  });

  it("handles Set objects", () => {
    const set = new Set(["a", "b", "c"]);
    const result = redact(set);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("handles Error objects", () => {
    const err = new Error("boom");
    const result = redact(err);
    expect(result.message).toBe("boom");
    expect(result.name).toBe("Error");
    expect(result).toHaveProperty("stack");
  });

  it("handles circular references gracefully", () => {
    const obj: any = { message: "test" };
    obj.self = obj;
    const schema = {
      message: { type: "string" as const },
      self: { type: "any" as const },
    };
    const result = redact(obj, { schema });
    expect(result.message).toBe("test");
    expect(result.self).toBe("[Circular Reference]");
  });

  it("handles very deeply nested objects (max depth)", () => {
    // Build a deeply nested structure > MAX_REDACTION_DEPTH (20)
    // Create nested objects without circular references
    const buildDeep = (depth: number): any => {
      if (depth === 0) return { value: "bottom" };
      return { nested: buildDeep(depth - 1) };
    };
    const obj = buildDeep(25);
    const schema = { nested: { type: "any" as const } };
    const result = redact(obj, { schema });
    // Should not throw - depth protection prevents stack overflow
    expect(result).toBeDefined();
  });

  it("handles null values in schema fields", () => {
    const schema = { data: { type: "string" as const } };
    const result = redact({ data: null }, { schema });
    expect(result.data).toBeNull();
  });

  it("handles undefined values in schema fields", () => {
    const schema = { data: { type: "string" as const } };
    const result = redact({ data: undefined }, { schema });
    expect(result.data).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Security: redaction BEFORE serialization
// ─────────────────────────────────────────────────────────────────────────────
describe("Security: redaction before serialization", () => {
  it("PII never appears in JSON.stringify output", () => {
    const input = {
      message: "Process",
      password: "hunter2",
      apiKey: "sk-12345",
      email: "user@corp.com",
      unknownField: "dropped",
    };
    const ctx: RedactionContext = {
      eventType: LogEventType.GENERIC_INFO,
    };
    const redacted = redact(input, ctx);
    const json = JSON.stringify(redacted);

    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("sk-12345");
    expect(json).not.toContain("user@corp.com");
    expect(json).not.toContain("dropped");
    expect(json).toContain("Process");
  });

  it("nested PII never appears in serialized output", () => {
    const input = {
      message: "event",
      data: { credentials: { password: "s3cret", token: "t0ken" } },
    };
    const schema = {
      message: { type: "string" as const },
      data: {
        type: "object" as const,
        nested: {
          credentials: {
            type: "object" as const,
            nested: {
              password: { type: "string" as const },
              token: { type: "string" as const },
            },
          },
        },
      },
    };
    const redacted = redact(input, { schema });
    const json = JSON.stringify(redacted);
    expect(json).not.toContain("s3cret");
    expect(json).not.toContain("t0ken");
    expect(json).toContain("[REDACTED]");
  });

  it("Stellar memo data never in serialized output", () => {
    const input = { message: "tx", memo: "user-private-wallet-note" };
    const schema = {
      message: { type: "string" as const },
      memo: { type: "string" as const },
    };
    const json = JSON.stringify(redact(input, { schema }));
    expect(json).not.toContain("user-private-wallet-note");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Schema lookup and fallback
// ─────────────────────────────────────────────────────────────────────────────
describe("Schema lookup and fallback", () => {
  it("getSchemaForEventType returns correct schema", () => {
    const schema = getSchemaForEventType(LogEventType.WEBHOOK_DELIVERY_RETRY);
    expect(schema).toHaveProperty("provider");
    expect(schema).toHaveProperty("attempt");
  });

  it("falls back to GENERIC_ERROR for error-like types", () => {
    const schema = getSchemaForEventType("my-service:error");
    expect(schema).toEqual(LOG_SCHEMAS[LogEventType.GENERIC_ERROR]);
  });

  it("falls back to GENERIC_INFO for unknown types", () => {
    const schema = getSchemaForEventType("completely-unknown");
    expect(schema).toEqual(LOG_SCHEMAS[LogEventType.GENERIC_INFO]);
  });

  it("all registered event types have schemas", () => {
    const types = getRegisteredEventTypes();
    for (const t of types) {
      expect(LOG_SCHEMAS).toHaveProperty(t);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Legacy redaction backwards compatibility
// ─────────────────────────────────────────────────────────────────────────────
describe("Legacy redaction", () => {
  it("redacts PII fields in legacy mode", () => {
    const result = redactLegacy({ message: "ok", password: "bad" });
    expect(result.message).toBe("ok");
    expect(result.password).toBe("[REDACTED]");
  });

  it("does not drop unknown fields in legacy mode", () => {
    const result = redactLegacy({ custom: "kept", email: "gone" });
    expect(result.custom).toBe("kept");
    expect(result.email).toBe("[REDACTED]");
  });

  it("handles primitives in legacy mode", () => {
    expect(redactLegacy(null)).toBeNull();
    expect(redactLegacy("string")).toBe("string");
    expect(redactLegacy(42)).toBe(42);
  });

  it("handles arrays in legacy mode", () => {
    const result = redactLegacy([{ password: "x" }, { name: "ok" }]);
    expect(result[0].password).toBe("[REDACTED]");
    expect(result[1].name).toBe("ok");
  });

  it("handles nested objects in legacy mode", () => {
    const result = redactLegacy({
      outer: { inner: { token: "t", safe: "ok" } },
    });
    expect(result.outer.inner.token).toBe("[REDACTED]");
    expect(result.outer.inner.safe).toBe("ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Real-world call site schemas
// ─────────────────────────────────────────────────────────────────────────────
describe("Real-world call site schemas", () => {
  it("OUTBOX_PUBLISHER_STARTING with full config", () => {
    const input = {
      message: "[OutboxPublisher] Starting",
      config: {
        consumerId: "c1",
        leaseSeconds: 300,
        pollIntervalMs: 1000,
        cleanupIntervalMs: 3600000,
        batchSize: 100,
        cleanup: { publishedRetentionDays: 7, failedRetentionDays: 30 },
      },
    };
    const result = redact(input, {
      eventType: LogEventType.OUTBOX_PUBLISHER_STARTING,
    });
    expect(result.message).toBe("[OutboxPublisher] Starting");
    expect(result.config.consumerId).toBe("c1");
    expect(result.config.cleanup.publishedRetentionDays).toBe(7);
  });

  it("OUTBOX_PUBLISHER_EVENT_QUARANTINED", () => {
    const input = {
      message: "Event quarantined",
      eventType: "bond.created",
      reason: "schema_invalid",
      error: "field missing",
      extraField: "dropped",
    };
    const result = redact(input, {
      eventType: LogEventType.OUTBOX_PUBLISHER_EVENT_QUARANTINED,
    });
    expect(result.message).toBe("Event quarantined");
    expect(result.reason).toBe("schema_invalid");
    expect(result).not.toHaveProperty("extraField");
  });

  it("WEBHOOK_DELIVERY_EXHAUSTED", () => {
    const input = {
      message: "exhausted",
      provider: "stripe",
      attempts: 5,
      errorCode: "HTTP_500",
    };
    const result = redact(input, {
      eventType: LogEventType.WEBHOOK_DELIVERY_EXHAUSTED,
    });
    expect(result).toEqual(input);
  });

  it("SOROBAN_RETRY schema", () => {
    const input = {
      message: "Retrying",
      provider: "soroban",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 400,
      code: "NETWORK_ERROR",
    };
    const result = redact(input, {
      eventType: LogEventType.SOROBAN_RETRY,
    });
    expect(result).toEqual(input);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Field type: 'any' with PII scanning
// ─────────────────────────────────────────────────────────────────────────────
describe("Field type 'any' with PII scanning", () => {
  it("GENERIC_INFO schema allows message field with any type", () => {
    const input = { message: "simple string" };
    const result = redact(input, { eventType: LogEventType.GENERIC_INFO });
    expect(result.message).toBe("simple string");
  });

  it("GENERIC_INFO schema allows message field with object", () => {
    const input = { message: { text: "hello", count: 5 } };
    const result = redact(input, { eventType: LogEventType.GENERIC_INFO });
    // The message field is allowed with type "any"
    expect(result.message).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Comprehensive PII pattern coverage
// ─────────────────────────────────────────────────────────────────────────────
describe("Comprehensive PII pattern coverage", () => {
  it("all PII_PATTERNS entries are lowercase", () => {
    for (const pattern of PII_PATTERNS) {
      expect(pattern).toBe(pattern.toLowerCase());
    }
  });

  it("all STELLAR_SENSITIVE_FIELDS entries are lowercase", () => {
    for (const field of STELLAR_SENSITIVE_FIELDS) {
      expect(field).toBe(field.toLowerCase());
    }
  });

  it("newly added PII patterns are detected", () => {
    const newPatterns = [
      "secretKey",
      "signing_key",
      "encryptionKey",
      "bearer",
      "credential",
      "pin",
      "passcode",
      "dateOfBirth",
      "nationalId",
      "taxId",
      "driversLicense",
      "passportNumber",
    ];
    for (const p of newPatterns) {
      expect(isPIIField(p)).toBe(true);
    }
  });
});
