import type { DependencyHealth, HealthProbe } from './types.js'
import { getVersionMetadata } from '../../utils/version.js'

const SERVICE_NAME = 'credence-backend'

/**
 * Runs all health probes and computes overall status.
 * Returns "unhealthy" when any critical dependency or background worker is down.
 * Returns "degraded" when one or more checks are not configured.
 * Each dependency result includes latencyMs when the probe ran.
 *
 * @param probes - Object with optional probes for postgres, redis, horizon listener, outbox publisher, and horizon client
 * @returns Aggregated health result (no internal details exposed)
 */
export async function runHealthChecks(probes: {
  postgres?: HealthProbe
  redis?: HealthProbe
  horizonListener?: HealthProbe
  outboxPublisher?: HealthProbe
  horizon?: HealthProbe
}): Promise<{
  status: 'ok' | 'degraded' | 'unhealthy'
  service: string
  version: ReturnType<typeof getVersionMetadata>
  dependencies: {
    postgres: DependencyHealth
    redis: DependencyHealth
    horizonListener: DependencyHealth
    outboxPublisher: DependencyHealth
    horizon: DependencyHealth
  }
}> {
  const [postgres, redis, horizonListener, outboxPublisher, horizon] = await Promise.all([
    probes.postgres ? probes.postgres() : Promise.resolve({ status: 'not_configured' as const }),
    probes.redis ? probes.redis() : Promise.resolve({ status: 'not_configured' as const }),
    probes.horizonListener
      ? probes.horizonListener()
      : Promise.resolve({ status: 'not_configured' as const }),
    probes.outboxPublisher
      ? probes.outboxPublisher()
      : Promise.resolve({ status: 'not_configured' as const }),
    probes.horizon
      ? probes.horizon()
      : Promise.resolve({ status: 'not_configured' as const }),
  ])

  const deps = { postgres, redis, horizonListener, outboxPublisher, horizon }

  const criticalDown = Object.values(deps).some(d => d.status === 'down')
  const anyNotConfigured = Object.values(deps).some(d => d.status === 'not_configured')

  let status: 'ok' | 'degraded' | 'unhealthy'
  if (criticalDown) {
    status = 'unhealthy'
  } else if (anyNotConfigured) {
    status = 'degraded'
  } else {
    status = 'ok'
  }

  return { status, service: SERVICE_NAME, version: getVersionMetadata(), dependencies: deps }
}
