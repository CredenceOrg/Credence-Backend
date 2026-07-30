import { Router, Request, Response } from 'express'
import { WebhookService } from '../../services/webhooks/service.js'
import { PostgresWebhookRepository } from '../../db/repositories/webhookRepository.js'
import { pool } from '../../db/pool.js'
import { AuthenticatedRequest, requireUserAuth, requireAdminRole, requireApiKey, ApiScope, UserRole } from '../../middleware/auth.js'
import { auditLogService, AuditAction } from '../../services/audit/index.js'
import { sendError, ErrorCode } from '../../lib/errors.js'

/**
 * Create the webhook admin router.
 * Provides endpoints for rotating and revoking signing secrets with auditing.
 *
 * All routes require EITHER:
 *   - A user session with admin role (requireUserAuth + requireAdminRole), OR
 *   - An API key with the webhooks:admin scope (requireApiKey(ApiScope.WEBHOOKS_ADMIN))
 */
export function createWebhookAdminRouter(): Router {
  const router = Router()
  const store = new PostgresWebhookRepository(pool)
  const webhookService = new WebhookService(store, undefined, undefined, auditLogService)

  /**
   * POST /api/admin/webhooks/:id/rotate
   * 
   * Rotates the signing secret for a webhook.
   * Moves current secret to previousSecret and generates a new one.
   *
   * @requires webhooks:admin scope OR admin role
   */
  router.post('/:id/rotate', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const admin = (req as AuthenticatedRequest).user!
      const requestId = (req as any).requestId
      
      if (admin.role !== UserRole.ADMIN && admin.role !== UserRole.SUPER_ADMIN && (admin.role as string) !== 'super-admin') {
        void auditLogService.logAction(
          admin.tenantId || 'default-tenant',
          admin.id,
          admin.email,
          AuditAction.ROTATE_WEBHOOK_SECRET,
          id,
          'webhook',
          { id, reason: 'insufficient_permissions' },
          'failure',
          'Admin role required',
          req.ip,
          requestId
        )
        sendError(res, ErrorCode.FORBIDDEN, 'Admin role required')
        return
      }

      const webhook = await webhookService.rotateSecret(id, { id: admin.id, email: admin.email, tenantId: admin.tenantId }, requestId)
      
      res.json({
        success: true,
        data: {
          id: webhook.id,
          secret: webhook.secret,
          secretUpdatedAt: webhook.secretUpdatedAt
        }
      })
    } catch (err) {
      sendError(res, ErrorCode.VALIDATION_FAILED, err instanceof Error ? err.message : 'Unknown error')
    }
  })

  /**
   * POST /api/admin/webhooks/:id/revoke-previous
   * 
   * Revokes the previous signing secret for a webhook.
   * Stops sending dual signatures.
   *
   * @requires webhooks:admin scope OR admin role
   */
  router.post('/:id/revoke-previous', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const admin = (req as AuthenticatedRequest).user!
      const requestId = (req as any).requestId

      await webhookService.revokePreviousSecret(id, { id: admin.id, email: admin.email, tenantId: admin.tenantId }, requestId)
      
      res.json({
        success: true,
        message: 'Previous secret revoked successfully'
      })
    } catch (err) {
      sendError(res, ErrorCode.VALIDATION_FAILED, err instanceof Error ? err.message : 'Unknown error')
    }
  })

  return router
}
