import client from 'prom-client'
import { register } from '../middleware/metrics.js'

export const failedInboundSweeperRunsTotal = new client.Counter({
  name: 'failed_inbound_sweeper_runs_total',
  help: 'Total number of failed inbound events sweeper runs',
  registers: [register],
})

/**
 * Buckets are inclusive upper bounds (`le`): a sample equal to a bound lands in
 * that bucket. Samples above the last bound (60s) are counted only by the
 * implicit `+Inf` bucket and the `_count` series.
 */
export const failedInboundSweeperDurationSeconds = new client.Histogram({
  name: 'failed_inbound_sweeper_duration_seconds',
  help: 'Duration of failed inbound events sweeper runs in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
})

export const failedInboundSweptTotal = new client.Counter({
  name: 'failed_inbound_swept_total',
  help: 'Total number of terminal failed inbound events swept (deleted)',
  registers: [register],
})

/**
 * Monotonic across sweeper runs: `setRetained` accumulates the per-run retained
 * count, it does not overwrite a current value. The `_total` suffix matches
 * Prometheus counter conventions; dashboards must use `increase()`/`rate()`.
 */
export const failedInboundRetainedTotal = new client.Counter({
  name: 'failed_inbound_retained_total',
  help: 'Total number of failed inbound events retained (not yet expired)',
  registers: [register],
})

/**
 * Normalize an externally supplied counter delta.
 *
 * Every count the sweeper reports is derived from a database
 * `COUNT(*)`/`rowCount`, so it is a non-negative integer. The wrapper is still
 * defensive because the three counters are shared, unlabeled series: a single
 * poisoned sample corrupts the whole series for the lifetime of the process.
 * prom-client rejects negatives and infinities itself, but `NaN` is falsy and
 * slips past its finiteness check, silently turning the series into `NaN`.
 *
 * Invariant: a count is recorded only when it is a non-negative finite number.
 * Anything else is dropped, never thrown, so metrics can never fail a sweep.
 *
 * @returns the value to record, or `null` when the sample must be ignored.
 */
function normalizeCount(value: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return value
}

/**
 * Normalize a duration sample in seconds.
 *
 * `Date.now()` deltas are always finite and non-negative, but a caller can
 * hand us an uninitialized or clock-skewed value. Same invariant as
 * {@link normalizeCount}: only non-negative finite samples are observed.
 */
function normalizeDuration(seconds: number): number | null {
  return normalizeCount(seconds)
}

/**
 * Create a metrics handle for the failed-inbound sweeper.
 *
 * Every call returns a fresh handle, but all handles are backed by the same
 * module-level metric instances registered on the shared Prometheus registry,
 * so observations made through one handle are visible through another and via
 * the exported metrics directly.
 *
 * Invariant: unlike the raw prom-client metrics, these methods never throw on
 * invalid input, so a metrics bug can never abort a sweep (the sweeper's
 * `finally` still clears its `running` flag, allowing the next run).
 */
export function createFailedInboundSweeperMetrics() {
  return {
    incRuns: (): void => {
      failedInboundSweeperRunsTotal.inc()
    },
    observeDuration: (seconds: number): void => {
      const normalized = normalizeDuration(seconds)
      if (normalized === null) return
      failedInboundSweeperDurationSeconds.observe(normalized)
    },
    incSwept: (count: number): void => {
      const normalized = normalizeCount(count)
      if (normalized === null) return
      failedInboundSweptTotal.inc(normalized)
    },
    setRetained: (count: number): void => {
      const normalized = normalizeCount(count)
      if (normalized === null) return
      failedInboundRetainedTotal.inc(normalized)
    },
  }
}

export type FailedInboundSweeperMetrics = ReturnType<typeof createFailedInboundSweeperMetrics>
