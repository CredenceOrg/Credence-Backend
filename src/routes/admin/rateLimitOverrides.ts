import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  AuthenticatedRequest,
  requireUserAuth,
  requireAdminRole,
} from '../../middleware/auth.js'
import { RateLimitOverrideService } from '../../services/rateLimitOverride/service.js'
import type { ActorInfo } from '../../services/rateLimitOverride/service.js'
import {
  setRateLimitOverrideBodySchema,
  removeRateLimitOverrideBodySchema,
} from '../../schemas/rateLimitOverride.js'
import { validate } from '../../middleware/validate.js'

export function createRateLimitOverridesAdminRouter(
  service: RateLimitOverrideService = new RateLimitOverrideService(),
): Router {
  const router = Router()

  const resolveActor = (req: Request): ActorInfo => {
    const authReq = req as AuthenticatedRequest
    const user = authReq.user!
    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      ipAddress: req.ip,
      requestId: (req as any).requestId,
    }
  }

  /**
   * GET /api/admin/rate-limits/overrides
   * List all per-tenant rate-limit overrides
   */
  router.get(
    '/',
    requireUserAuth,
    requireAdminRole,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const overrides = await service.listOverrides()
        res.json({ success: true, data: overrides })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * POST /api/admin/rate-limits/overrides
   * Set or update a per-tenant rate-limit override.
   * Mandates an audit log entry containing actor, tenant, old/new value, reason, and timestamp.
   */
  router.post(
    '/',
    requireUserAuth,
    requireAdminRole,
    validate({ body: setRateLimitOverrideBodySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, rateLimit, windowSize, reason } = req.body
        const override = await service.setOverride(
          tenantId,
          rateLimit,
          windowSize,
          reason,
          resolveActor(req),
        )
        res.status(201).json({ success: true, data: override })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * DELETE /api/admin/rate-limits/overrides/:tenantId
   * Remove a per-tenant rate-limit override.
   * Mandates an audit log entry containing actor, tenant, old value, reason, and timestamp.
   */
  router.delete(
    '/:tenantId',
    requireUserAuth,
    requireAdminRole,
    validate({ body: removeRateLimitOverrideBodySchema }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = req.params
        const { reason } = req.body
        await service.removeOverride(tenantId, reason, resolveActor(req))
        res.json({ success: true })
      } catch (err) {
        next(err)
      }
    },
  )

  return router
}

export default createRateLimitOverridesAdminRouter
