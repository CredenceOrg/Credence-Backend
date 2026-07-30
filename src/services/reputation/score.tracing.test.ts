import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ReputationSpans } from "../../tracing/tracer.js";
import type { ReputationInput } from "./types.js";

const ONE_DAY = 24 * 60 * 60 * 1000;
const ONE_YEAR = 365 * ONE_DAY;

function makeInput(): ReputationInput {
  return {
    bond: {
      bondedAmount: 10000,
      bondStart: 1000000,
      bondDuration: ONE_YEAR,
      isSlashed: false,
    },
    attestations: [
      { weight: 100, timestamp: 1000000, isValid: true },
      { weight: 200, timestamp: 1000001, isValid: true },
    ],
    currentTime: 1000000 + ONE_YEAR,
  };
}

describe("reputation tracing spans", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider();

  beforeAll(() => {
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it("creates nested computation spans with bounded attributes", async () => {
    exporter.reset();
    const { calculateReputationScore } = await import("./score.js");

    calculateReputationScore(makeInput(), "identity-ref-123");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);

    const computeSpan = spans.find((s) => s.name === ReputationSpans.COMPUTE);
    expect(computeSpan).toBeDefined();
    expect(computeSpan?.attributes["reputation.identity_id"]).toBe(
      "identity-ref-123",
    );
    expect(computeSpan?.attributes["reputation.input_vector_size"]).toBe(3);
    expect(computeSpan?.attributes["reputation.result_score"]).toBe(130);

    const stageNames = new Set(spans.map((s) => s.name));
    expect(stageNames).toEqual(
      new Set([
        ReputationSpans.COMPUTE,
        ReputationSpans.BOND_SCORE,
        ReputationSpans.ATTESTATION_SCORE,
        ReputationSpans.TIME_WEIGHT,
      ]),
    );

    const childSpans = spans.filter((s) => s.name !== ReputationSpans.COMPUTE);
    for (const span of childSpans) {
      expect(span.spanContext().traceId).toBe(
        computeSpan?.spanContext().traceId,
      );
      expect(span.attributes["reputation.stage_result"]).toBeTypeOf("number");
    }
  });

  it("records exception and sets error status when a stage throws", async () => {
    exporter.reset();

    vi.resetModules();
    vi.doMock("./attestationScore.js", async () => {
      const actual = await vi.importActual<
        typeof import("./attestationScore.js")
      >("./attestationScore.js");
      return {
        ...actual,
        calculateAttestationScore: () => {
          throw new Error("attestation stage failed");
        },
      };
    });

    const { calculateReputationScore } = await import("./score.js");

    expect(() =>
      calculateReputationScore(makeInput(), "identity-ref-123"),
    ).toThrow("attestation stage failed");

    const spans = exporter.getFinishedSpans();

    const computeSpan = spans.find((s) => s.name === ReputationSpans.COMPUTE);
    const attestationSpan = spans.find(
      (s) => s.name === ReputationSpans.ATTESTATION_SCORE,
    );

    expect(computeSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(attestationSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(attestationSpan?.events.some((e) => e.name === "exception")).toBe(
      true,
    );

    vi.doUnmock("./attestationScore.js");
    vi.resetModules();
  });
});
