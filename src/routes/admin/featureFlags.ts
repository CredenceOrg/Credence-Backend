import { Router, type Request, type Response } from 'express'
import {
  AuthenticatedRequest,
  requireUserAuth,
  requireAdminRole,
} from '../../middleware/auth.js'
import { FeatureFlagService } from '../../services/featureFlags/index.js'
import type { ActorInfo } from '../../services/featureFlags/index.js'
import {
  createFlagBodySchema,
  updateFlagBodySchema,
  setOverrideBodySchema,
  setTenantRolloutBodySchema,
} from '../../schemas/featureFlags.js'

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

  // ── List all flags for the caller's tenant ──────────────────────────────────

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

  // ── Create a new feature flag ───────────────────────────────────────────────

  router.post(
    '/',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      const parsed = createFlagBodySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Validation error', details: parsed.error.issues })
        return
      }

      try {
        const { key, description, defaultEnabled, rolloutPercent } = parsed.data
        const flag = await service.createFlag(
          key,
          description,
          defaultEnabled,
          rolloutPercent,
          resolveActor(req),
        )
        res.status(201).json({ success: true, data: flag })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        res.status(400).json({ error: message })
      }
    },
  )

  // ── Update an existing flag ─────────────────────────────────────────────────

  router.put(
    '/:key',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      const parsed = updateFlagBodySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Validation error', details: parsed.error.issues })
        return
      }

      try {
        const { key } = req.params
        const flag = await service.updateFlag(key, parsed.data, resolveActor(req))
        res.json({ success: true, data: flag })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        const status = message.includes('not found') ? 404 : 400
        res.status(status).json({ error: message })
      }
    },
  )

  // ── Boolean per-tenant override (upsert) ───────────────────────────────────

  router.post(
    '/:key/overrides',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      const parsed = setOverrideBodySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Validation error', details: parsed.error.issues })
        return
      }

      try {
        const { key } = req.params
        const { tenantId, enabled } = parsed.data
        const override = await service.setOverride(key, tenantId, enabled, resolveActor(req))
        res.status(201).json({ success: true, data: override })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        const status = message.includes('not found') ? 404 : 400
        res.status(status).json({ error: message })
      }
    },
  )

  // ── Remove boolean per-tenant override ─────────────────────────────────────

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

  // ── Per-tenant rollout percentage (upsert) ─────────────────────────────────
  //
  // POST /api/admin/feature-flags/:key/tenant-rollouts
  //
  // Sets (or updates) the rollout percentage for a specific tenant.  Sticky
  // user-id bucketing still applies within the tenant's percent window, so
  // the same user always gets the same result for the same flag.

  router.post(
    '/:key/tenant-rollouts',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      const parsed = setTenantRolloutBodySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Validation error', details: parsed.error.issues })
        return
      }

      try {
        const { key } = req.params
        const { tenantId, rolloutPercent } = parsed.data
        const tenantRollout = await service.setTenantRollout(
          key,
          tenantId,
          rolloutPercent,
          resolveActor(req),
        )
        res.status(201).json({ success: true, data: tenantRollout })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        const status = message.includes('not found') ? 404 : 400
        res.status(status).json({ error: message })
      }
    },
  )

  // ── Remove per-tenant rollout percentage ────────────────────────────────────

  router.delete(
    '/:key/tenant-rollouts/:tenantId',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response) => {
      try {
        const { key, tenantId } = req.params
        await service.removeTenantRollout(key, tenantId, resolveActor(req))
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
