import type { DependencyHealth, HealthProbe } from './types.js'

const SERVICE_NAME = 'credence-backend'

/**
 * Runs all health probes and computes overall status.
 * Returns 503-level "unhealthy" only when a critical dependency (db, cache, queue) is down.
 * Optional gateway dependency does not cause unhealthy, but degraded.
 *
 * @param probes - Object with optional probes for db, cache, queue, and gateway
 * @returns Aggregated health result (no internal details exposed)
 */
export async function runHealthChecks(probes: {
  db?: HealthProbe
  cache?: HealthProbe
  queue?: HealthProbe
  gateway?: HealthProbe
}): Promise<{
  status: 'ok' | 'degraded' | 'unhealthy'
  service: string
  dependencies: {
    db: DependencyHealth
    cache: DependencyHealth
    queue: DependencyHealth
    gateway: DependencyHealth
  }
}> {
  const [db, cache, queue, gateway] = await Promise.all([
    probes.db ? probes.db() : Promise.resolve({ status: 'not_configured' as const }),
    probes.cache ? probes.cache() : Promise.resolve({ status: 'not_configured' as const }),
    probes.queue ? probes.queue() : Promise.resolve({ status: 'not_configured' as const }),
    probes.gateway ? probes.gateway() : Promise.resolve({ status: 'not_configured' as const }),
  ])

  const deps = { db, cache, queue, gateway }

  const criticalDown =
    (db.status === 'down') ||
    (cache.status === 'down') ||
    (queue.status === 'down')
  const anyCriticalConfigured =
    (db.status !== 'not_configured') ||
    (cache.status !== 'not_configured') ||
    (queue.status !== 'not_configured')

  let status: 'ok' | 'degraded' | 'unhealthy'
  if (criticalDown && anyCriticalConfigured) {
    status = 'unhealthy'
  } else if (gateway.status === 'down') {
    status = 'degraded'
  } else {
    status = 'ok'
  }

  return { status, service: SERVICE_NAME, dependencies: deps }
}
