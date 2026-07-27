/**
 * @file src/routes/admin/rateLimit.ts
 *
 * Admin endpoint for inspecting rate limit window state.
 *
 * Provides a read-only view of the current fixed-window counter for a given
 * tenant or IP so that support and on-call engineers can diagnose 429 incidents
 * without needing direct Redis access.
 *
 * Endpoint
 * ────────
 *  GET /api/admin/rate-limit/inspect
 *
 * Query parameters
 * ────────────────
 *  tenantId  (string, optional) – tenant identifier to inspect.
 *            Mutually exclusive with ip.
 *  ip        (string, optional) – IP address to inspect.
 *            Used when the client is rate-limited on the IP fallback path.
 *
 *  At least one of tenantId or ip must be supplied.
 *
 * Response 200
 * ────────────
 *  {
 *    "key":        "ratelimit:api:tenant:<id>:<windowStart>",
 *    "count":      42,
 *    "limit":      100,
 *    "remaining":  58,
 *    "resetAt":    1720000060,   // Unix seconds
 *    "ttl":        47,           // seconds until window expires
 *    "windowSec":  60
 *  }
 *
 * Security
 * ────────
 *  Requires admin authentication (requireUserAuth + requireAdminRole).
 *  Tenant identifiers are not echoed raw — they are taken directly from
 *  validated query params so injection is not possible.
 */

import { Router, type Request, type Response } from 'express'
import { requireUserAuth, requireAdminRole } from '../../middleware/auth.js'
import { RedisConnection } from '../../cache/redis.js'
import { validateConfig } from '../../config/index.js'

/** Shape returned by the inspection endpoint. */
export interface RateLimitWindowInfo {
  key: string
  count: number
  limit: number
  remaining: number
  resetAt: number
  ttl: number
  windowSec: number
}

/**
 * Build the Redis key for the current fixed window, mirroring the logic
 * inside createRateLimitMiddleware.
 */
export function buildWindowKey(
  namespace: string,
  keyPrefix: string,
  windowSec: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): { key: string; windowStart: number; resetAt: number } {
  const windowStart = nowSec - (nowSec % windowSec)
  const key = `${namespace}:${keyPrefix}:${windowStart}`
  const resetAt = windowStart + windowSec
  return { key, windowStart, resetAt }
}

export function createRateLimitAdminRouter(): Router {
  const router = Router()

  let rateLimitConfig: { enabled: boolean; windowSec: number; maxFree: number; maxPro: number; maxEnterprise: number; failOpen: boolean }
  try {
    rateLimitConfig = validateConfig(process.env).rateLimit
  } catch {
    rateLimitConfig = {
      enabled: true,
      windowSec: 60,
      maxFree: 100,
      maxPro: 1000,
      maxEnterprise: 10000,
      failOpen: true,
    }
  }

  /**
   * GET /api/admin/rate-limit/inspect
   *
   * Returns the current rate-limit window state for a tenant or IP.
   */
  router.get(
    '/inspect',
    requireUserAuth,
    requireAdminRole,
    async (req: Request, res: Response): Promise<void> => {
      const { tenantId, ip } = req.query as { tenantId?: string; ip?: string }

      if (!tenantId && !ip) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'At least one of tenantId or ip must be provided.',
        })
        return
      }

      if (tenantId && ip) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'Provide either tenantId or ip, not both.',
        })
        return
      }

      const keyPrefix = tenantId
        ? `tenant:${tenantId}`
        : `ip:${ip}`

      const namespace = 'ratelimit:api'
      const { windowSec } = rateLimitConfig
      const nowSec = Math.floor(Date.now() / 1000)
      const { key, resetAt } = buildWindowKey(namespace, keyPrefix, windowSec, nowSec)

      // Default limit shown for anonymous inspection is the free-tier max.
      const limit = rateLimitConfig.maxFree

      try {
        const redis = RedisConnection.getInstance().getClient()

        // Read the current counter and TTL in parallel.
        const [rawCount, ttl] = await Promise.all([
          redis.get(key),
          redis.ttl(key),
        ])

        const count = rawCount !== null ? parseInt(rawCount, 10) : 0
        const remaining = Math.max(0, limit - count)

        const info: RateLimitWindowInfo = {
          key,
          count,
          limit,
          remaining,
          resetAt,
          ttl: ttl > 0 ? ttl : 0,
          windowSec,
        }

        res.status(200).json({ success: true, data: info })
      } catch (err) {
        res.status(503).json({
          error: 'ServiceUnavailable',
          message: 'Rate limit store is unavailable. Try again later.',
        })
      }
    },
  )

  return router
}
