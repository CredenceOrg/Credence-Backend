import type { VersionMetadata } from '../../utils/version.js'

/**
 * Health check result for a single dependency.
 * Status is intentionally minimal to avoid exposing internal details.
 */
export type DependencyStatus = 'up' | 'down' | 'not_configured'

export interface DependencyHealth {
  status: DependencyStatus
  /** Human-readable reason for non-'up' status. Omitted when status is 'up'. */
  reason?: string
  /** Wall-clock milliseconds the check took. Always present when a probe ran. */
  latencyMs?: number
  /** Outbox-specific lag measured in seconds. */
  lagSeconds?: number
  /** Optional safe metadata for debugging readiness (no secrets). */
  details?: Record<string, string | number | boolean | null>
}

export interface HealthResult {
  status: 'ok' | 'degraded' | 'unhealthy'
  service: string
  version: VersionMetadata
  dependencies: {
    postgres: DependencyHealth
    redis: DependencyHealth
    horizonListener: DependencyHealth
    outboxPublisher: DependencyHealth
    horizon: DependencyHealth
  }
}

/** Injectable probe: returns dependency status without exposing internals. */
export type HealthProbe = () => Promise<DependencyHealth>
