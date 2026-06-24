import type { Request, Response, NextFunction } from 'express'
import { createHash } from 'crypto'
import client from 'prom-client'
import { RedisConnection } from '../cache/redis.js'
import { AppError, ErrorCode } from '../lib/errors.js'
import type { SubscriptionTier } from '../services/apiKeys.js'
import type { Config } from '../config/index.js'
import { register } from './metrics.js'

// ── Prometheus counter ────────────────────────────────────────────────────────

export const rateLimitRejectedTotal = new client.Counter({
  name: 'rate_limit_rejected_total',
  help: 'Total number of requests rejected by the rate limiter',
  labelNames: ['tier', 'key_id', 'reason'],
  registers: [register],
})

// ── Public types ──────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Redis key namespace */
  namespace: string
  /** Explicit max override (bypasses tier resolution) */
  max?: number
  /** Window in seconds */
  windowSec: number
  /** Function to extract tenant identifier from request */
  getTenantId?: (req: Request) => string | undefined
  /**
   * Optional Redis client getter — injected in tests to simulate failures.
   * Defaults to `RedisConnection.getInstance().getClient()`.
   */
  getRedis?: () => { incr(k: string): Promise<number>; expire(k: string, s: number): Promise<number | void>; ttl(k: string): Promise<number> }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashIdentifier(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/**
 * Extract tenant identifier from a request.
 * Prefers authenticated ownerId / tenantId, falls back to a hashed credential
 * derived from the API key or Bearer token header so that unauthenticated
 * requests are still limited per-tenant rather than purely by IP.
 */
export function getTenantId(req: Request): string | undefined {
  const apiKeyRecord = (req as any).apiKeyRecord
  if (apiKeyRecord?.ownerId) return apiKeyRecord.ownerId

  const user = (req as any).user
  if (user?.tenantId) return user.tenantId

  const apiKey = req.headers['x-api-key'] as string | undefined
  if (apiKey) return `ak:${hashIdentifier(apiKey)}`

  const auth = req.headers['authorization']
  if (auth?.startsWith('Bearer ')) return `bt:${hashIdentifier(auth.slice(7))}`

  return undefined
}

/**
 * Extract the per-key identifier (API key record id) when available.
 * Falls back to undefined so the caller can decide whether to apply a
 * per-key bucket in addition to the per-tenant bucket.
 */
export function getKeyId(req: Request): string | undefined {
  return (req as any).apiKeyRecord?.id
}

/** Extract subscription tier from an authenticated request. */
export function getTier(req: Request): SubscriptionTier {
  return (req as any).apiKeyRecord?.tier ?? 'free'
}

/** Resolve the per-tier request limit from application config. */
export function resolveTierLimit(tier: SubscriptionTier, config: Config['rateLimit']): number {
  switch (tier) {
    case 'enterprise': return config.maxEnterprise
    case 'pro':        return config.maxPro
    case 'free':
    default:           return config.maxFree
  }
}

function setRateLimitHeaders(
  res: Response,
  opts: { limit: number; remaining: number; reset: number; retryAfter?: number },
): void {
  res.setHeader('X-RateLimit-Limit', String(opts.limit))
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.remaining)))
  res.setHeader('X-RateLimit-Reset', String(opts.reset))
  if (opts.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(opts.retryAfter))
  }
}

// ── Core fixed-window check ───────────────────────────────────────────────────

/**
 * Increment a fixed-window counter in Redis and return whether the request
 * is within the allowed budget.
 *
 * Returns `{ count, ttl }` so the caller can set headers and decide to block.
 */
async function checkWindow(
  redis: { incr(k: string): Promise<number>; expire(k: string, s: number): Promise<number | void>; ttl(k: string): Promise<number> },
  key: string,
  windowSec: number,
): Promise<{ count: number; ttl: number }> {
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, windowSec)
  const ttl = await redis.ttl(key)
  return { count, ttl: ttl > 0 ? ttl : windowSec }
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Factory for rate limiting middleware.
 *
 * Two independent fixed-window counters are maintained per request:
 *   1. Per-tenant (or IP fallback) — enforces the tier ceiling shared across
 *      all keys belonging to the same owner.
 *   2. Per-API-key — enforces the same tier ceiling but scoped to a single key,
 *      so one noisy key cannot exhaust the shared tenant budget.
 *
 * A request is rejected when *either* counter exceeds the limit.
 *
 * On Redis failure the middleware honours `config.failOpen`:
 *   - true  → pass the request through (fail-open / graceful degradation)
 *   - false → return 503 (fail-closed / secure default in production)
 */
export function createRateLimitMiddleware(
  config: Config['rateLimit'],
  options?: Partial<RateLimitConfig>,
) {
  const {
    namespace = 'ratelimit:api',
    windowSec = config.windowSec,
    getTenantId: customGetTenantId,
    getRedis = () => RedisConnection.getInstance().getClient(),
  } = options ?? {}

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.enabled) return next()

    const tenantId = customGetTenantId?.(req) ?? getTenantId(req)
    const keyId    = getKeyId(req)
    const tier     = getTier(req)
    const tierMax  = resolveTierLimit(tier, config)
    // Per-key limit: explicit override or same as tier ceiling
    const keyMax   = options?.max ?? tierMax

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    const tenantSegment = tenantId ? `tenant:${tenantId}` : `ip:${ip}`

    const now         = Math.floor(Date.now() / 1000)
    const windowStart = now - (now % windowSec)
    const resetTime   = windowStart + windowSec

    const tenantKey = `${namespace}:${tenantSegment}:${windowStart}`
    const keyBucket = keyId ? `${namespace}:key:${keyId}:${windowStart}` : null

    try {
      const redis = getRedis()

      // Check tenant-level bucket (tier ceiling)
      const { count: tenantCount, ttl: tenantTtl } = await checkWindow(redis, tenantKey, windowSec)

      if (tenantCount > tierMax) {
        rateLimitRejectedTotal.inc({ tier, key_id: keyId ?? 'none', reason: 'tenant_limit' })
        setRateLimitHeaders(res, { limit: tierMax, remaining: 0, reset: now + tenantTtl, retryAfter: tenantTtl })
        next(new AppError('Rate limit exceeded. Try again later.', ErrorCode.RATE_LIMIT_EXCEEDED, 429, { retryAfter: tenantTtl, limit: tierMax, windowSec }))
        return
      }

      // Check per-key bucket (key ceiling)
      if (keyBucket) {
        const { count: keyCount, ttl: keyTtl } = await checkWindow(redis, keyBucket, windowSec)

        if (keyCount > keyMax) {
          rateLimitRejectedTotal.inc({ tier, key_id: keyId!, reason: 'key_limit' })
          setRateLimitHeaders(res, { limit: keyMax, remaining: 0, reset: now + keyTtl, retryAfter: keyTtl })
          next(new AppError('Rate limit exceeded. Try again later.', ErrorCode.RATE_LIMIT_EXCEEDED, 429, { retryAfter: keyTtl, limit: keyMax, windowSec }))
          return
        }

        // Remaining is the tighter of the two budgets
        const remaining = Math.min(tierMax - tenantCount, keyMax - keyCount)
        setRateLimitHeaders(res, { limit: keyMax, remaining, reset: resetTime })
      } else {
        setRateLimitHeaders(res, { limit: tierMax, remaining: tierMax - tenantCount, reset: resetTime })
      }

      next()
    } catch (err) {
      if (config.failOpen) {
        // Fail-open: let the request through, surface headers with full budget
        setRateLimitHeaders(res, { limit: tierMax, remaining: tierMax, reset: resetTime })
        return next()
      }

      // Fail-closed: treat Redis unavailability as a hard blocker
      rateLimitRejectedTotal.inc({ tier, key_id: keyId ?? 'none', reason: 'redis_unavailable' })
      next(new AppError('Rate limiter unavailable', ErrorCode.SERVICE_UNAVAILABLE, 503))
    }
  }
}

/** Backward-compatible helper that accepts only per-route rate-limit options. */
export function rateLimit(options: RateLimitConfig) {
  return createRateLimitMiddleware(
    {
      enabled: true,
      windowSec: options.windowSec,
      maxFree: options.max ?? 100,
      maxPro: options.max ?? 100,
      maxEnterprise: options.max ?? 100,
      failOpen: true,
    },
    options,
  )
}
