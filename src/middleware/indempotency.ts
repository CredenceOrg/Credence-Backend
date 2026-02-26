// ============================================================================
// File: src/middleware/idempotency.ts
// ============================================================================

import type { Request, Response, NextFunction } from 'express'
import { createHash, randomBytes } from 'crypto'
import type { Redis } from 'ioredis'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for idempotency middleware.
 */
export interface IdempotencyConfig {
     /** Redis client for storing idempotency state */
     redis: Redis
     
     /** TTL for idempotency keys in seconds (default: 24 hours) */
     ttl?: number
     
     /** Header name for idempotency key (default: 'Idempotency-Key') */
     headerName?: string
     
     /** Whether to generate key if not provided (default: false) */
     autoGenerate?: boolean
     
     /** Prefix for Redis keys (default: 'idem:') */
     keyPrefix?: string
}

/**
 * Stored idempotency record in Redis.
 */
interface IdempotencyRecord {
     /** HTTP status code of the original response */
     statusCode: number
     
     /** Response headers from the original response */
     headers: Record<string, string>
     
     /** Response body from the original response */
     body: any
     
     /** Timestamp when the record was created */
     createdAt: string
     
     /** Request fingerprint for additional validation */
     fingerprint: string
}

/**
 * Extended request with idempotency metadata.
 */
interface IdempotentRequest extends Request {
     idempotencyKey?: string
     idempotencyFingerprint?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL = 86400 // 24 hours
const DEFAULT_HEADER_NAME = 'Idempotency-Key'
const DEFAULT_KEY_PREFIX = 'idem:'
const MIN_KEY_LENGTH = 16
const MAX_KEY_LENGTH = 255

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Validates an idempotency key format.
 * 
 * @param key - The idempotency key to validate
 * @returns True if valid, false otherwise
 */
function isValidIdempotencyKey(key: string): boolean {
     if (!key || typeof key !== 'string') {
          return false
     }
     
     if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
          return false
     }
     
     // Only allow alphanumeric, hyphens, and underscores
     return /^[a-zA-Z0-9_-]+$/.test(key)
}

/**
 * Generates a secure random idempotency key.
 * 
 * @returns A 32-character random key
 */
function generateIdempotencyKey(): string {
     return randomBytes(16).toString('hex')
}

/**
 * Creates a fingerprint of the request for conflict detection.
 * Fingerprint includes: method, path, body, and critical headers.
 * 
 * @param req - Express request object
 * @returns SHA-256 hash of the request fingerprint
 */
function createRequestFingerprint(req: Request): string {
     const components = [
          req.method,
          req.path,
          JSON.stringify(req.body || {}),
          req.headers['content-type'] || '',
          (req as any).user?.id || '', // Include user ID if authenticated
     ]
     
     return createHash('sha256')
          .update(components.join('|'))
          .digest('hex')
}

/**
 * Structured logger for idempotency events.
 * Replace with your logger (pino, winston, etc.).
 * 
 * @param event - Event type
 * @param data - Event data
 */
function logIdempotencyEvent(event: string, data: any): void {
     const entry = {
          event: `idempotency_${event}`,
          timestamp: new Date().toISOString(),
          ...data,
     }
     console.log(JSON.stringify(entry))
}

/**
 * Intercepts response to capture status, headers, and body.
 * 
 * @param res - Express response object
 * @param callback - Callback with captured response data
 */
function interceptResponse(
     res: Response,
     callback: (data: { statusCode: number; headers: any; body: any }) => void
): void {
     const originalJson = res.json.bind(res)
     const originalSend = res.send.bind(res)
     const originalStatus = res.status.bind(res)
     
     let statusCode = 200
     let capturedBody: any = null
     
     // Intercept status
     res.status = function(code: number) {
          statusCode = code
          return originalStatus(code)
     }
     
     // Intercept json
     res.json = function(body: any) {
          capturedBody = body
          callback({
               statusCode,
               headers: res.getHeaders(),
               body,
          })
          return originalJson(body)
     }
     
     // Intercept send
     res.send = function(body: any) {
          capturedBody = body
          callback({
               statusCode,
               headers: res.getHeaders(),
               body,
          })
          return originalSend(body)
     }
}

// ---------------------------------------------------------------------------
// Main Middleware Factory
// ---------------------------------------------------------------------------

/**
 * Creates an idempotency middleware for state-changing requests.
 * 
 * This middleware ensures that duplicate requests with the same idempotency
 * key return the same response without re-executing the handler.
 * 
 * ## How It Works
 * 
 * 1. Client sends request with `Idempotency-Key` header
 * 2. Middleware checks if key exists in Redis
 * 3. If exists: return cached response (idempotent)
 * 4. If not exists: execute handler and cache response
 * 5. Key expires after TTL (default 24 hours)
 * 
 * ## Usage
 * 
 * ```typescript
 * import { createIdempotencyMiddleware } from './middleware/idempotency'
 * import Redis from 'ioredis'
 * 
 * const redis = new Redis()
 * const idempotency = createIdempotencyMiddleware({ redis })
 * 
 * // Apply to specific routes
 * router.post('/disputes', idempotency, disputeHandler)
 * router.post('/votes', idempotency, voteHandler)
 * ```
 * 
 * ## Security Considerations
 * 
 * - Keys are validated for format and length
 * - Request fingerprints detect conflicting requests with same key
 * - Keys expire after TTL to prevent indefinite storage
 * - Only 2xx responses are cached (errors are not idempotent)
 * 
 * @param config - Configuration options
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * // Basic usage
 * const idempotency = createIdempotencyMiddleware({ redis })
 * 
 * // Custom TTL (1 hour)
 * const idempotency = createIdempotencyMiddleware({ 
 *   redis, 
 *   ttl: 3600 
 * })
 * 
 * // Custom header name
 * const idempotency = createIdempotencyMiddleware({ 
 *   redis, 
 *   headerName: 'X-Request-ID' 
 * })
 * ```
 */
export function createIdempotencyMiddleware(config: IdempotencyConfig) {
     const {
          redis,
          ttl = DEFAULT_TTL,
          headerName = DEFAULT_HEADER_NAME,
          autoGenerate = false,
          keyPrefix = DEFAULT_KEY_PREFIX,
     } = config
     
     return async (
          req: IdempotentRequest,
          res: Response,
          next: NextFunction
     ): Promise<void> => {
          try {
               // Only apply to state-changing methods
               if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
                    return next()
               }
               
               // Extract idempotency key from header
               let idempotencyKey = req.headers[headerName.toLowerCase()] as string
               
               // Generate key if auto-generate is enabled and no key provided
               if (!idempotencyKey && autoGenerate) {
                    idempotencyKey = generateIdempotencyKey()
                    logIdempotencyEvent('key_generated', {
                         key: idempotencyKey,
                         path: req.path,
                    })
               }
               
               // If no key and auto-generate disabled, skip idempotency
               if (!idempotencyKey) {
                    return next()
               }
               
               // Validate key format
               if (!isValidIdempotencyKey(idempotencyKey)) {
                    logIdempotencyEvent('invalid_key', {
                         key: idempotencyKey,
                         path: req.path,
                    })
                    
                    res.status(400).json({
                         error: 'Invalid idempotency key',
                         message: `Key must be ${MIN_KEY_LENGTH}-${MAX_KEY_LENGTH} alphanumeric characters`,
                    })
                    return
               }
               
               // Create request fingerprint
               const fingerprint = createRequestFingerprint(req)
               req.idempotencyKey = idempotencyKey
               req.idempotencyFingerprint = fingerprint
               
               // Build Redis key
               const redisKey = `${keyPrefix}${idempotencyKey}`
               
               // Check if key exists in Redis
               const existingRecord = await redis.get(redisKey)
               
               if (existingRecord) {
                    // Parse stored record
                    const record: IdempotencyRecord = JSON.parse(existingRecord)
                    
                    // Verify request fingerprint matches
                    if (record.fingerprint !== fingerprint) {
                         logIdempotencyEvent('conflict', {
                              key: idempotencyKey,
                              path: req.path,
                              originalFingerprint: record.fingerprint,
                              currentFingerprint: fingerprint,
                         })
                         
                         res.status(409).json({
                              error: 'Idempotency key conflict',
                              message: 'Same key used for different request',
                         })
                         return
                    }
                    
                    // Return cached response
                    logIdempotencyEvent('cache_hit', {
                         key: idempotencyKey,
                         path: req.path,
                         statusCode: record.statusCode,
                    })
                    
                    // Set original headers
                    Object.entries(record.headers).forEach(([key, value]) => {
                         res.setHeader(key, value)
                    })
                    
                    // Add idempotency replay header
                    res.setHeader('X-Idempotency-Replay', 'true')
                    
                    res.status(record.statusCode).json(record.body)
                    return
               }
               
               // Key doesn't exist - execute handler and cache response
               logIdempotencyEvent('cache_miss', {
                    key: idempotencyKey,
                    path: req.path,
               })
               
               // Intercept response to cache it
               interceptResponse(res, async (responseData) => {
                    const { statusCode, headers, body } = responseData
                    
                    // Only cache successful responses (2xx)
                    if (statusCode >= 200 && statusCode < 300) {
                         const record: IdempotencyRecord = {
                              statusCode,
                              headers: headers as Record<string, string>,
                              body,
                              createdAt: new Date().toISOString(),
                              fingerprint,
                         }
                         
                         // Store in Redis with TTL
                         await redis.setex(
                              redisKey,
                              ttl,
                              JSON.stringify(record)
                         )
                         
                         logIdempotencyEvent('cached', {
                              key: idempotencyKey,
                              path: req.path,
                              statusCode,
                              ttl,
                         })
                    } else {
                         logIdempotencyEvent('not_cached', {
                              key: idempotencyKey,
                              path: req.path,
                              statusCode,
                              reason: 'non_2xx_status',
                         })
                    }
               })
               
               next()
               
          } catch (error) {
               logIdempotencyEvent('error', {
                    error: error instanceof Error ? error.message : 'Unknown error',
                    path: req.path,
               })
               
               // On error, continue without idempotency
               next()
          }
     }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Manually invalidate an idempotency key.
 * Useful for admin operations or error recovery.
 * 
 * @param redis - Redis client
 * @param key - Idempotency key to invalidate
 * @param keyPrefix - Key prefix (default: 'idem:')
 * @returns True if key was deleted, false if it didn't exist
 * 
 * @example
 * ```typescript
 * await invalidateIdempotencyKey(redis, 'dispute-abc123')
 * ```
 */
export async function invalidateIdempotencyKey(
     redis: Redis,
     key: string,
     keyPrefix: string = DEFAULT_KEY_PREFIX
): Promise<boolean> {
     const redisKey = `${keyPrefix}${key}`
     const result = await redis.del(redisKey)
     return result > 0
}

/**
 * Get stored idempotency record (for debugging/admin).
 * 
 * @param redis - Redis client
 * @param key - Idempotency key
 * @param keyPrefix - Key prefix (default: 'idem:')
 * @returns Stored record or null if not found
 * 
 * @example
 * ```typescript
 * const record = await getIdempotencyRecord(redis, 'dispute-abc123')
 * if (record) {
 *   console.log('Cached response:', record.body)
 * }
 * ```
 */
export async function getIdempotencyRecord(
     redis: Redis,
     key: string,
     keyPrefix: string = DEFAULT_KEY_PREFIX
): Promise<IdempotencyRecord | null> {
     const redisKey = `${keyPrefix}${key}`
     const data = await redis.get(redisKey)
     return data ? JSON.parse(data) : null
}

/**
 * Get TTL (time to live) for an idempotency key.
 * 
 * @param redis - Redis client
 * @param key - Idempotency key
 * @param keyPrefix - Key prefix (default: 'idem:')
 * @returns TTL in seconds, or -1 if key doesn't exist, -2 if no TTL
 * 
 * @example
 * ```typescript
 * const ttl = await getIdempotencyKeyTTL(redis, 'dispute-abc123')
 * console.log(`Key expires in ${ttl} seconds`)
 * ```
 */
export async function getIdempotencyKeyTTL(
     redis: Redis,
     key: string,
     keyPrefix: string = DEFAULT_KEY_PREFIX
): Promise<number> {
     const redisKey = `${keyPrefix}${key}`
     return await redis.ttl(redisKey)
}