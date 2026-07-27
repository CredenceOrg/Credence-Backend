import type { VersionMetadata } from '../../utils/version.js'

/**
 * Health check result for a single dependency.
 * Status is intentionally minimal to avoid exposing internal details.
 */
export type DependencyStatus = 'up' | 'down' | 'not_configured'

/**
 * Stable, machine-readable reason codes for non-`'up'` dependency states.
 *
 * Adding a new reason requires:
 *   1. adding the literal to this union,
 *   2. updating every probe that can produce it,
 *   3. updating tests that assert against the literal.
 *
 * Existing literals MUST NOT be renamed — they form part of the
 * `/api/health` JSON contract and are scraped by operators / monitors.
 */
export type DependencyReason =
  | 'timeout'
  | 'connection_refused'
  | 'not_running'
  | 'no_heartbeat'
  | 'stale_heartbeat'
  | 'circuit_open'
  | 'unreachable'
  | 'not_initialized'
  | 'lag_exceeded'
  | 'error'

export interface DependencyHealth {
  status: DependencyStatus
  /** Human-readable reason for non-'up' status. Omitted when status is 'up'. */
  reason?: DependencyReason
  /** Wall-clock milliseconds the check took. Always present when a probe ran. */
  latencyMs?: number
  /** Outbox-specific lag measured in seconds. */
  lagSeconds?: number
  /** Optional safe metadata for debugging readiness (no secrets). */
  details?: Record<string, string | number | boolean | null>
}

/**
 * Summary of *why* the service is not in `'ok'` state.
 * Surfaced on `/api/health` and on `/api/health/degraded`.
 */
export interface DegradationSummary {
  /** Per-dependency `{ dep, reason }` for every entry that is `down` or `not_configured`. */
  reasons: Array<{ dep: string; reason: DependencyReason | 'not_configured' }>
  /** Dependencies whose status is `'down'`. */
  criticalDown: string[]
  /** Dependencies whose status is `'not_configured'`. */
  notConfigured: string[]
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
    keyManager: DependencyHealth
    kek: DependencyHealth
  }
  /**
   * Present only when `status !== 'ok'`. Aggregates the degradation
   * reasons across all dependencies so operators can read
   * "why are we degraded" without scanning every dependency.
   */
  degradation?: DegradationSummary
}

/** Injectable probe: returns dependency status without exposing internals. */
export type HealthProbe = () => Promise<DependencyHealth>