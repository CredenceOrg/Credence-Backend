import { Router, Request, Response } from 'express'
import { WebhookService } from '../../services/webhooks/service.js'
import { PostgresWebhookRepository } from '../../db/repositories/webhookRepository.js'
import { pool } from '../../db/pool.js'
import { AuthenticatedRequest, requireUserAuth, requireAdminRole } from '../../middleware/auth.js'
import { auditLogService } from '../../services/audit/index.js'

/**
 * Create the webhook admin router.
 * Provides endpoints for rotating and revoking signing secrets with auditing.
 */
export function createWebhookAdminRouter(): Router {
  const router = Router()
  const store = new PostgresWebhookRepository(pool)
  const webhookService = new WebhookService(store, auditLogService)

  /**
   * POST /api/admin/webhooks/:id/rotate
   * 
   * Rotates the signing secret for a webhook.
   * Moves current secret to previousSecret and generates a new one.
   */
  router.post('/:id/rotate', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const admin = (req as AuthenticatedRequest).user!
      
      const webhook = await webhookService.rotateSecret(id, { id: admin.id, email: admin.email })
      
      res.json({
        success: true,
        data: {
          id: webhook.id,
          secret: webhook.secret,
          secretUpdatedAt: webhook.secretUpdatedAt
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(400).json({ error: message })
    }
  })

  /**
   * POST /api/admin/webhooks/:id/revoke-previous
   * 
   * Revokes the previous signing secret for a webhook.
   * Stops sending dual signatures.
   */
  router.post('/:id/revoke-previous', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const admin = (req as AuthenticatedRequest).user!

      await webhookService.revokePreviousSecret(id, { id: admin.id, email: admin.email })
      
      res.json({
        success: true,
        message: 'Previous secret revoked successfully'
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(400).json({ error: message })
    }
  })

  return router
}
