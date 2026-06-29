import { Router, type Request, type Response } from 'express'
import { runHealthChecks } from '../services/health/index.js'
import type { HealthProbe } from '../services/health/index.js'
import type { AnalyticsService } from '../services/analytics/service.js'
import type { DashboardSnapshot } from '../schemas/snapshot.js'

export interface SnapshotRouterOptions {
  healthProbes?: {
    postgres?: HealthProbe
    redis?: HealthProbe
    horizonListener?: HealthProbe
    outboxPublisher?: HealthProbe
    horizon?: HealthProbe
  }
  analyticsService?: AnalyticsService
}

export function createSnapshotRouter(options: SnapshotRouterOptions = {}): Router {
  const router = Router()

  /**
   * GET /api/snapshot
   *
   * Returns a pre-computed dashboard payload in a single round-trip.
   * Combines health status and latest analytics metrics so dashboards
   * avoid multiple parallel fan-out requests.
   *
   * Always returns 200; individual sections may be null when unavailable.
   */
  router.get('/', async (_req: Request, res: Response) => {
    const [healthResult, analyticsResult] = await Promise.allSettled([
      runHealthChecks(options.healthProbes ?? {}),
      options.analyticsService ? options.analyticsService.getSummary() : Promise.resolve(null),
    ])

    const health =
      healthResult.status === 'fulfilled'
        ? { status: healthResult.value.status }
        : { status: 'unhealthy' as const }

    const analyticsValue =
      analyticsResult.status === 'fulfilled' ? analyticsResult.value : null

    const analytics = analyticsValue
      ? {
          activeIdentities: analyticsValue.metrics.activeIdentities,
          totalIdentities: analyticsValue.metrics.totalIdentities,
          avgTotalScore: analyticsValue.metrics.avgTotalScore,
          fresh: analyticsValue.staleness.fresh,
        }
      : null

    const snapshot: DashboardSnapshot = {
      generatedAt: new Date().toISOString(),
      health,
      analytics,
    }

    res.status(200).json(snapshot)
  })

  return router
}
