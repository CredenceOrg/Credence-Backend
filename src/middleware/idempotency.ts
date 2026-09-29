import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { IdempotencyRepository } from '../db/repositories/idempotencyRepository.js'
import { computeRequestHash } from '../utils/hash.js'
import { AppError, ErrorCode } from '../lib/errors.js'
import { logger } from '../utils/logger.js'
import { LogEventType } from '../observability/logSchemas.js'
import type { StoredApiKey } from '../services/apiKeys.js'

export interface IdempotencyOptions {
  /** TTL for idempotency keys in seconds (default: 86400 = 24 hours) */
  expiresInSeconds?: number
}

const inFlightKeys = new Map<string, Promise<void>>()

export async function waitForInFlight(key: string): Promise<() => void> {
  const previous = inFlightKeys.get(key)
  if (previous) await previous

  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  inFlightKeys.set(key, current)
  let released = false
  return () => {
    if (released) return
    released = true
    if (inFlightKeys.get(key) === current) inFlightKeys.delete(key)
    release()
  }
}

/**
 * Extract a provisional actor ID from raw credentials present on the request
 * before the auth middleware has populated req.apiKey / req.user.
 *
 * This binds the idempotency key to the caller's credential material rather
 * than to a downstream-decided identity, preventing an auth middleware bug or
 * identity mismatch from allowing a stolen idempotency key to be replayed
 * under a different actor.
 *
 * Priority:
 * 1. Raw API key prefix + hash (stable across restarts, no PII)
 * 2. Bearer token prefix + hash (stable across restarts, no PII)
 * 3. null if no credential material is present
 */
function extractProvisionalActorId(req: Request): string | null {
  const xApiKey = req.headers['x-api-key']
  if (typeof xApiKey === 'string' && xApiKey.length > 0) {
    return 'raw-key:' + crypto.createHash('sha256').update(xApiKey).digest('hex')
  }

  const authHeader = req.headers.authorization
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    if (token.length > 0) {
      return 'raw-token:' + crypto.createHash('sha256').update(token).digest('hex')
    }
  }

  return null
}

/**
 * Extract the actor ID from the request.
 *
 * Priority:
 * 1. Provisional raw credential hash (binds key to caller material before auth)
 * 2. API key ID (from req.apiKey or req.apiKeyRecord)
 * 3. User ID (from req.user)
 * 4. 'anonymous' if no authentication present
 */
export function extractActorId(req: Request): string {
  const provisional = extractProvisionalActorId(req)
  if (provisional !== null) {
    return provisional
  }

  const apiKey = (req as any).apiKey as StoredApiKey | undefined
  if (apiKey?.id) {
    return apiKey.id
  }

  const apiKeyRecord = (req as any).apiKeyRecord as StoredApiKey | undefined
  if (apiKeyRecord?.id) {
    return apiKeyRecord.id
  }

  const user = (req as any).user as { id: string } | undefined
  if (user?.id) {
    return user.id
  }

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
 * Extract tenant and request identifiers for structured logging.
 */
function extractRequestContext(req: Request): { correlationId: string; requestId: string; tenantId: string; actorId: string; route: string } {
  const correlationId = (req as any).correlationId || req.headers['x-correlation-id'] || 'unknown'
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'unknown'
  const tenantId = (req as any).tenantContext?.tenantId || req.headers['x-tenant-id'] || 'unknown'
  const actorId = extractActorId(req)
  const route = req.route?.path || req.path || 'unknown'

  return { correlationId, requestId, tenantId, actorId, route }
}

/**
 * Middleware to handle idempotency keys with replay protection.
 *
 * Security guarantees:
 * - Keys are bound to the calling actor (provisional credential hash, API key ID, or user ID)
 * - Keys are bound to the full payload hash
 * - A stolen key cannot be replayed by a different actor
 * - A stolen key cannot be replayed with a different payload
 * - Constant-time comparison prevents timing attacks
 * - 401/403 responses are never cached (prevents auth bypass via replay)
 *
 * Logic:
 * 1. Check for `Idempotency-Key` header.
 * 2. If present, compute bound key hash = sha256(actor_id || payload_hash).
 *    Actor identity is derived from raw credential material before auth
 *    middleware runs, binding the key to the caller's secret material.
 * 3. Look up the key in the database.
 * 4. If key exists:
 *    - If actor AND payload hash match, replay the stored response.
 *    - If actor or payload mismatches, return 409 Conflict.
 * 5. If key doesn't exist, intercept the response to store it before sending.
 *    Responses with status >= 500 are not persisted (transient failures).
 *
 * @param repo - The idempotency repository
 * @param options - Configuration options
 * @returns Express middleware
 */
export function idempotencyMiddleware(
  repo: IdempotencyRepository,
  options: IdempotencyOptions = {}
) {
  const ttlSeconds = options.expiresInSeconds ?? 86400

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key'] as string
    if (!key) {
      return next()
    }

    let release: (() => void) | undefined
    const ctx = extractRequestContext(req)

    try {
      const actorId = extractActorId(req)
      const payloadHash = computeRequestHash(req.body)
      const boundKeyHash = computeBoundKeyHash(actorId, payloadHash)

      release = await waitForInFlight(key)
      res.once('close', release)
      const existing = await repo.findByKey(key)

      if (existing) {
        const storedBoundHash = computeBoundKeyHash(existing.actorId, existing.requestHash)

        if (!constantTimeEquals(boundKeyHash, storedBoundHash)) {
          logger.error({
            message: '[Idempotency] Key bound to different actor or payload',
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            actorId: ctx.actorId,
            route: ctx.route,
            key: key.slice(0, 8) + '...',
            storedActorId: existing.actorId,
            requestActorId: actorId,
            storedPayloadHash: existing.requestHash.slice(0, 16) + '...',
            requestPayloadHash: payloadHash.slice(0, 16) + '...',
          }, { eventType: LogEventType.IDEMPOTENCY_MISMATCH })

          const mismatchError = new AppError(
            'Idempotency key is already bound to a different actor or payload',
            ErrorCode.IDEMPOTENCY_KEY_MISMATCH
          )
          const response = res.status(mismatchError.status).json(mismatchError.toJSON())
          release()
          release = undefined
          return response
        }

        logger.debug({
          message: '[Idempotency] Replaying cached response',
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          route: ctx.route,
          key: key.slice(0, 8) + '...',
          statusCode: existing.responseCode,
        }, { eventType: LogEventType.IDEMPOTENCY_REPLAY })

        const response = res.status(existing.responseCode).json(existing.responseBody)
        release()
        release = undefined
        return response
      }

      const originalJson = res.json.bind(res)

      res.json = (body: any) => {
        // Only persist successful or client-side errors (not transient 5xx)
        if (res.statusCode < 500) {
          // Save before releasing the per-process lock. The HTTP response is
          // still returned immediately, while a concurrent retry waits for the
          // durable record rather than executing the payout again.
          const savePromise = repo.save({
            key,
            actorId,
            requestHash: payloadHash,
            responseCode: res.statusCode,
            responseBody: body,
            responseHeaders: res.getHeaders(),
            ttlSeconds,
            expiresInSeconds: ttlSeconds,
          }).catch((err) => console.error(`[Idempotency] Failed to save key ${key}:`, err))
          savePromise.finally(release).catch(() => undefined)
        } else {
          release()
          return originalJson(body)
        }

        if (res.statusCode === 401 || res.statusCode === 403) {
          logger.warn({
            message: '[Idempotency] Refusing to cache auth rejection',
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            actorId: ctx.actorId,
            route: ctx.route,
            key: key.slice(0, 8) + '...',
            status: res.statusCode,
          }, { eventType: LogEventType.IDEMPOTENCY_NOT_CACHED })
          release()
          return originalJson(body)
        }

        logger.debug({
          message: '[Idempotency] Persisting idempotency record',
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
          tenantId: ctx.tenantId,
          actorId: ctx.actorId,
          route: ctx.route,
          key: key.slice(0, 8) + '...',
          status: res.statusCode,
        }, { eventType: LogEventType.IDEMPOTENCY_NOT_CACHED })

        const savePromise = repo.save({
          key,
          actorId,
          requestHash: payloadHash,
          responseCode: res.statusCode,
          responseBody: body,
          ttlSeconds,
          expiresInSeconds: ttlSeconds,
        }).catch((err) => logger.error('[Idempotency] Failed to save key ' + key + ':', err))
        savePromise.finally(release).catch(() => undefined)
        return originalJson(body)
      }

      next()
    } catch (error) {
      release?.()
      logger.error({
        message: '[Idempotency] Middleware error',
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        route: ctx.route,
        key: key ? key.slice(0, 8) + '...' : 'unknown',
        error: error instanceof Error ? error.message : 'Unknown error',
      }, { eventType: LogEventType.IDEMPOTENCY_MISMATCH })
      next(error)
    }
  }
}
