import { Request, Response, NextFunction } from 'express'
import { redisConnection } from '../cache/redis.js'

export interface RateLimitOptions {
  /** Redis key namespace, e.g. 'ratelimit:login' */
  namespace: string
  /** Max requests allowed in the window */
  max: number
  /** Window in seconds */
  windowSec: number
  /** Function to extract tenant identifier from request */
  getTenantId?: (req: Request) => string | undefined
  /** Function to extract IP address from request */
  getIp?: (req: Request) => string | undefined
}

/**
 * Express middleware for tenant/IP rate limiting using Redis counters.
 *
 * - Supports independent limits for tenant and IP.
 * - Returns 429 with standard Retry-After header if exceeded.
 *
 * Usage:
 *   app.post('/api/login', rateLimit({ ...options }), handler)
 */
export function rateLimit(options: RateLimitOptions) {
  const {
    namespace,
    max,
    windowSec,
    getTenantId = (req) => req.headers['x-api-key'] as string | undefined,
    getIp = (req) => req.ip,
  } = options

  return async (req: Request, res: Response, next: NextFunction) => {
    const redis = redisConnection.getClient()
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - (now % windowSec)

    const tenantId = getTenantId(req)
    const ip = getIp(req)

    // Compose Redis keys
    const keys: { key: string; label: string }[] = []
    if (tenantId) keys.push({ key: `${namespace}:tenant:${tenantId}:${windowStart}`, label: 'tenant' })
    if (ip) keys.push({ key: `${namespace}:ip:${ip}:${windowStart}`, label: 'ip' })

    let exceeded = false
    let retryAfter = windowSec

    for (const { key, label } of keys) {
      const count = await redis.incr(key)
      if (count === 1) {
        await redis.expire(key, windowSec)
      }
      if (count > max) {
        exceeded = true
        // Calculate seconds until window resets
        const ttl = await redis.ttl(key)
        retryAfter = Math.min(retryAfter, ttl > 0 ? ttl : windowSec)
        res.setHeader('X-RateLimit-Limit', max)
        res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count))
        res.setHeader('X-RateLimit-Reset', now + retryAfter)
        res.setHeader('Retry-After', retryAfter)
        res.status(429).json({
          error: 'RateLimitExceeded',
          message: `Too many requests for this ${label}. Try again later.`,
          retryAfter,
        })
        return
      } else {
        res.setHeader('X-RateLimit-Limit', max)
        res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count))
        res.setHeader('X-RateLimit-Reset', now + windowSec)
      }
    }

    next()
  }
}
