import { describe, it, expect } from "vitest";
import { validateConfig } from "../index.js";

function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PORT: "3000",
    NODE_ENV: "development",
    LOG_LEVEL: "info",
    DB_URL: "postgresql://user:pass@localhost:5432/credence",
    REDIS_URL: "redis://localhost:6379",
    JWT_SECRET: "a]r$8kL!qZ3wX#mN9pT&vB6yD0fH2jU4",
    JWT_EXPIRY: "1h",
    ENABLE_TRUST_SCORING: "false",
    ENABLE_BOND_EVENTS: "false",
    CORS_ORIGIN: "*",
    ...overrides,
  };
}

describe("Tracing config validation (Issue #1627)", () => {
  it("defaults exporter to 'console' and ratio to 1.0 in development", () => {
    const config = validateConfig(validEnv({ NODE_ENV: "development" }));
    expect(config.tracing.exporter).toBe("console");
    expect(config.tracing.samplerRatio).toBe(1.0);
  });

  it("defaults exporter to 'none' and ratio to 0.1 in production", () => {
    const config = validateConfig(validEnv({ NODE_ENV: "production" }));
    expect(config.tracing.exporter).toBe("none");
    expect(config.tracing.samplerRatio).toBe(0.1);
  });

  it("fails validation when exporter is 'otlp' without OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    expect(() =>
      validateConfig(validEnv({ OTEL_TRACES_EXPORTER: "otlp" }))
    ).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT is required/);
  });

  it("passes validation when exporter is 'otlp' with valid OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    const config = validateConfig(
      validEnv({
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel-collector.internal:4318/v1/traces",
      })
    );
    expect(config.tracing.exporter).toBe("otlp");
    expect(config.tracing.otlpEndpoint).toBe(
      "https://otel-collector.internal:4318/v1/traces"
    );
  });

  it("validates OTEL_TRACES_SAMPLER_RATIO within [0.0, 1.0]", () => {
    const validConfig = validateConfig(
      validEnv({
        OTEL_TRACES_SAMPLER_RATIO: "0.25",
      })
    );
    expect(validConfig.tracing.samplerRatio).toBe(0.25);

    expect(() =>
      validateConfig(
        validEnv({
          OTEL_TRACES_SAMPLER_RATIO: "1.5",
        })
      )
    ).toThrow();
  });
});
