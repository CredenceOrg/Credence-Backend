import { Router, Request, Response } from 'express'
import { AuthenticatedRequest, requireUserAuth, requireAdminRole } from '../middleware/auth.js'
import { WebhookRotationService, WebhookNotFoundError } from '../services/webhooks/rotationService.js'
import type { WebhookStore } from '../services/webhooks/types.js'
import type { AuditLogService } from '../services/audit/index.js'
import { getTenantId, setTenantId } from '../utils/tenantContext.js'

/**
 * Create the webhook management router.
 *
 * Injecting store and audit allows tests to supply in-memory doubles
 * without touching module-level singletons.
 */
export function createWebhookRouter(store: WebhookStore, audit: AuditLogService): Router {
  const router = Router()
  const rotationService = new WebhookRotationService(store, audit)

  /**
   * POST /api/webhooks/:webhookId/rotate-secret
   *
   * Rotate the HMAC signing secret for a webhook.
   *
   * Safe-rollout: the previous secret remains valid for 24 h so that
   * consumers can migrate without dropping events.
   *
   * The new secret is returned exactly once in this response and is never
   * stored in plain text. Store it securely immediately.
   *
   * @requires Admin role
   *
   * @param webhookId - ID of the webhook whose secret should be rotated
   *
   * @returns {object} Rotation result
   * @returns {string} .webhookId
   * @returns {string} .newSecret        — plain-text secret, shown once only
   * @returns {string} .rotatedAt        — ISO timestamp of rotation
   * @returns {string} .previousSecretExpiresAt — ISO timestamp when old secret expires
   */
  router.post(
    '/:webhookId/rotate-secret',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response): Promise<void> => {
      // Set tenant context from request header
      const tenantId = req.headers['x-tenant-id'] as string || 'default-tenant'
      const originalTenant = getTenantId()
      if (!originalTenant) {
        setTenantId(tenantId)
      }

      try {
        const { webhookId } = req.params
        const authReq = req as AuthenticatedRequest
        const actor = authReq.user!
        const ipAddress = req.ip ?? req.socket.remoteAddress

        const result = await rotationService.rotateSecret(
          webhookId,
          actor.id,
          actor.email,
          ipAddress,
        )

        res.status(200).json({
          success: true,
          data: result,
        })
      } catch (err) {
        if (err instanceof WebhookNotFoundError) {
          res.status(404).json({
            error: 'NotFound',
            message: err.message,
          })
          return
        }

        const message = err instanceof Error ? err.message : 'Unknown error'
        res.status(500).json({
          error: 'InternalError',
          message,
        })
      } finally {
        // Restore original tenant context
        if (!originalTenant) {
          setTenantId(null)
        }
      }
    },
  )

  return router
}