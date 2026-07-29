import { Router, type Request, type Response } from 'express'
import { runHealthChecks } from '../services/health/index.js'
import type { HealthProbe } from '../services/health/index.js'
import type { RedisClient } from '../cache/redis.js'
import { WorkerHealthService } from '../services/workerHealth.js'
import { getVersionMetadata } from '../utils/version.js'
import { sendError, ErrorCode } from '../lib/errors.js'

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
  /**
   * Redis client for the worker-health endpoint.
   * When provided, a `GET /workers` route is registered that reports the
   * lease + last-heartbeat state of every known distributed-lock key.
   */
  redisClient?: RedisClient
  /** Backward-compatible Horizon listener probe alias. */
  horizonListener?: HealthProbe
  /** Backward-compatible outbox publisher probe alias. */
  outboxPublisher?: HealthProbe
  /**
   * Horizon/Soroban client reachability probe (circuit breaker state).
   * When OPEN the pod is marked unready (503).
   */
  horizon?: HealthProbe
  /**
   * JWT signing-key manager liveness probe.  When `false`, the pod is
   * marked unready (503) because it cannot sign or verify tokens.
   */
  keyManager?: HealthProbe
  /**
   * KEK (evidence envelope-encryption key) probe.  When DOWN, the pod is
   * marked unready (503) because evidence write paths cannot encrypt.
   */
  kek?: HealthProbe
  /** Optional readiness check to mark the service unhealthy during shutdown. */
  isReady?: () => boolean
}

/**
 * Builds the health check router.
 *
 * Routes:
 *  - GET /api/health             -> full status; 503 if any critical dep is down.
 *                                   When status !== 'ok', includes a `degradation`
 *                                   block that aggregates the failure reasons.
 *  - GET /api/health/ready       -> alias for readiness (same as /).
 *  - GET /api/health/dependencies-> just the dependencies object (same 503 rule).
 *  - GET /api/health/degraded    -> always 200; surfaces the structured
 *                                   degradation summary so monitors can read
 *                                   "why are we degraded" without scraping
 *                                   `/api/health` for `status !== 'ok'` and
 *                                   without falsely alerting on a 503.
 *  - GET /api/health/live        -> 200 always when process is running.
 *  - GET /api/health/workers     -> worker lease + heartbeat summary
 *                                   (only when redisClient is configured).
 *
 * **CORS policy:** Open — `GET` on all `/api/health/*` paths accepts any
 * `Origin` (orchestrator probes and monitoring dashboards). See
 * `docs/CORS_POLICY.md`.
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
      keyManager: options.keyManager,
      kek: options.kek,
    })

  /**
   * Readiness + full health: per-dependency status; 503 if critical down.
   * Includes the `degradation` block when status !== 'ok'.
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
   * Dependencies: downstream up/down states.
   */
  router.get('/dependencies', async (_req: Request, res: Response) => {
    const result = await runChecks()
    if (options.isReady && !options.isReady()) {
      result.status = 'unhealthy'
    }
    const code = result.status === 'unhealthy' ? 503 : 200
    res.status(code).json(result.dependencies)
  })

  /**
   * Degradation summary — always 200 so operators can use this endpoint
   * for dashboards without triggering false alerts from a 503.
   *
   * Body shape:
   *   {
   *     status: 'ok' | 'degraded' | 'unhealthy',
   *     degradation?: { reasons: [...], criticalDown: [...], notConfigured: [...] }
   *   }
   *
   * When status === 'ok', the `degradation` field is absent.
   */
  router.get('/degraded', async (_req: Request, res: Response) => {
    const result = await runChecks()
    const body: {
      status: 'ok' | 'degraded' | 'unhealthy'
      service: string
      version: ReturnType<typeof getVersionMetadata>
      degradation?: typeof result.degradation
    } = {
      status: result.status,
      service: result.service,
      version: result.version,
    }
    if (result.degradation) body.degradation = result.degradation
    res.status(200).json(body)
  })

  /**
   * Liveness: process is running. No dependency checks; always 200.
   */
  router.get('/live', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'credence-backend',
      version: getVersionMetadata(),
    })
  })

  /**
   * Worker health: lease + last-heartbeat summary for on-call debugging.
   * Available only when a Redis client was provided to the router.
   */
  if (options.redisClient) {
    const workerHealthService = new WorkerHealthService(options.redisClient)

    router.get('/workers', async (_req: Request, res: Response) => {
      try {
        const result = await workerHealthService.getWorkerStatuses()
        res.status(200).json(result)
      } catch {
        sendError(res, ErrorCode.SERVICE_UNAVAILABLE, 'Unable to query worker health')
      }
    })
  }

  return router
}