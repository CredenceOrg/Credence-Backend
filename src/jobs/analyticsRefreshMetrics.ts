import client from 'prom-client'
import { register } from '../middleware/metrics.js'

export const analyticsRefreshRunsTotal = new client.Counter({
  name: 'analytics_refresh_runs_total',
  help: 'Total number of analytics materialized view refresh attempts',
  labelNames: ['status'] as const,
  registers: [register],
})

export const analyticsRefreshDurationSeconds = new client.Histogram({
  name: 'analytics_refresh_duration_seconds',
  help: 'Duration of analytics materialized view REFRESH CONCURRENTLY in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
})

export const analyticsViewAgeSeconds = new client.Gauge({
  name: 'analytics_view_age_seconds',
  help: 'Age of the analytics_metrics_mv snapshot in seconds at the time of the last successful refresh',
  registers: [register],
})

export const analyticsSchedulerSkipsTotal = new client.Counter({
  name: 'analytics_scheduler_skips_total',
  help: 'Total number of scheduler ticks skipped due to overlap or distributed lock contention',
  labelNames: ['reason'] as const,
  registers: [register],
})

export interface AnalyticsRefreshMetrics {
  incRuns(status: 'success' | 'error'): void
  observeDuration(seconds: number): void
  setViewAge(seconds: number): void
  incSkip(reason: 'overlap' | 'lock_contention'): void
}

export function createAnalyticsRefreshMetrics(): AnalyticsRefreshMetrics {
  return {
    incRuns: (status) => analyticsRefreshRunsTotal.inc({ status }),
    observeDuration: (seconds) => analyticsRefreshDurationSeconds.observe(seconds),
    setViewAge: (seconds) => analyticsViewAgeSeconds.set(seconds),
    incSkip: (reason) => analyticsSchedulerSkipsTotal.inc({ reason }),
  }
}
