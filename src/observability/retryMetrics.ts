/**
 * Per-provider retry observability.
 *
 * Exposes a RetryObserver interface so clients can emit structured events
 * without coupling to a specific metrics backend. The default implementation
 * records Prometheus counters and histograms via prom-client (optional dep —
 * falls back to a no-op when prom-client is not installed).
 */

// ---------------------------------------------------------------------------
// Observer interface — backend-agnostic
// ---------------------------------------------------------------------------

export interface RetryAttemptEvent {
  /** Provider label, e.g. "soroban", "webhook". */
  provider: string
  /** 1-based attempt number that just failed and triggered a retry. */
  attempt: number
  /** Delay that will be waited before the next attempt (ms). */
  delayMs: number
  /** Normalised error code from the client, e.g. "TIMEOUT_ERROR". */
  errorCode: string
}

export interface RetryExhaustedEvent {
  /** Provider label. */
  provider: string
  /** Total attempts made before giving up. */
  attempts: number
  /** Final error code. */
  errorCode: string
}

export interface RetrySuccessEvent {
  /** Provider label. */
  provider: string
  /** Attempt number on which the call succeeded (1 = first try, no retry). */
  attempt: number
  /** Total wall-clock duration of the call including all retries (ms). */
  durationMs: number
}

/**
 * Observability hooks called by retry-aware clients.
 * All methods are optional so callers can provide partial implementations.
 */
export interface RetryObserver {
  /** Called after each failed attempt that will be retried. */
  onRetryAttempt?(event: RetryAttemptEvent): void
  /** Called when all retry attempts are exhausted. */
  onRetryExhausted?(event: RetryExhaustedEvent): void
  /** Called when a call succeeds (first try or after retries). */
  onSuccess?(event: RetrySuccessEvent): void
}

// ---------------------------------------------------------------------------
// No-op observer (safe default)
// ---------------------------------------------------------------------------

export const noopRetryObserver: RetryObserver = {}

// ---------------------------------------------------------------------------
// Prometheus observer (loaded lazily to avoid hard dep on prom-client)
// ---------------------------------------------------------------------------

interface PromCounter {
  inc(labels: Record<string, string>, value?: number): void
}

interface PromHistogram {
  observe(labels: Record<string, string>, value: number): void
}

interface PromRegistry {
  registerMetric(metric: { name: string }): void
}

interface PromClient {
  Counter: new (opts: {
    name: string
    help: string
    labelNames: string[]
    registers?: PromRegistry[]
  }) => PromCounter
  Histogram: new (opts: {
    name: string
    help: string
    labelNames: string[]
    buckets?: number[]
    registers?: PromRegistry[]
  }) => PromHistogram
  Registry: new () => PromRegistry
  register: PromRegistry
}

import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

let _promClient: PromClient | null | undefined = undefined

function tryLoadPromClient(): PromClient | null {
  if (_promClient !== undefined) return _promClient
  try {
    _promClient = _require('prom-client') as PromClient
  } catch {
    _promClient = null
  }
  return _promClient
}

let _prometheusObserver: RetryObserver | null | undefined = undefined

/**
 * Returns a singleton Prometheus-backed RetryObserver.
 * Falls back to noopRetryObserver when prom-client is unavailable.
 */
export function createPrometheusRetryObserver(registry?: PromRegistry): RetryObserver {
  if (_prometheusObserver !== undefined) return _prometheusObserver ?? noopRetryObserver

  const prom = tryLoadPromClient()
  if (!prom) {
    _prometheusObserver = null
    return noopRetryObserver
  }

  const reg = registry ?? prom.register

  const retryAttemptsTotal = new prom.Counter({
    name: 'outbound_retry_attempts_total',
    help: 'Total number of outbound retry attempts per provider and error code',
    labelNames: ['provider', 'error_code'],
    registers: [reg],
  })

  const retryExhaustedTotal = new prom.Counter({
    name: 'outbound_retry_exhausted_total',
    help: 'Total number of times all retry attempts were exhausted per provider',
    labelNames: ['provider', 'error_code'],
    registers: [reg],
  })

  const retryDelayHistogram = new prom.Histogram({
    name: 'outbound_retry_delay_milliseconds',
    help: 'Distribution of retry backoff delays in milliseconds per provider',
    labelNames: ['provider'],
    buckets: [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000],
    registers: [reg],
  })

  const callDurationHistogram = new prom.Histogram({
    name: 'outbound_call_duration_milliseconds',
    help: 'Total wall-clock duration of outbound calls (including retries) in milliseconds',
    labelNames: ['provider', 'outcome'],
    buckets: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
    registers: [reg],
  })

  _prometheusObserver = {
    onRetryAttempt(event) {
      retryAttemptsTotal.inc({ provider: event.provider, error_code: event.errorCode })
      retryDelayHistogram.observe({ provider: event.provider }, event.delayMs)
    },
    onRetryExhausted(event) {
      retryExhaustedTotal.inc({ provider: event.provider, error_code: event.errorCode })
    },
    onSuccess(event) {
      callDurationHistogram.observe(
        { provider: event.provider, outcome: event.attempt === 1 ? 'first_try' : 'retried' },
        event.durationMs,
      )
    },
  }

  return _prometheusObserver
}

/**
 * Reset the cached singleton (test helper only).
 * @internal
 */
export function _resetPrometheusObserverCache(): void {
  _prometheusObserver = undefined
  _promClient = undefined
}
