import type {
  DependencyHealth,
  DependencyReason,
  DegradationSummary,
  HealthProbe,
} from './types.js'
import { getVersionMetadata } from '../../utils/version.js'

const SERVICE_NAME = 'credence-backend'

/**
 * Dependencies that must be reachable before the service declares itself ready.
 *
 * When any of these is `not_configured` the readiness result is `"unhealthy"`
 * rather than `"degraded"` — the probe fails *closed*.  Optional/ancillary
 * dependencies (e.g. horizon, kek) still fall through to `"degraded"` when
 * absent so that deployments that don't use those features aren't penalised.
 */
export const CRITICAL_DEPS = new Set(['postgres', 'redis', 'horizonListener'] as const)

/**
 * Runs all health probes in parallel and computes overall status + degradation summary.
 *
 * Returns `"unhealthy"` when:
 *   - any dependency is `down`, OR
 *   - a critical dependency (postgres, redis, horizonListener) is `not_configured`
 *     (fail-closed: missing config is treated as an outage).
 * Returns `"degraded"` when one or more non-critical checks are `not_configured`.
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

  // A dep is "effectively down" when it is either explicitly down *or* when it
  // is a critical dependency that was never configured (fail-closed behaviour).
  const isCritical = (name: string): boolean => CRITICAL_DEPS.has(name as Parameters<typeof CRITICAL_DEPS.has>[0])
  const anyDown = Object.values(deps).some((d) => d.status === 'down')
  const criticalNotConfigured = (Object.entries(deps) as [string, DependencyHealth][])
    .some(([name, d]) => d.status === 'not_configured' && isCritical(name))
  const anyNotConfigured = Object.values(deps).some((d) => d.status === 'not_configured')

  let status: 'ok' | 'degraded' | 'unhealthy'
  if (anyDown || criticalNotConfigured) {
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
 *
 * Critical dependencies (postgres, redis, horizonListener) that are
 * `not_configured` are listed in both `criticalDown` and `notConfigured`
 * so that operators can distinguish "misconfigured critical dep" from
 * "optional dep not enabled".
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
      // Critical deps that are not_configured are also surfaced in criticalDown
      // so monitoring rules checking criticalDown still fire.
      if (CRITICAL_DEPS.has(dep as Parameters<typeof CRITICAL_DEPS.has>[0])) {
        criticalDown.push(dep)
      }
      reasons.push({ dep, reason: 'not_configured' })
    }
  }

  // Sort for stable output (helps snapshot tests and operator diffs).
  criticalDown.sort()
  notConfigured.sort()
  reasons.sort((a, b) => a.dep.localeCompare(b.dep))

  return { reasons, criticalDown, notConfigured }
}