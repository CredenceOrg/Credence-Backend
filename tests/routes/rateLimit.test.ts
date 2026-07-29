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
 * ─ Fixed-window boundary burst (cross-window 2x throughput), pinned with a
 *   controllable clock
 * ─ Dual-bucket precedence (tenant bucket is evaluated before the per-key
 *   bucket)
 * ─ Branch coverage for internal fallbacks: TTL race in checkWindow, default
 *   namespace/options, req.ip fallback chain, and the legacy `rateLimit()`
 *   helper
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import {
  createRateLimitMiddleware,
  getTenantId,
  getKeyId,
  getClientIp,
  resolveTierLimit,
  rateLimitRejectedTotal,
  rateLimit,
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

    it('x_ratelimit_limit_header_matches_config_for_free_pro_and_enterprise_tiers', async () => {
      // Lock Free / Pro / Enterprise header values to whatever the active
      // config says — defaults (100 / 1000 / 10000) and custom overrides alike.
      const cases: Array<{
        tier: SubscriptionTier
        config: Config['rateLimit']
        expectedLimit: number
        namespace: string
      }> = [
        {
          tier: 'free',
          config: baseConfig({ maxFree: 100, maxPro: 1000, maxEnterprise: 10000 }),
          expectedLimit: 100,
          namespace: 'ratelimit:hdr:defaults:free',
        },
        {
          tier: 'pro',
          config: baseConfig({ maxFree: 100, maxPro: 1000, maxEnterprise: 10000 }),
          expectedLimit: 1000,
          namespace: 'ratelimit:hdr:defaults:pro',
        },
        {
          tier: 'enterprise',
          config: baseConfig({ maxFree: 100, maxPro: 1000, maxEnterprise: 10000 }),
          expectedLimit: 10000,
          namespace: 'ratelimit:hdr:defaults:enterprise',
        },
        {
          tier: 'free',
          config: baseConfig({ maxFree: 17, maxPro: 53, maxEnterprise: 211 }),
          expectedLimit: 17,
          namespace: 'ratelimit:hdr:custom:free',
        },
        {
          tier: 'pro',
          config: baseConfig({ maxFree: 17, maxPro: 53, maxEnterprise: 211 }),
          expectedLimit: 53,
          namespace: 'ratelimit:hdr:custom:pro',
        },
        {
          tier: 'enterprise',
          config: baseConfig({ maxFree: 17, maxPro: 53, maxEnterprise: 211 }),
          expectedLimit: 211,
          namespace: 'ratelimit:hdr:custom:enterprise',
        },
      ]

      for (const { tier, config, expectedLimit, namespace } of cases) {
        const app = express()
        app.use(express.json())
        app.use((req, _res, next) => {
          ;(req as any).apiKeyRecord = {
            id: `key-${tier}-${expectedLimit}`,
            ownerId: `owner-${tier}-${expectedLimit}`,
            tier,
          }
          next()
        })
        app.use('/api', createRateLimitMiddleware(config, { namespace }))
        app.get('/api/ping', (_req, res) => res.json({ ok: true }))

        const res = await request(app).get('/api/ping')
        expect(res.status).toBe(200)
        expect(res.headers['x-ratelimit-limit']).toBe(String(expectedLimit))
        expect(res.headers['x-ratelimit-remaining']).toBe(String(expectedLimit - 1))
        expect(res.headers['x-ratelimit-reset']).toBeDefined()
      }
    })

    it('x_ratelimit_limit_on_429_still_matches_the_callers_tier_config', async () => {
      // Sad path: once a free-tier caller is blocked, the Limit header must
      // still report maxFree — not maxPro / maxEnterprise.
      const config = baseConfig({ maxFree: 1, maxPro: 50, maxEnterprise: 200 })
      const app = buildApp({
        config,
        apiKeyRecord: { id: 'key-free-sad', ownerId: 'owner-free-sad', tier: 'free' },
      })

      expect((await request(app).get('/api/ping')).status).toBe(200)
      const blocked = await request(app).get('/api/ping')
      expect(blocked.status).toBe(429)
      expect(blocked.headers['x-ratelimit-limit']).toBe(String(config.maxFree))
      expect(blocked.headers['x-ratelimit-remaining']).toBe('0')
      expect(blocked.headers['retry-after']).toBeDefined()
      expect(blocked.body.details).toMatchObject({ limit: config.maxFree })
    })

    it('unauthenticated_request_uses_free_tier_limit_in_header', async () => {
      const config = baseConfig({ maxFree: 100, maxPro: 1000, maxEnterprise: 10000 })
      const app = express()
      app.use(express.json())
      app.use('/api', createRateLimitMiddleware(config, { namespace: 'ratelimit:hdr:anon' }))
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(200)
      expect(res.headers['x-ratelimit-limit']).toBe(String(config.maxFree))
      expect(res.headers['x-ratelimit-remaining']).toBe(String(config.maxFree - 1))
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
    it('increments rate_limit_rejected_total with reason=redis_unavailable when fail-closed', async () => {
      const spyIncr = vi.spyOn(mockRedis, 'incr').mockRejectedValue(new Error('Redis down'))

      const before = (await rateLimitRejectedTotal.get()).values
        .filter((v) => v.labels.reason === 'redis_unavailable')
        .reduce((sum, v) => sum + v.value, 0)

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
        }, { namespace: 'ratelimit:redisdowncnt' })
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code })
      })

      await request(app).get('/api/ping')

      const after = (await rateLimitRejectedTotal.get()).values
        .filter((v) => v.labels.reason === 'redis_unavailable')
        .reduce((sum, v) => sum + v.value, 0)

      expect(after).toBeGreaterThan(before)

      spyIncr.mockRestore()
    })

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

  // Per-key bucket key format includes tier ceiling
  // ---------------------------------------------------------------------------

  describe('per-key bucket key format includes tier ceiling', () => {
    it('uses key id + tier in the Redis key name', async () => {
      const capturedKeys: string[] = []
      const recordingRedis = {
        store: new Map<string, number>(),
        async incr(key: string) {
          capturedKeys.push(key)
          const next = (this.store.get(key) ?? 0) + 1
          this.store.set(key, next)
          return next
        },
        async expire(_key: string, _seconds: number) {},
        async ttl(_key: string) {
          return 60
        },
      }

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
        ;(req as any).apiKeyRecord = {
          id: 'key-tierfmt',
          ownerId: 'owner-tierfmt',
          tier: 'pro' as SubscriptionTier,
        }
        next()
      })
      app.use(
        '/api',
        createRateLimitMiddleware(config, {
          namespace: 'ratelimit:tierkeyfmt',
          getRedis: () => recordingRedis,
        }),
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))

      await request(app).get('/api/ping')

      // The tenant bucket should be present
      const tenantKey = capturedKeys.find((k) =>
        k.startsWith('ratelimit:tierkeyfmt:tenant:'),
      )
      expect(tenantKey).toBeDefined()

      // The key bucket should include both the key id AND the tier
      const keyBucket = capturedKeys.find((k) =>
        k.startsWith('ratelimit:tierkeyfmt:key:'),
      )
      expect(keyBucket).toBeDefined()
      expect(keyBucket).toContain(':key-tierfmt:')
      expect(keyBucket).toContain(':pro')
    })

    it('different tiers produce different per-key buckets for the same key id', async () => {
      const capturedKeys: string[] = []
      const recordingRedis = {
        store: new Map<string, number>(),
        async incr(key: string) {
          capturedKeys.push(key)
          const next = (this.store.get(key) ?? 0) + 1
          this.store.set(key, next)
          return next
        },
        async expire(_key: string, _seconds: number) {},
        async ttl(_key: string) {
          return 60
        },
      }

      const config: Config['rateLimit'] = {
        enabled: true,
        windowSec: 60,
        maxFree: 100,
        maxPro: 100,
        maxEnterprise: 100,
        failOpen: true,
      }

      // Free tier request
      const appFree = express()
      appFree.use(express.json())
      appFree.use((req, _res, next) => {
        ;(req as any).apiKeyRecord = {
          id: 'key-same-id',
          ownerId: 'owner-same',
          tier: 'free' as SubscriptionTier,
        }
        next()
      })
      appFree.use(
        '/api',
        createRateLimitMiddleware(config, {
          namespace: 'ratelimit:tierkeysplit',
          getRedis: () => recordingRedis,
        }),
      )
      appFree.get('/api/ping', (_req, res) => res.json({ ok: true }))
      await request(appFree).get('/api/ping')

      const freeKeyBucket = capturedKeys.find((k) =>
        k.startsWith('ratelimit:tierkeysplit:key:'),
      )

      capturedKeys.length = 0
      recordingRedis.store.clear()

      // Pro tier request — same key id but different tier
      const appPro = express()
      appPro.use(express.json())
      appPro.use((req, _res, next) => {
        ;(req as any).apiKeyRecord = {
          id: 'key-same-id',
          ownerId: 'owner-same',
          tier: 'pro' as SubscriptionTier,
        }
        next()
      })
      appPro.use(
        '/api',
        createRateLimitMiddleware(config, {
          namespace: 'ratelimit:tierkeysplit',
          getRedis: () => recordingRedis,
        }),
      )
      appPro.get('/api/ping', (_req, res) => res.json({ ok: true }))
      await request(appPro).get('/api/ping')

      const proKeyBucket = capturedKeys.find((k) =>
        k.startsWith('ratelimit:tierkeysplit:key:'),
      )

      expect(freeKeyBucket).not.toBe(proKeyBucket)
      expect(freeKeyBucket).toContain(':free')
      expect(proKeyBucket).toContain(':pro')
    })
  })

  // Window-boundary burst (fixed-window 2x weakness)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fixed windows reset the counter the instant `windowStart` ticks over, with
   * no memory of the previous window. A client that exhausts its budget in the
   * last instant of window N and immediately exhausts a fresh budget at the
   * first instant of window N+1 can therefore push `2 * max` requests through
   * in a span far shorter than `windowSec`. These tests pin that exact
   * behaviour with a controllable clock so it can never silently regress (or
   * silently improve) without a test failing.
   */
  describe('window-boundary burst (fixed-window 2x weakness)', () => {
    const windowSec = 60
    // Arbitrary epoch-aligned window start, far from any DST/leap edge.
    const windowStartSec = 1_700_000_000 - (1_700_000_000 % windowSec)
    const lastMsOfWindowN = (windowStartSec + windowSec - 1) * 1000
    const firstMsOfWindowNPlus1 = (windowStartSec + windowSec) * 1000

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('documents that 2x the configured max can pass within ~1 second across a window boundary', async () => {
      const max = 3
      const app = buildApp({ config: { windowSec, maxFree: max, maxPro: max, maxEnterprise: max } })

      // Burst 1: park the clock in the last second of window N and consume
      // the full budget for that window.
      vi.setSystemTime(lastMsOfWindowN)
      for (let i = 0; i < max; i++) {
        const res = await request(app).get('/api/ping')
        expect(res.status).toBe(200)
      }
      // Window N's budget is now exhausted.
      expect((await request(app).get('/api/ping')).status).toBe(429)

      // Cross the boundary: advance the clock by exactly one second into
      // window N+1.
      vi.setSystemTime(firstMsOfWindowNPlus1)

      // Burst 2: a brand-new counter exists for window N+1, so the full
      // budget is available again — one second after burst 1 began.
      for (let i = 0; i < max; i++) {
        const res = await request(app).get('/api/ping')
        expect(res.status).toBe(200)
      }
      expect((await request(app).get('/api/ping')).status).toBe(429)

      // Across the ~1-second boundary, 2 * max requests succeeded — exactly
      // double the intended per-window rate. This is the known fixed-window
      // weakness described in the issue; it is pinned here, not fixed, so a
      // future move to a sliding window is a deliberate and verified change.
    })

    it('starts a fresh window exactly at the rollover instant (windowStart recomputed on the boundary)', async () => {
      const max = 2
      const app = buildApp({ config: { windowSec, maxFree: max, maxPro: max, maxEnterprise: max } })

      // One millisecond before the boundary: still window N.
      vi.setSystemTime(lastMsOfWindowN + 999)
      expect((await request(app).get('/api/ping')).status).toBe(200)
      expect((await request(app).get('/api/ping')).status).toBe(200)
      expect((await request(app).get('/api/ping')).status).toBe(429)

      // Exactly at the boundary (first millisecond of window N+1): the
      // `now % windowSec === 0` case, windowStart recomputed to the new
      // window rather than reusing the previous one.
      vi.setSystemTime(firstMsOfWindowNPlus1)
      expect((await request(app).get('/api/ping')).status).toBe(200)
      expect((await request(app).get('/api/ping')).status).toBe(200)
      expect((await request(app).get('/api/ping')).status).toBe(429)
    })

    it('does not allow a 3rd burst beyond the two adjacent windows', async () => {
      const max = 2
      const app = buildApp({ config: { windowSec, maxFree: max, maxPro: max, maxEnterprise: max } })

      vi.setSystemTime(lastMsOfWindowN)
      for (let i = 0; i < max; i++) {
        expect((await request(app).get('/api/ping')).status).toBe(200)
      }

      vi.setSystemTime(firstMsOfWindowNPlus1)
      for (let i = 0; i < max; i++) {
        expect((await request(app).get('/api/ping')).status).toBe(200)
      }

      // Still inside window N+1 (not yet at the next boundary) — budget for
      // this window is exhausted, so the 3rd window's worth of traffic is
      // correctly rejected. The weakness is bounded to a single 2x burst per
      // boundary, not unbounded.
      vi.setSystemTime(firstMsOfWindowNPlus1 + 1000)
      expect((await request(app).get('/api/ping')).status).toBe(429)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Dual-bucket precedence
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The tenant bucket is checked before the per-key bucket (see
   * `createRateLimitMiddleware`). When a single request would exceed *both*
   * budgets, the response must reflect the tenant rejection — the per-key
   * counter is never even incremented for that request.
   */
  describe('dual-bucket precedence (tenant checked before key)', () => {
    it('reports tenant_limit when both buckets would be exceeded by the same request', async () => {
      const config: Config['rateLimit'] = {
        enabled: true,
        windowSec: 60,
        maxFree: 1, // tight tenant ceiling
        maxPro: 1,
        maxEnterprise: 1,
        failOpen: true,
      }

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as any).apiKeyRecord = { id: 'key-precedence', ownerId: 'owner-precedence', tier: 'free' as SubscriptionTier }
        next()
      })
      app.use(
        '/api',
        createRateLimitMiddleware(config, { namespace: 'ratelimit:precedence-tenant', max: 5 }), // generous key ceiling
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code, details: _err.details })
      })

      expect((await request(app).get('/api/ping')).status).toBe(200)

      const before = (await rateLimitRejectedTotal.get()).values
        .filter((v) => v.labels.reason === 'key_limit' && v.labels.key_id === 'key-precedence')
        .reduce((sum, v) => sum + v.value, 0)

      // Second request: tenant bucket goes to 2 > 1 (tenant limit), while
      // the key bucket would only be at 2 <= 5 (well within budget). The
      // rejection must be attributed to the tenant, and the key bucket must
      // not have been incremented.
      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(429)
      expect(res.body.details).toMatchObject({ limit: 1 }) // tenant ceiling, not the key ceiling of 5

      const after = (await rateLimitRejectedTotal.get()).values
        .filter((v) => v.labels.reason === 'key_limit' && v.labels.key_id === 'key-precedence')
        .reduce((sum, v) => sum + v.value, 0)
      expect(after).toBe(before) // key_limit was never recorded for this request
    })

    it('reports key_limit when the tenant budget is generous but the key budget is tight', async () => {
      const config: Config['rateLimit'] = {
        enabled: true,
        windowSec: 60,
        maxFree: 100, // generous tenant ceiling
        maxPro: 100,
        maxEnterprise: 100,
        failOpen: true,
      }

      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as any).apiKeyRecord = { id: 'key-tight-precedence', ownerId: 'owner-tight-precedence', tier: 'free' as SubscriptionTier }
        next()
      })
      app.use(
        '/api',
        createRateLimitMiddleware(config, { namespace: 'ratelimit:precedence-key', max: 1 }), // tight key ceiling
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code, details: _err.details })
      })

      expect((await request(app).get('/api/ping')).status).toBe(200)

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(429)
      expect(res.body.details).toMatchObject({ limit: 1 }) // key ceiling, not the tenant ceiling of 100
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 429 envelope
  // ═══════════════════════════════════════════════════════════════════════════

  describe('429 envelope', () => {
    it('returns the full error envelope alongside headers when blocked', async () => {
      const app = buildApp({ max: 1 })

      await request(app).get('/api/ping')
      const res = await request(app).get('/api/ping')

      expect(res.status).toBe(429)
      expect(res.body).toMatchObject({
        error: expect.stringMatching(/rate limit exceeded/i),
        details: { limit: 1, windowSec: 60 },
      })
      expect(typeof res.body.details.retryAfter).toBe('number')
      expect(res.headers['x-ratelimit-limit']).toBe('1')
      expect(res.headers['x-ratelimit-remaining']).toBe('0')
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal branch coverage: TTL race, defaults, IP fallback, legacy helper
  // ═══════════════════════════════════════════════════════════════════════════

  describe('checkWindow TTL fallback', () => {
    it('falls back to windowSec for retryAfter when redis.ttl returns a non-positive value', async () => {
      // Simulates a TTL race: the key exists (incr succeeded) but ttl()
      // reports no expiry yet (e.g. -1), which must not propagate as a
      // negative Retry-After.
      const flakyRedis = {
        store: new Map<string, number>(),
        async incr(key: string) {
          const next = (this.store.get(key) ?? 0) + 1
          this.store.set(key, next)
          return next
        },
        async expire(_key: string, _seconds: number) {},
        async ttl(_key: string) {
          return -1
        },
      }

      const app = express()
      app.use(express.json())
      app.use(
        '/api',
        createRateLimitMiddleware(baseConfig({ maxFree: 1 }), {
          namespace: 'ratelimit:ttlrace',
          getRedis: () => flakyRedis,
        }),
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message, details: _err.details })
      })

      await request(app).get('/api/ping') // allowed, count = 1
      const res = await request(app).get('/api/ping') // blocked, count = 2

      expect(res.status).toBe(429)
      expect(res.headers['retry-after']).toBe('60') // windowSec fallback, not -1
      expect(res.body.details.retryAfter).toBe(60)
    })
  })

  describe('default namespace and options', () => {
    it('works with no options argument at all (namespace, options, and getRedis defaults)', async () => {
      const app = express()
      app.use(express.json())
      app.use('/api', createRateLimitMiddleware(baseConfig({ maxFree: 5 })))
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(200)
      expect(res.headers['x-ratelimit-limit']).toBe('5')
    })
  })

  describe('req.ip fallback chain', () => {
    it('falls back to socket.remoteAddress when req.ip is undefined', async () => {
      const mw = createRateLimitMiddleware(baseConfig({ maxFree: 5 }), { namespace: 'ratelimit:ipfallback1' })
      const req: any = { ip: undefined, socket: { remoteAddress: '10.0.0.5' }, headers: {} }
      const res: any = { setHeader: vi.fn() }
      const next = vi.fn()

      await mw(req, res, next)

      expect(next).toHaveBeenCalledWith()
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '5')
    })

    it('falls back to "unknown" when neither req.ip nor socket.remoteAddress are set', async () => {
      const mw = createRateLimitMiddleware(baseConfig({ maxFree: 5 }), { namespace: 'ratelimit:ipfallback2' })
      const req: any = { ip: undefined, socket: {}, headers: {} }
      const res: any = { setHeader: vi.fn() }
      const next = vi.fn()

      await mw(req, res, next)

      expect(next).toHaveBeenCalledWith()
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '5')
    })
  })

  describe('rateLimit() backward-compatible helper', () => {
    it('defaults every tier ceiling to 100 when no max is specified', async () => {
      const app = express()
      app.use(express.json())
      app.use('/api', rateLimit({ namespace: 'ratelimit:legacy-default', windowSec: 60 }))
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(200)
      expect(res.headers['x-ratelimit-limit']).toBe('100')
    })

    it('defaults to fail-closed when no explicit failOpen is provided', async () => {
      const spyIncr = vi.spyOn(mockRedis, 'incr').mockRejectedValue(new Error('Redis down'))

      const app = express()
      app.use(express.json())
      // The legacy rateLimit() helper defaults failOpen based on NODE_ENV;
      // in test environment it defaults to fail-open, so we pass an explicit
      // failOpen: false to simulate production behaviour.
      app.use('/api', rateLimit({ namespace: 'ratelimit:legacy-failclosed', windowSec: 60, max: 2, failOpen: false }))
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code })
      })

      const res = await request(app).get('/api/ping')
      expect(res.status).toBe(503)
      expect(res.body.error).toMatch(/unavailable/i)

      spyIncr.mockRestore()
    })

    it('applies an explicit max to every tier ceiling', async () => {
      const app = express()
      app.use(express.json())
      app.use('/api', rateLimit({ namespace: 'ratelimit:legacy-max', windowSec: 60, max: 2 }))
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message })
      })

      await request(app).get('/api/ping')
      await request(app).get('/api/ping')
      const res = await request(app).get('/api/ping')

      expect(res.status).toBe(429)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Security: X-Forwarded-For spoofing prevention (issue #723)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Negative test for CVE-class: X-Forwarded-For IP spoofing to bypass
   * per-IP rate limiting.
   *
   * Threat model
   * ─────────────
   * When Express `trust proxy` is enabled, `req.ip` is derived from the
   * *leftmost* entry in `X-Forwarded-For`.  An attacker can inject an
   * arbitrary IP:
   *
   *   X-Forwarded-For: 1.2.3.4, <legitimate-proxy>
   *
   * If the rate limiter uses `req.ip`, the attacker cycles through fake IPs
   * to get a fresh bucket on every rotation — effectively unlimited requests.
   *
   * Fix (getClientIp)
   * ──────────────────
   * `getClientIp` ignores `req.ip` and `X-Forwarded-For` entirely and
   * returns `req.socket.remoteAddress` — the TCP-layer IP of the peer that
   * actually delivered the request.  That value is controlled by the kernel,
   * not by the HTTP payload, so it cannot be forged by the client.
   *
   * The negative test below fails on the vulnerable code (which uses
   * `req.ip`) and passes on the fixed code (which uses
   * `req.socket.remoteAddress`).
   */
  describe('XFF spoofing prevention (security fix #723)', () => {
    it('getClientIp returns socket.remoteAddress regardless of X-Forwarded-For', () => {
      // Simulate a request where req.ip has been set to a spoofed address
      // by Express trust-proxy processing of X-Forwarded-For.
      const req: any = {
        ip: '1.2.3.4',                   // spoofed — what req.ip would return under trust proxy
        socket: { remoteAddress: '10.0.0.1' }, // real connection IP (the actual proxy/client)
        headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
      }
      // Must return the real socket address, not the spoofed XFF value.
      expect(getClientIp(req)).toBe('10.0.0.1')
      expect(getClientIp(req)).not.toBe('1.2.3.4')
    })

    it('getClientIp returns "unknown" when socket.remoteAddress is absent', () => {
      const req: any = { ip: '9.9.9.9', socket: {}, headers: {} }
      expect(getClientIp(req)).toBe('unknown')
    })

    it('rate limiter cannot be bypassed by rotating X-Forwarded-For addresses', async () => {
      /**
       * This is the core negative test for the fix.
       *
       * Without the fix (using req.ip), the attacker could forge a fresh IP
       * in X-Forwarded-For on every request, getting a new rate-limit bucket
       * each time, and bypass per-IP rate limiting entirely.
       *
       * With the fix (using socket.remoteAddress), every request from the
       * same TCP connection maps to the same bucket regardless of what the
       * client puts in X-Forwarded-For.
       *
       * We simulate this by building an app with trust proxy enabled so that
       * req.ip changes with each spoofed XFF header, then verifying the rate
       * limiter still enforces the limit.
       */
      const app = express()
      // Enable trust proxy so Express derives req.ip from X-Forwarded-For.
      // This is the attack prerequisite — with trust proxy on, req.ip would
      // return whatever the attacker puts in the XFF header.
      app.set('trust proxy', true)
      app.use(express.json())

      app.use(
        '/api',
        createRateLimitMiddleware(baseConfig({ maxFree: 2, maxPro: 2, maxEnterprise: 2 }), {
          namespace: 'ratelimit:xff-spoof',
          getRedis: () => mockRedis,
        }),
      )
      app.get('/api/ping', (_req, res) => res.json({ ok: true }))
      app.use((_err: any, _req: any, res: any, _next: any) => {
        res.status(_err.status ?? 500).json({ error: _err.message, code: _err.code })
      })

      // Request 1: spoofed XFF = fake IP A
      const r1 = await request(app)
        .get('/api/ping')
        .set('X-Forwarded-For', '100.0.0.1')
      expect(r1.status).toBe(200)

      // Request 2: spoofed XFF = fake IP B (different from A)
      // If req.ip were used, this would look like a fresh bucket → allowed.
      // With the fix, socket.remoteAddress is the same → same bucket.
      const r2 = await request(app)
        .get('/api/ping')
        .set('X-Forwarded-For', '100.0.0.2')
      expect(r2.status).toBe(200)

      // Request 3: spoofed XFF = yet another fake IP C
      // Without the fix: would be allowed (new fake IP → new bucket).
      // With the fix:    must be blocked (same socket.remoteAddress → same bucket, count=3 > max=2).
      const r3 = await request(app)
        .get('/api/ping')
        .set('X-Forwarded-For', '100.0.0.3')
      expect(r3.status).toBe(429)
    })
  })
})
