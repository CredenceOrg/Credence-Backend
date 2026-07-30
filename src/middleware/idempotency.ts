import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'
import { computeRequestHash } from '../utils/hash.js'
import { AppError, ErrorCode } from '../lib/errors.js'
import type { StoredApiKey } from '../services/apiKeys.js'

export interface IdempotencyOptions {
  /** TTL for idempotency keys in seconds (default: 86400 = 24 hours) */
  expiresInSeconds?: number
}

/**
 * Extract the actor ID from the request.
 * 
 * Priority:
 * 1. API key ID (from req.apiKey or req.apiKeyRecord)
 * 2. User ID (from req.user)
 * 3. 'anonymous' if no authentication present
 */
function extractActorId(req: Request): string {
  // Check for API key authentication
  const apiKey = (req as any).apiKey as StoredApiKey | undefined
  if (apiKey?.id) {
    return apiKey.id
  }
  
  const apiKeyRecord = (req as any).apiKeyRecord as StoredApiKey | undefined
  if (apiKeyRecord?.id) {
    return apiKeyRecord.id
  }
  
  // Check for user authentication
  const user = (req as any).user as { id: string } | undefined
  if (user?.id) {
    return user.id
  }
  
  // No authentication - use anonymous
  return 'anonymous'
}

/**
 * Compute the bound key hash: sha256(actor_id || payload_canonical)
 * 
 * This binds the idempotency key to both the actor and the payload,
 * preventing replay attacks where a stolen key is used by a different actor
 * or with a different payload.
 */
export function computeBoundKeyHash(actorId: string, payloadHash: string): string {
  const combined = `${actorId}:${payloadHash}`
  return crypto.createHash('sha256').update(combined).digest('hex')
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if strings are equal, false otherwise.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  
  return result === 0
}

/**
 * Middleware to handle idempotency keys with replay protection.
 * 
 * Security guarantees:
 * - Keys are bound to the calling actor (API key ID or user ID)
 * - Keys are bound to the full payload hash
 * - A stolen key cannot be replayed by a different actor
 * - A stolen key cannot be replayed with a different payload
 * - Constant-time comparison prevents timing attacks
 * 
 * Logic:
 * 1. Check for `Idempotency-Key` header.
 * 2. If present, compute bound key hash = sha256(actor_id || payload_hash).
 * 3. Look up the key in the database.
 * 4. If key exists:
 *    - If actor AND payload hash match, replay the stored response.
 *    - If actor or payload mismatches, return 409 Conflict.
 * 5. If key doesn't exist, intercept the response to store it before sending.
 * 
 * @param repo - The idempotency repository
 * @param options - Configuration options
 * @returns Express middleware
 */
export function idempotencyMiddleware(
  repo: IdempotencyRepository,
  options: IdempotencyOptions = {}
) {
  const ttlSeconds = options.expiresInSeconds ?? 86400 // Default 24 hours

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] as string
    if (!key) {
      return next()
    }

    try {
      const actorId = extractActorId(req)
      const payloadHash = computeRequestHash(req.body)
      const boundKeyHash = computeBoundKeyHash(actorId, payloadHash)
      
      const existing = await repo.findByKey(key)

      if (existing) {
        // Security: Never return cached response to a different actor
        // Use constant-time comparison to prevent timing attacks
        const storedBoundHash = computeBoundKeyHash(existing.actorId, existing.requestHash)
        
        if (!constantTimeEquals(boundKeyHash, storedBoundHash)) {
          // Actor or payload mismatch - reject with 409 Conflict
          const mismatchError = new AppError(
            'Idempotency key is already bound to a different actor or payload',
            ErrorCode.IDEMPOTENCY_KEY_MISMATCH
          )
          return res.status(mismatchError.status).json(mismatchError.toJSON())
        }

        // Actor and payload match - safe to replay the stored response
        return res.status(existing.responseCode).json(existing.responseBody)
      }

      // Intercept the response to persist it
      const originalJson = res.json.bind(res)
      
      res.json = (body: any) => {
        // Only persist successful or client-side errors (not transient 5xx)
        if (res.statusCode < 500) {
          // Fire and forget the save operation to avoid blocking the response
          repo.save({
            key,
            actorId,
            requestHash: payloadHash,
            responseCode: res.statusCode,
            responseBody: body,
            ttlSeconds,
            expiresInSeconds: ttlSeconds,
          }).catch((err) => {
            console.error(`[Idempotency] Failed to save key ${key}:`, err)
          })
        }
        
        return originalJson(body)
      }

      next()
    } catch (error) {
      console.error('[Idempotency] Middleware error:', error)
      next(error)
    }
  }
}
