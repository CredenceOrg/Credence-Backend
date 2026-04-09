import { Request, Response, NextFunction } from 'express'
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'
import { computeRequestHash } from '../utils/hash.js'

/**
 * Middleware to handle idempotency keys and ensure reliable retries.
 * 
 * Logic:
 * 1. Check for `Idempotency-Key` header.
 * 2. If present, compute SHA-256 hash of the request body.
 * 3. Look up the key in the database.
 * 4. If key exists:
 *    - If request hash matches, replay the stored response.
 *    - If request hash mismatches, return 400 Bad Request.
 * 5. If key doesn't exist, intercept the response to store it before sending.
 * 
 * @param repo - The idempotency repository
 * @returns Express middleware
 */
export function idempotencyMiddleware(repo: IdempotencyRepository) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] as string
    if (!key) {
      return next()
    }

    try {
      const hash = computeRequestHash(req.body)
      const existing = await repo.findByKey(key)

      if (existing) {
        // Enforce same payload for same idempotency key
        if (existing.requestHash !== hash) {
          return res.status(400).json({
            error: 'IdempotencyParameterMismatch',
            message: 'Idempotency Key reuse with different payload',
          })
        }

        // Replay the stored response
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
            requestHash: hash,
            responseCode: res.statusCode,
            responseBody: body,
            expiresInSeconds: 86400, // 24 hours
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
