import { Router, type Request, type Response } from 'express'
import { generateApiKey, listApiKeys, revokeApiKey, rotateApiKey, ApiKeyScope } from '../services/apiKeys.js'
import { requireApiKey, requireScope } from '../middleware/apiKey.js'
import { auditLogService, AuditAction } from '../services/audit/index.js'

const router = Router()

/**
 * POST /api/api-keys
 * 
 * Create a new API key with specified scopes.
 * Requires authentication and audit logging.
 */
router.post(
  '/',
  requireApiKey(),
  requireScope(ApiKeyScope.BOND_WRITE), // Require at least one scope to create keys
  async (req: Request, res: Response) => {
    try {
      const { ownerId, scopes, tier } = req.body as {
        ownerId?: string
        scopes?: ApiKeyScope[]
        tier?: 'free' | 'pro' | 'enterprise'
      }

      if (!ownerId) {
        res.status(400).json({ error: 'ownerId is required' })
        return
      }

      // Default to empty scopes (least privilege) if not provided
      const keyScopes = scopes || []
      const keyTier = tier || 'free'

      // Validate scopes
      const validScopes = Object.values(ApiKeyScope)
      const invalidScopes = keyScopes.filter((s) => !validScopes.includes(s))
      if (invalidScopes.length > 0) {
        res.status(400).json({ error: `Invalid scopes: ${invalidScopes.join(', ')}` })
        return
      }

      const result = await generateApiKey(ownerId, keyScopes, keyTier)

      // Log the key creation in audit log
      await auditLogService.logAction({
        actorId: req.apiKeyRecord?.ownerId || 'system',
        actorEmail: 'api-key-service',
        action: AuditAction.CREATE_API_KEY,
        resourceType: 'api_key',
        resourceId: result.id,
        details: {
          scopes: keyScopes,
          tier: keyTier,
          prefix: result.prefix,
        },
        status: 'success',
      })

      res.status(201).json(result)
    } catch (error) {
      console.error('Error creating API key:', error)
      res.status(500).json({ error: 'Failed to create API key' })
    }
  }
)

/**
 * GET /api/api-keys/:ownerId
 * 
 * List all API keys for an owner.
 * Requires authentication.
 */
router.get(
  '/:ownerId',
  requireApiKey(),
  async (req: Request, res: Response) => {
    try {
      const { ownerId } = req.params
      const keys = await listApiKeys(ownerId)
      res.json(keys)
    } catch (error) {
      console.error('Error listing API keys:', error)
      res.status(500).json({ error: 'Failed to list API keys' })
    }
  }
)

/**
 * DELETE /api/api-keys/:id
 * 
 * Revoke an API key.
 * Requires authentication and audit logging.
 */
router.delete(
  '/:id',
  requireApiKey(),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const success = await revokeApiKey(id)

      if (!success) {
        res.status(404).json({ error: 'API key not found' })
        return
      }

      // Log the key revocation in audit log
      await auditLogService.logAction({
        actorId: req.apiKeyRecord?.ownerId || 'system',
        actorEmail: 'api-key-service',
        action: AuditAction.REVOKE_API_KEY,
        resourceType: 'api_key',
        resourceId: id,
        details: {},
        status: 'success',
      })

      res.status(204).send()
    } catch (error) {
      console.error('Error revoking API key:', error)
      res.status(500).json({ error: 'Failed to revoke API key' })
    }
  }
)

/**
 * POST /api/api-keys/:id/rotate
 * 
 * Rotate an API key (revoke old, issue new with same scopes).
 * Requires authentication and audit logging.
 */
router.post(
  '/:id/rotate',
  requireApiKey(),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const result = await rotateApiKey(id)

      if (!result) {
        res.status(404).json({ error: 'API key not found or already revoked' })
        return
      }

      // Log the key rotation in audit log
      await auditLogService.logAction({
        actorId: req.apiKeyRecord?.ownerId || 'system',
        actorEmail: 'api-key-service',
        action: AuditAction.CREATE_API_KEY, // Reuse CREATE_API_KEY for rotation
        resourceType: 'api_key',
        resourceId: result.id,
        details: {
          rotatedFrom: id,
          scopes: result.scopes,
          tier: result.tier,
          prefix: result.prefix,
        },
        status: 'success',
      })

      res.status(201).json(result)
    } catch (error) {
      console.error('Error rotating API key:', error)
      res.status(500).json({ error: 'Failed to rotate API key' })
    }
  }
)

export default router
