import { trace, context, SpanStatusCode, Span } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'

/**
 * Canonical span names for the payment processing pipeline.
 * Using constants prevents typos and makes refactoring easier.
 */
export const PaymentSpans = {
  PROCESS:    'payment.process',
  INGEST:     'payment.ingest',
  VALIDATE:   'payment.validate',
  RISK_CHECK: 'payment.risk_check',
  PROCESSOR:  'payment.processor',
  SETTLE:     'payment.settle',
} as const

/**
 * Initialize OpenTelemetry tracing for the application
 */
export function initTracing(serviceName = 'credence-backend'): NodeTracerProvider {
  const resource = Resource.default().merge(
    new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
    })
  )

  const provider = new NodeTracerProvider({
    resource,
  })

  // Use ConsoleSpanExporter for development
  // In production, replace with OTLP exporter to send to Jaeger/Tempo/etc
  provider.addSpanProcessor(new BatchSpanProcessor(new ConsoleSpanExporter()))

  provider.register()

  return provider
}

/**
 * Get the tracer instance for payment operations
 */
export function getPaymentTracer() {
  return trace.getTracer('payment-service', '1.0.0')
}

/**
 * Utility to wrap async operations with tracing spans
 */
export async function withSpan<T>(
  spanName: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  const tracer = trace.getTracer('credence-backend')
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      if (attributes) {
        span.setAttributes(attributes)
      }
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      })
      span.recordException(error as Error)
      throw error
    } finally {
      span.end()
    }
  })
}

/**
 * Get current trace context for propagation
 */
export function getCurrentContext() {
  return context.active()
}

/**
 * Run function with specific trace context
 */
export function withContext<T>(ctx: any, fn: () => T): T {
  return context.with(ctx, fn)
}
