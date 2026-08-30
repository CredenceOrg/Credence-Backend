/**
 * @module routes/apiKeys
 *
 * Integration API key management endpoints.
 *
 * Routes (all require Bearer auth):
 *   POST   /api/integrations/keys            - Issue a new key
 *   GET    /api/integrations/keys            - List keys for the authenticated user
 *   POST   /api/integrations/keys/:id/rotate - Rotate a key (safe invalidation)
 *   DELETE /api/integrations/keys/:id        - Permanently revoke a key
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { requireUserAuth, UserRole, type AuthenticatedRequest, requireApiKey } from '../middleware/auth.js'
import { InMemoryApiKeyRepository } from '../repositories/apiKeyRepository.js'
import { ApiKeyRotationService } from '../services/apiKeyRotationService.js'
import { auditLogService } from '../services/audit/index.js'
import {
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  ApiKeyScope,
  type KeyScope,
  type SubscriptionTier,
} from '../services/apiKeys.js'
import { ValidationError, NotFoundError, ForbiddenError, sendError, ErrorCode } from '../lib/errors.js'

const VALID_SCOPES: KeyScope[] = ['read', 'full']
const VALID_TIERS: SubscriptionTier[] = ['free', 'pro', 'enterprise']

/**
 * Create and return an Express Router for integration API key management.
 *
 * Accepts optional pre-built dependencies for testability - production callers
 * can omit them and rely on the shared singletons.
 */
export function createApiKeyRouter(
  repo = new InMemoryApiKeyRepository(),
  rotationService = new ApiKeyRotationService(repo, auditLogService),
): Router {
  const router = Router()

  // POST /api/integrations/keys
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

      // 'full' is the legacy alias for ApiScope.ENTERPRISE (see middleware/auth.ts),
      // which requireApiKey treats as a superset of every granular scope — including
      // admin:read, admin:write, outbox:reinject, and webhooks:admin. Self-service
      // issuance must not let an ordinary user mint a key with that reach; only an
      // authenticated admin identity may request it. Rejected here, before any key
      // is created, so no elevated credential is ever persisted for a denied request.
      if (rawScope === 'full' && user!.role !== UserRole.ADMIN && user!.role !== UserRole.SUPER_ADMIN) {
        throw new ForbiddenError(
          "The 'full' API key scope grants administrator-equivalent access and can only be self-issued by an admin account.",
        )
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

  // GET /api/integrations/keys
  router.get('/', requireUserAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { user } = req as AuthenticatedRequest
      const keys = await rotationService.listKeys(user!.id)
      res.status(200).json({ success: true, data: keys })
    } catch (err) {
      next(err)
    }
  })

  // POST /api/integrations/keys/:id/rotate
  router.post('/:id/rotate', requireUserAuth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { user } = req as AuthenticatedRequest
      const { id } = req.params

      const existing = repo.findById(id)
      const isAdmin = user!.role === UserRole.ADMIN || user!.role === UserRole.SUPER_ADMIN

      if (existing && !isAdmin && existing.ownerId !== user!.id) {
        throw new ForbiddenError('You do not have permission to rotate this API key')
      }

      const newKey = await rotationService.rotateKey(id, user!.id, user!.email, req.ip)

      if (!newKey) {
        if (!existing) {
          throw new NotFoundError('API key', id)
        }

        sendError(res, ErrorCode.CONFLICT, 'API key is already revoked and cannot be rotated')
        return
      }

      res.status(200).json({
        success: true,
        message: 'API key rotated. Store the new key securely - it will not be shown again.',
        data: newKey,
      })
    } catch (err) {
      next(err)
    }
  })

  // DELETE /api/integrations/keys/:id
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

function createDefaultRouter(): Router {
  const router = Router()
  const auth = requireApiKey('bond:write' as any)

  router.post('/', auth, async (req: Request, res: Response): Promise<void> => {
    const { ownerId, scopes, tier } = req.body
    if (!ownerId) {
      res.status(400).json({ error: 'ownerId is required' })
      return
    }

    if (scopes && Array.isArray(scopes)) {
      const validScopes = Object.values(ApiKeyScope) as string[]
      for (const s of scopes) {
        if (!validScopes.includes(s)) {
          res.status(400).json({ error: 'Invalid scope' })
          return
        }
      }
    }

    const key = await generateApiKey(ownerId, scopes, tier)
    res.status(201).json(key)
  })

  router.get('/:ownerId', auth, async (req: Request, res: Response): Promise<void> => {
    const keys = await listApiKeys(req.params.ownerId)
    res.status(200).json(keys)
  })

  router.delete('/:id', auth, async (req: Request, res: Response): Promise<void> => {
    const revoked = await revokeApiKey(req.params.id)
    if (!revoked) {
      res.status(404).json({ error: 'Key not found' })
    } else {
      res.status(204).end()
    }
  })

  router.post('/:id/rotate', auth, async (req: Request, res: Response): Promise<void> => {
    const result = await rotateApiKey(req.params.id)
    if (!result) {
      res.status(404).json({ error: 'Key not found' })
    } else {
      res.status(201).json(result)
    }
  })

  return router
}

export default createDefaultRouter()
