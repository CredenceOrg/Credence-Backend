import { trace, context, SpanStatusCode, Span } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

/**
 * Canonical span names for the payment processing pipeline.
 * Using constants prevents typos and makes refactoring easier.
 */
export const PaymentSpans = {
  PROCESS: "payment.process",
  INGEST: "payment.ingest",
  VALIDATE: "payment.validate",
  RISK_CHECK: "payment.risk_check",
  PROCESSOR: "payment.processor",
  SETTLE: "payment.settle",
} as const;

/**
 * Canonical span names for database operations.
 */
export const DbSpans = {
  TX: "db.tx",
} as const;

/**
 * Canonical span names for the reputation score computation pipeline.
 */
export const ReputationSpans = {
  COMPUTE: "reputation.compute",
  ATTESTATION_SCORE: "reputation.attestation_score",
  BOND_SCORE: "reputation.bond_score",
  TIME_WEIGHT: "reputation.time_weight",
} as const

/**
 * Initialize OpenTelemetry tracing for the application
 */
export interface TracingOptions {
  serviceName?: string;
  exporter?: "none" | "console" | "otlp";
  otlpEndpoint?: string;
  samplerRatio?: number;
}

export function initTracing(
  optionsOrServiceName?: string | TracingOptions,
): NodeTracerProvider {
  const options: TracingOptions =
    typeof optionsOrServiceName === "string"
      ? { serviceName: optionsOrServiceName }
      : optionsOrServiceName ?? {};

  const serviceName = options.serviceName ?? "credence-backend";
  const nodeEnv = process.env.NODE_ENV;
  const exporterType =
    options.exporter ??
    (process.env.OTEL_TRACES_EXPORTER as "none" | "console" | "otlp" | undefined) ??
    (nodeEnv === "production" ? "none" : "console");

  const ratio =
    options.samplerRatio ??
    (process.env.OTEL_TRACES_SAMPLER_RATIO
      ? parseFloat(process.env.OTEL_TRACES_SAMPLER_RATIO)
      : nodeEnv === "production"
        ? 0.1
        : 1.0);

  const resource = Resource.default().merge(
    new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
  );

  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(Math.max(0, Math.min(1, ratio))),
  });

  const provider = new NodeTracerProvider({
    resource,
    sampler,
  });

  if (exporterType === "console") {
    provider.addSpanProcessor(new BatchSpanProcessor(new ConsoleSpanExporter()));
  } else if (exporterType === "otlp") {
    const url = options.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const otlpExporter = new OTLPTraceExporter(url ? { url } : undefined);
    provider.addSpanProcessor(new BatchSpanProcessor(otlpExporter));
  }

  provider.register();

  return provider;
}

/**
 * Get the tracer instance for payment operations
 */
export function getPaymentTracer() {
  return trace.getTracer("payment-service", "1.0.0");
}

/**
 * Get the tracer instance for reputation operations.
 */
export function getReputationTracer() {
  return trace.getTracer("reputation-service", "1.0.0");
}

/**
 * Utility to wrap async operations with tracing spans
 */
export async function withSpan<T>(
  spanName: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = trace.getTracer("credence-backend");
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      if (attributes) {
        span.setAttributes(attributes);
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Get current trace context for propagation
 */
export function getCurrentContext() {
  return context.active();
}

/**
 * Run function with specific trace context
 */
export function withContext<T>(ctx: any, fn: () => T): T {
  return context.with(ctx, fn);
}
