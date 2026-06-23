/**
 * @file Integration tests for tenant-level and per-key rate limiting.
 *
 * Covers:
 * ─ Response headers on every request
 * ─ 429 when limit exceeded (tenant bucket)
 * ─ 429 when limit exceeded (per-key bucket)
 * ─ Per-key isolation (different keys do not share counters)
 * ─ Tenant isolation (different tenants do not share counters)
 * ─ Tier-based limits (free vs pro vs enterprise)
 * ─ Fail-open when Redis is unavailable
 * ─ Fail-closed when Redis is unavailable
 * ─ rate_limit_rejected_total Prometheus counter
 * ─ getTenantId / getKeyId / resolveTierLimit helpers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import {
  createRateLimitMiddleware,
  getTenantId,
  getKeyId,
  resolveTierLimit,
  rateLimitRejectedTotal,
} from '../../src/middleware/rateLimit.js'
import type { Config } from '../../src/config/index.js'
import type { SubscriptionTier } from '../../src/services/apiKeys.js'

// ── In-memory Redis mock ──────────────────────────────────────────────────────

class MockRedis {
  private store = new Map<string, number>()

  async incr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) + 1
    this.store.set(key, next)
    return next
  }

  async expire(_key: string, _seconds: number): Promise<void> {}

  async ttl(key: string): Promise<number> {
    return this.store.has(key) ? 60 : -1
  }

  reset() {
    this.store.clear()
  }
}

const mockRedis = new MockRedis()

vi.mock('../../src/cache/redis.js', () => ({
  RedisConnection: {
    getInstance: () => ({ getClient: () => mockRedis }),
  },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<Config['rateLimit']> = {}): Config['rateLimit'] {
  return {
    enabled: true,
    windowSec: 60,
    maxFree: 3,
    maxPro: 3,
    maxEnterprise: 3,
    failOpen: true,
    ...overrides,
  }
}

function buildApp(opts: {
  config?: Partial<Config['rateLimit']>
  max?: number
  getTenantId?: (req: express.Request) => string | undefined
  /** Attach apiKeyRecord to every request */
  apiKeyRecord?: { id: string; ownerId: string; tier: SubscriptionTier }
} = {}): Express {
  // When opts.max is provided without an explicit config, use it as the tier
  // ceiling so that tenant-only tests (no apiKeyRecord) behave as expected.
  const tierOverride = opts.max !== undefined && !opts.config
    ? { maxFree: opts.max, maxPro: opts.max, maxEnterprise: opts.max }
    : {}
  const config = baseConfig({ ...tierOverride, ...opts.config })

  const app = express()
  app.use(express.json())

  if (opts.apiKeyRecord) {
    app.use((req, _res, next) => {
      ;(req as any).apiKeyRecord = opts.apiKeyRecord
      next()
    })
  }

  app.use(
    '/api',
    createRateLimitMiddleware(config, {
      namespace: 'ratelimit:test',
      windowSec: config.windowSec,
      max: opts.max,
      getTenantId: opts.getTenantId,
    }),
  )
  app.get('/api/ping', (_req, res) => res.json({ ok: true }))
  app.use((_err: any, _req: any, res: any, _next: any) => {
    res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code, details: _err.details })
  })
  return app
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Rate Limit Middleware', () => {
  beforeEach(() => {
    mockRedis.reset()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Headers
  // ═══════════════════════════════════════════════════════════════════════════

  describe('response headers', () => {
    it('includes X-RateLimit-* headers on a successful request', async () => {
      const app = buildApp({ max: 5 })
      const res = await request(app).get('/api/ping')

      expect(res.status).toBe(200)
      expect(res.headers['x-ratelimit-limit']).toBe('5')
      expect(res.headers['x-ratelimit-remaining']).toBe('4')
      expect(res.headers['x-ratelimit-reset']).toBeDefined()
    })

    it('decrements remaining with each request', async () => {
      const app = buildApp({ max: 5 })

      const r1 = await request(app).get('/api/ping')
      expect(r1.headers['x-ratelimit-remaining']).toBe('4')

      const r2 = await request(app).get('/api/ping')
      expect(r2.headers['x-ratelimit-remaining']).toBe('3')
    })

    it('includes Retry-After on 429', async () => {
      const app = buildApp({ max: 1 })

      await request(app).get('/api/ping')
      const res = await request(app).get('/api/ping')

      expect(res.status).toBe(429)
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Tenant-level limit enforcement
  // ═══════════════════════════════════════════════════════════════════════════

  describe('tenant limit enforcement', () => {
    it('returns 429 when the tenant limit is exceeded', async () => {
      const app = buildApp({ max: 2 })

      expect((await request(app).get('/api/ping')).status).toBe(200)
      expect((await request(app).get('/api/ping')).status).toBe(200)

      const r3 = await request(app).get('/api/ping')
      expect(r3.status).toBe(429)
      expect(r3.body.error).toMatch(/rate limit exceeded/i)
      expect(r3.body.details).toMatchObject({ limit: 2 })
    })

    it('resets after the window (simulated by clearing the store)', async () => {
      const app = buildApp({ max: 1 })

      expect((await request(app).get('/api/ping')).status).toBe(200)
      expect((await request(app).get('/api/ping')).status).toBe(429)

      mockRedis.reset()

      expect((await request(app).get('/api/ping')).status).toBe(200)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Per-key limit enforcement
  // ═══════════════════════════════════════════════════════════════════════════

  describe('per-key limit enforcement', () => {
    it('returns 429 when the per-key limit is exceeded', async () => {
      const app = buildApp({
        max: 2,
        apiKeyRecord: { id: 'key-abc', ownerId: 'owner-1', tier: 'free' },
      })

      expect((await request(app).get('/api/ping')).status).toBe(200)
      expect((await request(app).get('/api/ping')).status).toBe(200)

      const r3 = await request(app).get('/api/ping')
      expect(r3.status).toBe(429)
      expect(r3.body.error).toMatch(/rate limit exceeded/i)
    })

    it('isolates two keys belonging to the same tenant', async () => {
      // Build two apps that share the same tenant but use different key ids.
      // We simulate this by building two separate apps with different apiKeyRecord.id
      // but the same ownerId — the tenant bucket is shared, the key bucket is not.
      const appKeyA = buildApp({
        max: 2,
        apiKeyRecord: { id: 'key-A', ownerId: 'owner-shared', tier: 'free' },
      })
      const appKeyB = buildApp({
        max: 2,
        apiKeyRecord: { id: 'key-B', ownerId: 'owner-shared', tier: 'free' },
      })

      // Key A consumes 2 requests (hits its own key limit)
      await request(appKeyA).get('/api/ping')
      await request(appKeyA).get('/api/ping')
      const blockedA = await request(appKeyA).get('/api/ping')
      expect(blockedA.status).toBe(429)

      // Key B has its own bucket — first request should still succeed
      // (tenant bucket is also at 2 from key A, so key B's first request
      //  increments tenant to 3 which exceeds max=2 → 429 from tenant bucket)
      // This validates that the tenant ceiling is shared across keys.
      const tenantBlocked = await request(appKeyB).get('/api/ping')
      expect(tenantBlocked.status).toBe(429)
    })

    it('key-B is allowed when key-A is blocked but tenant budget remains', async () => {
      // Key A and Key B belong to different tenants so the tenant bucket is
      // independent. Key A exhausts its own key bucket (max=2); Key B still
      // has its own key budget and its own tenant budget.
      const sharedConfig: Partial<Config['rateLimit']> = {
        maxFree: 10, // generous tier ceiling
      }

      const appKeyA = buildApp({
        config: sharedConfig,
        max: 2,
        apiKeyRecord: { id: 'key-X', ownerId: 'owner-A', tier: 'free' },
      })
      const appKeyB = buildApp({
        config: sharedConfig,
        max: 2,
        apiKeyRecord: { id: 'key-Y', ownerId: 'owner-B', tier: 'free' },
      })

      // Key X exhausts its key bucket
      await request(appKeyA).get('/api/ping')
      await request(appKeyA).get('/api/ping')
      expect((await request(appKeyA).get('/api/ping')).status).toBe(429)

      // Key Y has its own budget — should still be allowed
      expect((await request(appKeyB).get('/api/ping')).status).toBe(200)
    })

    it('remaining header reflects the tighter of tenant vs key budget', async () => {
      const app = buildApp({
        max: 5,
        apiKeyRecord: { id: 'key-tight', ownerId: 'owner-tight', tier: 'free' },
      })

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(200)
      // Both buckets start at 1 after first request → remaining = min(5-1, 5-1) = 4
      expect(res.headers['x-ratelimit-remaining']).toBe('4')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Tenant isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('tenant isolation', () => {
    it('tracks limits per tenant independently', async () => {
      const app = buildApp({
        max: 2,
        getTenantId: (req) => (req.headers['x-tenant'] as string) ?? undefined,
      })

      await request(app).get('/api/ping').set('x-tenant', 'tenant-a')
      await request(app).get('/api/ping').set('x-tenant', 'tenant-a')
      expect((await request(app).get('/api/ping').set('x-tenant', 'tenant-a')).status).toBe(429)

      expect((await request(app).get('/api/ping').set('x-tenant', 'tenant-b')).status).toBe(200)
    })

    it('falls back to IP when no tenant is identified', async () => {
      const app = buildApp({ max: 1 })

      expect((await request(app).get('/api/ping')).status).toBe(200)
      expect((await request(app).get('/api/ping')).status).toBe(429)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Tier-based limits
  // ═══════════════════════════════════════════════════════════════════════════

  describe('tier-based limits', () => {
    it('resolveTierLimit returns correct values', () => {
      const cfg = baseConfig({ maxFree: 10, maxPro: 50, maxEnterprise: 200 })
      expect(resolveTierLimit('free', cfg)).toBe(10)
      expect(resolveTierLimit('pro', cfg)).toBe(50)
      expect(resolveTierLimit('enterprise', cfg)).toBe(200)
    })

    it('uses tier from req.apiKeyRecord', async () => {
      const config: Config['rateLimit'] = {
        enabled: true,
        windowSec: 60,
        maxFree: 1,
        maxPro: 5,
        maxEnterprise: 10,
        failOpen: true,
      }

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as any).apiKeyRecord = { id: 'key-pro', ownerId: 'owner-pro', tier: 'pro' as SubscriptionTier }
        next()
      })
      app.use('/api', createRateLimitMiddleware(config, { namespace: 'ratelimit:tier' }))
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message })
      })

      for (let i = 0; i < 5; i++) {
        expect((await request(app).get('/api/ping')).status).toBe(200)
      }
      expect((await request(app).get('/api/ping')).status).toBe(429)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Fail-open
  // ═══════════════════════════════════════════════════════════════════════════

  describe('fail-open behavior', () => {
    it('should allow traffic when Redis throws and failOpen is true', async () => {
      const spyIncr = vi.spyOn(mockRedis, 'incr').mockRejectedValue(new Error('Redis down'))

      const app = express()
      app.use(express.json())
      app.use(
        '/api',
        createRateLimitMiddleware({
          enabled: true,
          windowSec: 60,
          maxFree: 1,
          maxPro: 1,
          maxEnterprise: 1,
          failOpen: true,
        }, { namespace: 'ratelimit:failopen1' })
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(200)
      expect(res.headers['x-ratelimit-limit']).toBeDefined()
      expect(res.headers['x-ratelimit-remaining']).toBeDefined()
      
      spyIncr.mockRestore()
    })

    it('should return 503 when Redis throws and failOpen is false', async () => {
      const spyIncr = vi.spyOn(mockRedis, 'incr').mockRejectedValue(new Error('Redis down'))

      const app = express()
      app.use(express.json())
      app.use(
        '/api',
        createRateLimitMiddleware({
          enabled: true,
          windowSec: 60,
          maxFree: 1,
          maxPro: 1,
          maxEnterprise: 1,
          failOpen: false,
        }, { namespace: 'ratelimit:failopen2' })
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code })
      })

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(503)
      expect(res.body.error).toMatch(/unavailable/i)
      
      spyIncr.mockRestore()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Prometheus counter
  // ═══════════════════════════════════════════════════════════════════════════

  describe('rate_limit_rejected_total counter', () => {
    it('increments with reason=tenant_limit when tenant bucket is exceeded', async () => {
      const app = buildApp({ max: 1 })

      const before = (await rateLimitRejectedTotal.get()).values
        .filter((v) => v.labels.reason === 'tenant_limit')
        .reduce((sum, v) => sum + v.value, 0)

      await request(app).get('/api/ping') // allowed
      await request(app).get('/api/ping') // rejected

      const after = (await rateLimitRejectedTotal.get()).values
        .filter((v) => v.labels.reason === 'tenant_limit')
        .reduce((sum, v) => sum + v.value, 0)

      expect(after).toBeGreaterThan(before)
    })

    it('increments with reason=key_limit when per-key bucket is exceeded', async () => {
      // Set a high tier limit so the tenant bucket never triggers.
      // The per-key override (max=1) will be the binding constraint.
      // Use a unique ownerId to avoid cross-test counter contamination.
      const config: Config['rateLimit'] = {
        enabled: true,
        windowSec: 60,
        maxFree: 100,
        maxPro: 100,
        maxEnterprise: 100,
        failOpen: true,
      }

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as any).apiKeyRecord = { id: 'key-keylimit-unique', ownerId: 'owner-keylimit-unique', tier: 'free' as SubscriptionTier }
        next()
      })
      app.use('/api', createRateLimitMiddleware(config, {
        namespace: 'ratelimit:keylimit',
        max: 1,
      }))
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code, details: _err.details })
      })

      const before = (await rateLimitRejectedTotal.get()).values
        .filter((v) => v.labels.reason === 'key_limit')
        .reduce((sum, v) => sum + v.value, 0)

      await request(app).get('/api/ping') // allowed (tenant=1≤100, key=1≤1)
      await request(app).get('/api/ping') // rejected: tenant=2≤100 ok, key=2>1 → key_limit

      const after = (await rateLimitRejectedTotal.get()).values
        .filter((v) => v.labels.reason === 'key_limit')
        .reduce((sum, v) => sum + v.value, 0)

      expect(after).toBeGreaterThan(before)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Disabled middleware
  // ═══════════════════════════════════════════════════════════════════════════

  describe('disabled middleware', () => {
    it('passes all requests through when enabled is false', async () => {
      const app = buildApp({ config: { enabled: false } as any, max: 1 })

      for (let i = 0; i < 5; i++) {
        expect((await request(app).get('/api/ping')).status).toBe(200)
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper functions
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getTenantId', () => {
    it('prefers apiKeyRecord.ownerId', () => {
      expect(getTenantId({ apiKeyRecord: { ownerId: 'owner-1' } } as any)).toBe('owner-1')
    })

    it('falls back to user.tenantId', () => {
      expect(getTenantId({ user: { tenantId: 'tenant-1' } } as any)).toBe('tenant-1')
    })

    it('hashes x-api-key when no auth record is present', () => {
      const id = getTenantId({ headers: { 'x-api-key': 'secret-key-123' } } as any)
      expect(id).toMatch(/^ak:/)
      expect(id).not.toContain('secret')
    })

    it('hashes Bearer token when no auth record is present', () => {
      const id = getTenantId({ headers: { authorization: 'Bearer my-token-456' } } as any)
      expect(id).toMatch(/^bt:/)
      expect(id).not.toContain('my-token')
    })

    it('returns undefined when nothing is present', () => {
      expect(getTenantId({ headers: {} } as any)).toBeUndefined()
    })
  })

  describe('getKeyId', () => {
    it('returns apiKeyRecord.id when present', () => {
      expect(getKeyId({ apiKeyRecord: { id: 'key-123' } } as any)).toBe('key-123')
    })

    it('returns undefined when no apiKeyRecord', () => {
      expect(getKeyId({ headers: {} } as any)).toBeUndefined()
    })
  })
})
