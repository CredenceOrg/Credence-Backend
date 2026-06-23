import client from 'prom-client'
import { register } from '../middleware/metrics.js'

export const shutdownPhaseDurationSeconds = new client.Histogram({
  name: 'shutdown_phase_duration_seconds',
  help: 'Duration of each graceful shutdown phase in seconds',
  labelNames: ['phase'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
})

export const shutdownTotal = new client.Counter({
  name: 'shutdown_total',
  help: 'Total graceful shutdowns initiated, labelled by signal',
  labelNames: ['signal'] as const,
  registers: [register],
})

export const shutdownForceExitTotal = new client.Counter({
  name: 'shutdown_force_exit_total',
  help: 'Total times the shutdown coordinator had to force-exit after the grace period expired',
  registers: [register],
})

export interface ShutdownMetrics {
  observePhase(phase: string, durationSeconds: number): void
  incShutdown(signal: string): void
  incForceExit(): void
}

export function createShutdownMetrics(): ShutdownMetrics {
  return {
    observePhase: (phase, s) => shutdownPhaseDurationSeconds.observe({ phase }, s),
    incShutdown: (signal) => shutdownTotal.inc({ signal }),
    incForceExit: () => shutdownForceExitTotal.inc(),
  }
}

export function createNoopShutdownMetrics(): ShutdownMetrics {
  return {
    observePhase: () => {},
    incShutdown: () => {},
    incForceExit: () => {},
  }
}
