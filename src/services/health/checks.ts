import type { DependencyHealth, HealthProbe } from './types.js'

const SERVICE_NAME = 'credence-backend'

/**
 * Runs all health probes and computes overall status.
 * Returns 503-level "unhealthy" only when a critical dependency (db or redis) is down.
 * Optional external dependency does not cause unhealthy.
 *
 * @param probes - Object with optional probes for db, redis, and optional external
 * @returns Aggregated health result (no internal details exposed)
 */
export async function runHealthChecks(probes: {
  db?: HealthProbe
  redis?: HealthProbe
  external?: HealthProbe
}): Promise<{
  status: 'ok' | 'degraded' | 'unhealthy'
  service: string
  dependencies: {
    db: DependencyHealth
    redis: DependencyHealth
    external?: DependencyHealth
  }
}> {
  const [db, redis, external] = await Promise.all([
    probes.db ? probes.db() : Promise.resolve({ status: 'not_configured' as const }),
    probes.redis ? probes.redis() : Promise.resolve({ status: 'not_configured' as const }),
    probes.external ? probes.external() : Promise.resolve(undefined),
  ])

  const deps: {
    db: DependencyHealth
    redis: DependencyHealth
    external?: DependencyHealth
  } = { db, redis }
  if (external !== undefined) deps.external = external

  const criticalDown =
    (db.status === 'down') ||
    (redis.status === 'down')
  const anyCriticalConfigured =
    (db.status !== 'not_configured') ||
    (redis.status !== 'not_configured')

  let status: 'ok' | 'degraded' | 'unhealthy'
  if (criticalDown && anyCriticalConfigured) {
    status = 'unhealthy'
  } else if (external?.status === 'down') {
    status = 'degraded'
  } else {
    status = 'ok'
  }

  return { status, service: SERVICE_NAME, dependencies: deps }
}
