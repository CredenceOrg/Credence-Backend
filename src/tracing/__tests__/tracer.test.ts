import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTracing } from "../tracer.js";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

describe("OpenTelemetry Tracing initialization (Issue #1627)", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("registers no SpanProcessor when OTEL_TRACES_EXPORTER is 'none'", () => {
    delete process.env.NODE_ENV;
    process.env.OTEL_TRACES_EXPORTER = "none";

    const provider = initTracing();
    const registered = (provider as any)["_registeredSpanProcessors"] ?? [];
    expect(registered).toHaveLength(0);
  });

  it("defaults to 'none' in production when OTEL_TRACES_EXPORTER is not set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.OTEL_TRACES_EXPORTER;

    const provider = initTracing();
    const registered = (provider as any)["_registeredSpanProcessors"] ?? [];
    expect(registered).toHaveLength(0);
  });

  it("registers ConsoleSpanExporter when exporter is 'console'", () => {
    delete process.env.NODE_ENV;
    process.env.OTEL_TRACES_EXPORTER = "console";

    const provider = initTracing();
    const registered = (provider as any)["_registeredSpanProcessors"] ?? [];
    expect(registered.length).toBeGreaterThan(0);
    const exporter = registered[0]?.["_exporter"];
    expect(exporter).toBeInstanceOf(ConsoleSpanExporter);
  });

  it("registers OTLPTraceExporter when exporter is 'otlp' with endpoint", () => {
    delete process.env.NODE_ENV;
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318/v1/traces";

    const provider = initTracing();
    const registered = (provider as any)["_registeredSpanProcessors"] ?? [];
    expect(registered.length).toBeGreaterThan(0);
    const exporter = registered[0]?.["_exporter"];
    expect(exporter).toBeInstanceOf(OTLPTraceExporter);
  });

  it("accepts TracingOptions directly to override env variables", () => {
    const provider = initTracing({
      exporter: "otlp",
      otlpEndpoint: "http://tempo:4318/v1/traces",
      samplerRatio: 0.5,
    });
    const registered = (provider as any)["_registeredSpanProcessors"] ?? [];
    expect(registered.length).toBeGreaterThan(0);
    const exporter = registered[0]?.["_exporter"];
    expect(exporter).toBeInstanceOf(OTLPTraceExporter);
  });
});
