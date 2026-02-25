/**
 * Health check result for a single dependency.
 * Status is intentionally minimal to avoid exposing internal details.
 */
export type DependencyStatus = 'up' | 'down' | 'not_configured'

export interface DependencyHealth {
  status: DependencyStatus
}

export interface HealthResult {
  status: 'ok' | 'degraded' | 'unhealthy'
  service: string
  dependencies: {
    db: DependencyHealth
    redis: DependencyHealth
    /** Optional external (e.g. Horizon); never affects overall unhealthy. */
    external?: DependencyHealth
  }
}

/** Injectable probe: returns dependency status without exposing internals. */
export type HealthProbe = () => Promise<DependencyHealth>
