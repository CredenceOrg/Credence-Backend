import { Router, type Request, type Response } from 'express'
import {
  AuthenticatedRequest,
  requireUserAuth,
  requireAdminRole,
} from '../../middleware/auth.js'
import { FeatureFlagService } from '../../services/featureFlags/index.js'
import type { ActorInfo } from '../../services/featureFlags/index.js'

export function createFeatureFlagAdminRouter(
  service: FeatureFlagService = new FeatureFlagService(),
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
    }
  }

  router.get(
    '/',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      try {
        const authReq = req as AuthenticatedRequest
        const tenantId = authReq.user!.tenantId
        const flags = await service.listFlagsWithOverrides(tenantId)
        res.json({ success: true, data: flags })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        res.status(400).json({ error: message })
      }
    },
  )

  router.post(
    '/',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      try {
        const { key, description, defaultEnabled, rolloutPercent } = req.body as {
          key: string
          description?: string
          defaultEnabled?: boolean
          rolloutPercent?: number
        }
        if (!key || typeof key !== 'string') {
          res.status(400).json({ error: 'key is required and must be a string' })
          return
        }
        const flag = await service.createFlag(
          key,
          description ?? '',
          defaultEnabled ?? false,
          rolloutPercent ?? 0,
          resolveActor(req),
        )
        res.status(201).json({ success: true, data: flag })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        res.status(400).json({ error: message })
      }
    },
  )

  router.put(
    '/:key',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      try {
        const { key } = req.params
        const { description, defaultEnabled, rolloutPercent } = req.body as {
          description?: string
          defaultEnabled?: boolean
          rolloutPercent?: number
        }
        const flag = await service.updateFlag(
          key,
          { description, defaultEnabled, rolloutPercent },
          resolveActor(req),
        )
        res.json({ success: true, data: flag })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        const status = message.includes('not found') ? 404 : 400
        res.status(status).json({ error: message })
      }
    },
  )

  router.post(
    '/:key/overrides',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      try {
        const { key } = req.params
        const { tenantId, enabled } = req.body as { tenantId: string; enabled: boolean }
        if (!tenantId || typeof enabled !== 'boolean') {
          res.status(400).json({ error: 'tenantId and enabled are required' })
          return
        }
        const override = await service.setOverride(key, tenantId, enabled, resolveActor(req))
        res.status(201).json({ success: true, data: override })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        const status = message.includes('not found') ? 404 : 400
        res.status(status).json({ error: message })
      }
    },
  )

  router.delete(
    '/:key/overrides/:tenantId',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      try {
        const { key, tenantId } = req.params
        await service.removeOverride(key, tenantId, resolveActor(req))
        res.json({ success: true })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        const status = message.includes('not found') ? 404 : 400
        res.status(status).json({ error: message })
      }
    },
  )

  return router
}
