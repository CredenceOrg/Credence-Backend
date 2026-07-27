import client from 'prom-client'
import { register } from '../middleware/metrics.js'
import type { TransientErrorKind } from '../services/analytics/refreshStrategy.js'

/**
 * Per-view attempt counter. Labelled by view name and status (success|error)
 * so a single grafana panel can show per-view success rate, latency, and
 * error budget.
 */
export const analyticsRefreshRunsTotal = new client.Counter({
  name: 'analytics_refresh_runs_total',
  help: 'Total number of analytics materialized view refresh attempts',
  labelNames: ['view', 'status'] as const,
  registers: [register],
})

/**
 * Per-view REFRESH duration histogram. The bucket range is wider than
 * the table-level histogram used pre-strategy because per-view
 * statement_timeout knobs can range from 5s (small views) to 10min
 * (huge views on cold cache).
 */
export const analyticsRefreshDurationSeconds = new client.Histogram({
  name: 'analytics_refresh_duration_seconds',
  help: 'Duration of analytics materialized view REFRESH CONCURRENTLY in seconds, labelled by view',
  labelNames: ['view'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
})

/**
 * Counter for transient-error retries the strategy classified and retried.
 * If this climbs for a given kind, the relevant Postgres subsystem is
 * unhealthy (e.g. `deadlock_detected` climbing means a concurrent writer
 * is hot-patching tables inside the view's dependency graph).
 */
export const analyticsRefreshTransientRetriesTotal = new client.Counter({
  name: 'analytics_refresh_transient_retries_total',
  help: 'Transient Postgres errors that the refresh strategy retried (counts attempt, not success)',
  labelNames: ['view', 'kind'] as const,
  registers: [register],
})

/**
 * Latest cache-generation token bumped by the strategy on every fully
 * successful refresh tick. Reads can watch this to confirm invalidation.
 */
export const analyticsRefreshCacheGeneration = new client.Gauge({
  name: 'analytics_refresh_cache_generation',
  help: 'Current analytics cache generation token (bumped on every fully successful refresh tick)',
  registers: [register],
})

/**
 * Consecutive-failure counter per view. Climbs every failure, resets on
 * success. Drives the per-view cooldown encoded in
 * `AnalyticsRefreshScheduler` via `failCooldownThreshold` +
 * `failCooldownMs`.
 */
export const analyticsRefreshConsecutiveFailures = new client.Gauge({
  name: 'analytics_refresh_consecutive_failures',
  help: 'Number of consecutive refresh failures per view (resets on success)',
  labelNames: ['view'] as const,
  registers: [register],
})

/**
 * Counter for scheduler ticks skipped because the strategy was already
 * running (`overlap`), a peer replica held the lock (`lock_contention`),
 * or a view crossed the cooldown threshold (`cooldown`).
 */
export const analyticsSchedulerSkipsTotal = new client.Counter({
  name: 'analytics_scheduler_skips_total',
  help: 'Total number of scheduler ticks skipped due to overlap, lock contention, or concurrent-failure cooldown',
  labelNames: ['reason'] as const,
  registers: [register],
})

export type SchedulerSkipReason = 'overlap' | 'lock_contention' | 'cooldown'

export interface AnalyticsRefreshMetrics {
  incRuns(status: 'success' | 'error', view: string): void
  observeDuration(seconds: number, view: string): void
  incTransientRetry(view: string, kind: TransientErrorKind): void
  setCacheGeneration(value: number): void
  setConsecutiveFailures(view: string, count: number): void
  incSkip(reason: SchedulerSkipReason): void
}

export function createAnalyticsRefreshMetrics(): AnalyticsRefreshMetrics {
  return {
    incRuns: (status, view) => analyticsRefreshRunsTotal.inc({ view, status }),
    observeDuration: (seconds, view) =>
      analyticsRefreshDurationSeconds.observe({ view }, seconds),
    incTransientRetry: (view, kind) =>
      analyticsRefreshTransientRetriesTotal.inc({ view, kind }),
    setCacheGeneration: (value) => analyticsRefreshCacheGeneration.set(value),
    setConsecutiveFailures: (view, count) =>
      analyticsRefreshConsecutiveFailures.set({ view }, count),
    incSkip: (reason) => analyticsSchedulerSkipsTotal.inc({ reason }),
  }
}

/**
 * @internal Exported for tests that need to reset metric state between cases.
 */
export function resetAnalyticsRefreshMetrics(): void {
  analyticsRefreshRunsTotal.reset()
  analyticsRefreshDurationSeconds.reset()
  analyticsRefreshTransientRetriesTotal.reset()
  analyticsRefreshCacheGeneration.reset()
  analyticsRefreshConsecutiveFailures.reset()
  analyticsSchedulerSkipsTotal.reset()
}
