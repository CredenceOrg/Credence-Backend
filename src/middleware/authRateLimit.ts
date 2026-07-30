import type { Request } from 'express'
import type { Config } from '../config/index.js'
import { createRateLimitMiddleware } from './rateLimit.js'

export type AuthRateLimitConfig = Config['authRateLimit']

/**
 * Resolve the tenant identifier for auth endpoint rate limiting.
 * Prefers `X-Tenant-Id`, then JSON body `tenantId`. When neither is present,
 * the shared rate limiter falls back to per-IP limiting at the auth ceiling.
 */
export function resolveAuthTenantId(req: Request): string | undefined {
  const header = req.headers['x-tenant-id']
  if (typeof header === 'string') {
    const trimmed = header.trim()
    if (trimmed) return trimmed
  }

  const tenantId = (req.body as { tenantId?: unknown } | undefined)?.tenantId
  if (typeof tenantId === 'string') {
    const trimmed = tenantId.trim()
    if (trimmed) return trimmed
  }

  return undefined
}

/**
 * Tenant-level rate limiter for unauthenticated auth routes (login / refresh).
 * Uses a dedicated Redis namespace and stricter defaults than the global API limiter.
 */
export function createAuthRateLimitMiddleware(config: AuthRateLimitConfig) {
  const sharedRateLimitConfig: Config['rateLimit'] = {
    enabled: config.enabled,
    windowSec: config.windowSec,
    maxFree: config.maxPerTenant,
    maxPro: config.maxPerTenant,
    maxEnterprise: config.maxPerTenant,
    failOpen: config.failOpen,
  }

  return createRateLimitMiddleware(sharedRateLimitConfig, {
    namespace: 'ratelimit:auth',
    windowSec: config.windowSec,
    getTenantId: resolveAuthTenantId,
  })
}
