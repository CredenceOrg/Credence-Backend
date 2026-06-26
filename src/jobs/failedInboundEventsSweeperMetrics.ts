import client from 'prom-client'
import { register } from '../middleware/metrics.js'

export const failedInboundSweeperRunsTotal = new client.Counter({
  name: 'failed_inbound_sweeper_runs_total',
  help: 'Total number of failed inbound events sweeper runs',
  registers: [register],
})

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

export const failedInboundRetainedTotal = new client.Counter({
  name: 'failed_inbound_retained_total',
  help: 'Total number of failed inbound events retained (not yet expired)',
  registers: [register],
})

export function createFailedInboundSweeperMetrics() {
  return {
    incRuns: () => failedInboundSweeperRunsTotal.inc(),
    observeDuration: (seconds: number) => failedInboundSweeperDurationSeconds.observe(seconds),
    incSwept: (count: number) => failedInboundSweptTotal.inc(count),
    setRetained: (count: number) => failedInboundRetainedTotal.inc(count),
  }
}

export type FailedInboundSweeperMetrics = ReturnType<typeof createFailedInboundSweeperMetrics>
