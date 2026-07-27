import type {
  DependencyHealth,
  DependencyReason,
  DegradationSummary,
  HealthProbe,
} from './types.js'
import { getVersionMetadata } from '../../utils/version.js'

const SERVICE_NAME = 'credence-backend'

/**
 * Runs all health probes in parallel and computes overall status + degradation summary.
 *
 * Returns `"unhealthy"` when any dependency or background worker is down.
 * Returns `"degraded"` when one or more checks are `not_configured`.
 * Otherwise returns `"ok"`.
 *
 * When the result is not `"ok"`, a `degradation` block is attached that
 * aggregates the per-dependency reasons so operators can read
 * "why are we degraded" without scanning every dependency.
 *
 * Each dependency result includes `latencyMs` when the probe ran.
 */
export async function runHealthChecks(probes: {
  postgres?: HealthProbe
  redis?: HealthProbe
  horizonListener?: HealthProbe
  outboxPublisher?: HealthProbe
  horizon?: HealthProbe
  keyManager?: HealthProbe
  kek?: HealthProbe
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
    keyManager: DependencyHealth
    kek: DependencyHealth
  }
  degradation?: DegradationSummary
}> {
  const probeOrNotConfigured = (p?: HealthProbe): Promise<DependencyHealth> =>
    p ? p() : Promise.resolve({ status: 'not_configured' as const })

  const [postgres, redis, horizonListener, outboxPublisher, horizon, keyManager, kek] =
    await Promise.all([
      probeOrNotConfigured(probes.postgres),
      probeOrNotConfigured(probes.redis),
      probeOrNotConfigured(probes.horizonListener),
      probeOrNotConfigured(probes.outboxPublisher),
      probeOrNotConfigured(probes.horizon),
      probeOrNotConfigured(probes.keyManager),
      probeOrNotConfigured(probes.kek),
    ])

  const deps = { postgres, redis, horizonListener, outboxPublisher, horizon, keyManager, kek }

  const criticalDown = Object.values(deps).some((d) => d.status === 'down')
  const anyNotConfigured = Object.values(deps).some((d) => d.status === 'not_configured')

  let status: 'ok' | 'degraded' | 'unhealthy'
  if (criticalDown) {
    status = 'unhealthy'
  } else if (anyNotConfigured) {
    status = 'degraded'
  } else {
    status = 'ok'
  }

  const result: {
    status: 'ok' | 'degraded' | 'unhealthy'
    service: string
    version: ReturnType<typeof getVersionMetadata>
    dependencies: typeof deps
    degradation?: DegradationSummary
  } = {
    status,
    service: SERVICE_NAME,
    version: getVersionMetadata(),
    dependencies: deps,
  }

  if (status !== 'ok') {
    result.degradation = buildDegradationSummary(deps)
  }

  return result
}

/**
 * Aggregates per-dependency failure reasons into a stable, machine-readable
 * summary.  Exposed for the `/api/health/degraded` endpoint and embedded in
 * the main `/api/health` response when status is not `"ok"`.
 */
export function buildDegradationSummary(deps: Record<string, DependencyHealth>): DegradationSummary {
  const reasons: DegradationSummary['reasons'] = []
  const criticalDown: string[] = []
  const notConfigured: string[] = []

  for (const [dep, health] of Object.entries(deps)) {
    if (health.status === 'down') {
      criticalDown.push(dep)
      reasons.push({ dep, reason: health.reason ?? 'error' })
    } else if (health.status === 'not_configured') {
      notConfigured.push(dep)
      reasons.push({ dep, reason: 'not_configured' })
    }
  }

  // Sort for stable output (helps snapshot tests and operator diffs).
  criticalDown.sort()
  notConfigured.sort()
  reasons.sort((a, b) => a.dep.localeCompare(b.dep))

  return { reasons, criticalDown, notConfigured }
}