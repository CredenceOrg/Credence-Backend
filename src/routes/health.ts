import { Router, type Request, type Response } from 'express'
import { runHealthChecks } from '../services/health/index.js'
import type { HealthProbe } from '../services/health/index.js'

export interface HealthRouterOptions {
  /** DB probe; when omitted, db is reported as not_configured. */
  db?: HealthProbe
  /** Backward-compatible postgres probe alias. */
  postgres?: HealthProbe
  /** Cache probe; when omitted, cache is reported as not_configured. */
  cache?: HealthProbe
  /** Backward-compatible redis probe alias. */
  redis?: HealthProbe
  /** Queue probe; when omitted, queue is reported as not_configured. */
  queue?: HealthProbe
  /** Optional gateway (e.g. Horizon); failure does not cause 503. */
  gateway?: HealthProbe
  /** Backward-compatible Horizon listener probe alias. */
  horizonListener?: HealthProbe
  /** Backward-compatible outbox publisher probe alias. */
  outboxPublisher?: HealthProbe
  /**
   * Horizon/Soroban client reachability probe (circuit breaker state).
   * When OPEN the pod is marked unready (503).
   */
  horizon?: HealthProbe
  /** Optional readiness check to mark the service unhealthy during shutdown. */
  isReady?: () => boolean
}

/**
 * Builds the health check router.
 * Supports readiness (with dependency status) and liveness (process up).
 *
 * - GET /api/health     -> full status; 503 if any critical dependency is down
 * - GET /api/health/ready -> same as /api/health (readiness)
 * - GET /api/health/live  -> 200 always when process is running (liveness)
 *
 * Response body does not expose internal details (no error messages or connection info).
 * Each dependency result includes latencyMs indicating how long the probe took.
 */
export function createHealthRouter(options: HealthRouterOptions = {}): Router {
  const router = Router()

  const runChecks = async () =>
    runHealthChecks({
      postgres: options.postgres ?? options.db,
      redis: options.redis ?? options.cache,
      horizonListener: options.horizonListener ?? options.gateway,
      outboxPublisher: options.outboxPublisher ?? options.queue,
      horizon: options.horizon,
    })

  /**
   * Readiness + full health: per-dependency status; 503 if critical down.
   */
  router.get('/', async (_req: Request, res: Response) => {
    const result = await runChecks()
    if (options.isReady && !options.isReady()) {
      result.status = 'unhealthy'
    }
    const code = result.status === 'unhealthy' ? 503 : 200
    res.status(code).json(result)
  })

  /** Alias for readiness (same as GET /). */
  router.get('/ready', async (_req: Request, res: Response) => {
    const result = await runChecks()
    if (options.isReady && !options.isReady()) {
      result.status = 'unhealthy'
    }
    const code = result.status === 'unhealthy' ? 503 : 200
    res.status(code).json(result)
  })

  /**
   * Liveness: process is running. No dependency checks; always 200.
   */
  router.get('/live', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'credence-backend',
    })
  })

  return router
}
