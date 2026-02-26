import { Router, type Request, type Response } from 'express'
import { runHealthChecks } from '../services/health/index.js'
import type { HealthProbe } from '../services/health/index.js'

export interface HealthRouterOptions {
  /** DB probe; when omitted, db is reported as not_configured. */
  db?: HealthProbe
  /** Redis probe; when omitted, redis is reported as not_configured. */
  redis?: HealthProbe
  /** Optional external (e.g. Horizon); failure does not cause 503. */
  external?: HealthProbe
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
 */
export function createHealthRouter(options: HealthRouterOptions = {}): Router {
  const router = Router()

  const runChecks = async () =>
    runHealthChecks({
      db: options.db,
      redis: options.redis,
      external: options.external,
    })

  /**
   * Readiness + full health: per-dependency status; 503 if critical down.
   */
  router.get('/', async (_req: Request, res: Response) => {
    const result = await runChecks()
    const code = result.status === 'unhealthy' ? 503 : 200
    res.status(code).json(result)
  })

  /** Alias for readiness (same as GET /). */
  router.get('/ready', async (_req: Request, res: Response) => {
    const result = await runChecks()
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
