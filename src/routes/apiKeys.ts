/**
 * @module routes/apiKeys
 *
 * Integration API key management endpoints.
 *
 * Routes (all require Bearer auth):
 *   POST   /api/integrations/keys            – Issue a new key
 *   GET    /api/integrations/keys            – List keys for the authenticated user
 *   POST   /api/integrations/keys/:id/rotate – Rotate a key (safe invalidation)
 *   DELETE /api/integrations/keys/:id        – Permanently revoke a key
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { requireUserAuth, UserRole, type AuthenticatedRequest } from '../middleware/auth.js'
import { InMemoryApiKeyRepository } from '../repositories/apiKeyRepository.js'
import { ApiKeyRotationService } from '../services/apiKeyRotationService.js'
import { auditLogService } from '../services/audit/index.js'
import type { KeyScope, SubscriptionTier } from '../services/apiKeys.js'
import { ValidationError, NotFoundError, ForbiddenError } from '../lib/errors.js'

const VALID_SCOPES: KeyScope[] = ['read', 'full']
const VALID_TIERS: SubscriptionTier[] = ['free', 'pro', 'enterprise']

/**
 * Create and return an Express Router for integration API key management.
 *
 * Accepts optional pre-built dependencies for testability — production callers
 * can omit them and rely on the shared singletons.
 */
export function createApiKeyRouter(
  repo = new InMemoryApiKeyRepository(),
  rotationService = new ApiKeyRotationService(repo, auditLogService),
): Router {
  const router = Router()

  // ── POST /api/integrations/keys ─────────────────────────────────────────
  // Issue a new integration API key for the authenticated user.
  router.post('/', requireUserAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { user } = req as AuthenticatedRequest

      const rawScope = req.body?.scope as string | undefined
      const rawTier = req.body?.tier as string | undefined

      if (rawScope !== undefined && !VALID_SCOPES.includes(rawScope as KeyScope)) {
        throw new ValidationError(`Invalid scope. Allowed values: ${VALID_SCOPES.join(', ')}`)
      }
      if (rawTier !== undefined && !VALID_TIERS.includes(rawTier as SubscriptionTier)) {
        throw new ValidationError(`Invalid tier. Allowed values: ${VALID_TIERS.join(', ')}`)
      }

      const result = await rotationService.issueKey(
        user!.id,
        user!.email,
        (rawScope as KeyScope) ?? 'read',
        (rawTier as SubscriptionTier) ?? 'free',
        req.ip,
      )

      res.status(201).json({ success: true, data: result })
    } catch (err) {
      next(err)
    }
  })

  // ── GET /api/integrations/keys ──────────────────────────────────────────
  // List all API keys owned by the authenticated user.
  router.get('/', requireUserAuth, (req: Request, res: Response): void => {
    const { user } = req as AuthenticatedRequest
    const keys = rotationService.listKeys(user!.id)
    res.status(200).json({ success: true, data: keys })
  })

  // ── POST /api/integrations/keys/:id/rotate ──────────────────────────────
  // Rotate a key: revoke the existing one and issue a replacement.
  router.post('/:id/rotate', requireUserAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { user } = req as AuthenticatedRequest
      const { id } = req.params

      const existing = repo.findById(id)
      if (!existing) {
        throw new NotFoundError('API key', id)
      }

      // Admins may rotate any key; regular users are restricted to their own.
      const isAdmin = user!.role === UserRole.ADMIN || user!.role === UserRole.SUPER_ADMIN
      if (!isAdmin && existing.ownerId !== user!.id) {
        throw new ForbiddenError('You do not have permission to rotate this API key')
      }

      const newKey = await rotationService.rotateKey(id, user!.id, user!.email, req.ip)

      if (!newKey) {
        // Key existed but was already revoked — conflict.
        res.status(409).json({
          error: 'Conflict',
          message: 'API key is already revoked and cannot be rotated',
        })
        return
      }

      res.status(200).json({
        success: true,
        message: 'API key rotated. Store the new key securely — it will not be shown again.',
        data: newKey,
      })
    } catch (err) {
      next(err)
    }
  })

  // ── DELETE /api/integrations/keys/:id ───────────────────────────────────
  // Permanently revoke an API key.
  router.delete('/:id', requireUserAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { user } = req as AuthenticatedRequest
      const { id } = req.params

      const existing = repo.findById(id)
      if (!existing) {
        throw new NotFoundError('API key', id)
      }

      const isAdmin = user!.role === UserRole.ADMIN || user!.role === UserRole.SUPER_ADMIN
      if (!isAdmin && existing.ownerId !== user!.id) {
        throw new ForbiddenError('You do not have permission to revoke this API key')
      }

      const revoked = await rotationService.revokeKey(id, user!.id, user!.email, req.ip)
      if (!revoked) {
        throw new NotFoundError('API key', id)
      }

      res.status(200).json({ success: true, message: 'API key revoked successfully' })
    } catch (err) {
      next(err)
    }
  })

  return router
}
