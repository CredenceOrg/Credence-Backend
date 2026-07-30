/**
 * src/sdk/grpc/interceptors.ts
 *
 * Connect-RPC interceptors shared by all internal gRPC clients.
 *
 * The shared-secret interceptor injects the `x-credence-internal-token`
 * header on every outbound request.  The gRPC server validates this header
 * before processing any call.
 *
 * Usage:
 *   import { createSharedSecretInterceptor } from './interceptors.js'
 *   const transport = createGrpcWebTransport({
 *     baseUrl,
 *     interceptors: [createSharedSecretInterceptor(secret)],
 *   })
 */

// NOTE: The actual @connectrpc/connect import is resolved at runtime once
// `buf generate` has been run and the npm packages are installed.
// The type import below uses a conditional so that this file compiles even
// before code generation has been executed.
import type { Interceptor } from '@connectrpc/connect'
import { ConnectError, Code } from '@connectrpc/connect'
import { tracingContext } from '../../utils/logger.js'
import { SdkRequestTimeoutCredenceError } from '../errors.generated.js'
import type { TimeoutMetricsCollector } from '../../observability/timeoutMetrics.js'
import { createTimeoutEvent } from '../../observability/timeoutMetrics.js'

/**
 * INTERNAL_TOKEN_HEADER is the metadata key used to authenticate internal
 * service-to-service gRPC calls.  The server rejects requests that omit or
 * present an invalid value for this header.
 */
export const INTERNAL_TOKEN_HEADER = 'x-credence-internal-token'

/**
 * createSharedSecretInterceptor returns a Connect-RPC interceptor that
 * attaches the shared secret to every outbound request header.
 *
 * @param secret - The shared secret configured via GRPC_INTERNAL_SECRET.
 *                 Must be non-empty.
 */
export function createSharedSecretInterceptor(secret: string): Interceptor {
  if (!secret) {
    throw new Error(
      'createSharedSecretInterceptor: secret must be non-empty. ' +
        'Set the GRPC_INTERNAL_SECRET environment variable.',
    )
  }

  return (next) => (req) => {
    req.header.set(INTERNAL_TOKEN_HEADER, secret)
    return next(req)
  }
}

/**
 * createRequestIdInterceptor returns an interceptor that propagates the
 * X-Request-ID header from the current async context into outbound gRPC
 * calls, enabling end-to-end distributed tracing.
 *
 * Pass the requestId string obtained from the Express requestIdMiddleware.
 * If not provided, it falls back to the tracingContext store.
 */
export function createRequestIdInterceptor(requestId?: string): Interceptor {
  return (next) => (req) => {
    const id = requestId || tracingContext.getStore()?.get('requestId')
    if (id) {
      req.header.set('x-request-id', id)
    }
    return next(req)
  }
}

/**
 * Key used in the tracingContext to store the caller's remaining deadline
 * budget in milliseconds.  Set this before performing gRPC calls to propagate
 * an inbound timeout deadline.
 *
 * Example:
 *   const store = tracingContext.getStore()
 *   store?.set(GRPC_DEADLINE_REMAINING_KEY, String(remainingMs))
 */
export const GRPC_DEADLINE_REMAINING_KEY = 'grpcDeadlineRemainingMs'

/**
 * Default timeout in ms when neither a per-method budget, a wildcard entry,
 * nor a caller-remaining deadline is available.
 */
export const GRPC_DEFAULT_TIMEOUT_MS = 10_000

/**
 * createDeadlineInterceptor returns a Connect-RPC interceptor that applies
 * per-method timeout budgets and propagates any inbound caller-remaining
 * deadline stored in the async context.
 *
 * Deadline composition rule (monotonic from edge inward):
 *   effective = min(configuredBudget, callerRemaining)
 *
 * The interceptor:
 *   - Looks up the method in `timeoutsMs` (key format:
 *     `"<service.typeName>/<method.name>"`, e.g.
 *     `"credence.v1.TrustService/GetTrustScore"`).
 *   - Falls back to the wildcard key `"*"` if the method is not listed.
 *   - Falls back to `GRPC_DEFAULT_TIMEOUT_MS` if no match is found.
 *   - Reads `GRPC_DEADLINE_REMAINING_KEY` from the async-local tracing context
 *     to incorporate any inbound deadline remaining.
 *   - Composes the parent AbortSignal with an internal timeout via a new
 *     AbortController.  Whichever fires first (parent abort or our timer)
 *     cancels the call.
 *   - Wraps DEADLINE_EXCEEDED / abort errors as `SdkRequestTimeoutCredenceError`.
 *   - Emits a timeout metric via `collector` if provided.
 *
 * @param timeoutsMs    Per-method timeout map.  Key `"*"` sets the default.
 * @param collector     Optional metrics collector for timeout observability.
 *
 * @example
 *   const interceptor = createDeadlineInterceptor({
 *     "*": 10_000,
 *     "credence.v1.TrustService/GetTrustScore": 5_000,
 *   }, metricsCollector)
 */
export function createDeadlineInterceptor(
  timeoutsMs: Record<string, number>,
  collector?: TimeoutMetricsCollector,
): Interceptor {
  const getTimeout = (methodPath: string): number =>
    timeoutsMs[methodPath] ?? timeoutsMs['*'] ?? GRPC_DEFAULT_TIMEOUT_MS

  return (next) => async (req) => {
    const methodPath = `${req.service.typeName}/${req.method.name}`
    const configuredBudget = getTimeout(methodPath)

    // Read caller-remaining deadline from async context
    const store = tracingContext.getStore()
    let callerRemaining: number | undefined
    if (store?.has(GRPC_DEADLINE_REMAINING_KEY)) {
      const raw = store.get(GRPC_DEADLINE_REMAINING_KEY)!
      callerRemaining = parseInt(raw, 10)
    }

    // Effective timeout = min(configured, caller remaining)
    const callerMs =
      callerRemaining !== undefined && !isNaN(callerRemaining) && callerRemaining >= 0
        ? callerRemaining
        : Infinity
    const effectiveMs = Math.min(configuredBudget, callerMs)

    // Fast-fail: deadline already expired
    if (effectiveMs <= 0 || req.signal.aborted) {
      const err = new SdkRequestTimeoutCredenceError(
        `gRPC deadline already expired for ${methodPath}`,
      )
      recordTimeout(collector, methodPath, effectiveMs, 0, err)
      throw err
    }

    // Compose parent signal with our own timeout timer
    const controller = new AbortController()
    const startTime = Date.now()

    const onParentAbort = (): void => {
      controller.abort()
    }
    req.signal.addEventListener('abort', onParentAbort)

    const timer = setTimeout(() => controller.abort(), effectiveMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      req.signal.removeEventListener('abort', onParentAbort)
    }

    try {
      const result = await next({ ...req, signal: controller.signal })
      cleanup()
      return result
    } catch (e) {
      cleanup()
      const durationMs = Date.now() - startTime

      // Our timeout fired → parent did NOT cancel us
      if (controller.signal.aborted && !req.signal.aborted) {
        const err = new SdkRequestTimeoutCredenceError(
          `gRPC deadline exceeded for ${methodPath} after ${durationMs}ms`,
        )
        recordTimeout(collector, methodPath, effectiveMs, durationMs, err)
        throw err
      }

      // Server-side DEADLINE_EXCEEDED (e.g. downstream propagated our deadline)
      if (e instanceof ConnectError && e.code === Code.DeadlineExceeded) {
        const err = new SdkRequestTimeoutCredenceError(
          `gRPC server returned DEADLINE_EXCEEDED for ${methodPath}: ${e.message}`,
          0,
          undefined,
          { cause: e },
        )
        recordTimeout(collector, methodPath, effectiveMs, durationMs, err)
        throw err
      }

      throw e
    }
  }
}

function recordTimeout(
  collector: TimeoutMetricsCollector | undefined,
  operation: string,
  timeoutMs: number,
  actualDurationMs: number,
  error: Error,
): void {
  if (!collector) return
  collector.onTimeout(
    createTimeoutEvent({
      serviceType: 'grpc',
      reasonCode: 'GRPC_TIMEOUT',
      operation,
      timeoutMs,
      actualDurationMs: actualDurationMs || 0,
      error,
    }),
  )
}

/**
 * Type guard: returns true when the error is a Connect-RPC
 * DEADLINE_EXCEEDED or an AbortError caused by a deadline timeout.
 */
export function isDeadlineExceededError(e: unknown): boolean {
  if (e instanceof ConnectError && e.code === Code.DeadlineExceeded) return true
  if (e instanceof Error && e.name === 'AbortError') return true
  if (e instanceof DOMException && e.name === 'AbortError') return true
  return false
}
