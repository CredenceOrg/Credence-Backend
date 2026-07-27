/**
 * @file tests/routes/adminRateLimit.test.ts
 *
 * Tests for GET /api/admin/rate-limit/inspect
 *
 * Covers:
 * ─ 400 when no query params are supplied
 * ─ 400 when both tenantId and ip are supplied
 * ─ 200 response shape for a tenant with an active counter
 * ─ 200 response with count=0 when no Redis key exists
 * ─ Correct key naming (mirrors createRateLimitMiddleware convention)
 * ─ 503 when Redis is unavailable
 * ─ Admin auth gate (401 / 403 without credentials)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createRateLimitAdminRouter, buildWindowKey } from '../../src/routes/admin/rateLimit.js'

// ── In-memory Redis mock ────────────────────────────────────────────────

class MockRedis {
  private store = new Map<string, string>()
  private ttlStore = new Map<string, number>()
  shouldThrow = false

  async get(key: string): Promise<string | null> {
    if (this.shouldThrow) throw new Error('Redis unavailable')
    return this.store.get(key) ?? null
  }

  async ttl(key: string): Promise<number> {
    if (this.shouldThrow) throw new Error('Redis unavailable')
    return this.ttlStore.get(key) ?? -2
  }

  // Test helpers
  set(key: string, value: string, ttl?: number): void {
    this.store.set(key, value)
    if (ttl !== undefined) this.ttlStore.set(key, ttl)
  }

  reset(): void {
    this.store.clear()
    this.ttlStore.clear()
    this.shouldThrow = false
  }
}

const mockRedis = new MockRedis()

vi.mock('../../src/cache/redis.js', () => ({
  RedisConnection: {
    getInstance: () => ({
      getClient: () => mockRedis,
    }),
  },
}))

// ── Auth middleware mock ─────────────────────────────────────────────────────
// By default the test app uses a pass-through that injects an admin user.
// Individual tests can override headers to simulate auth failures.

type AuthBehaviour = 'admin' | 'noAuth' | 'nonAdmin'
let authBehaviour: AuthBehaviour = 'admin'

vi.mock('../../src/middleware/auth.js', () => ({
  requireUserAuth: vi.fn((req: any, res: any, next: any) => {
    if (authBehaviour === 'noAuth') {
      res.status(401).json({ error: 'Unauthorized', message: 'Missing credentials' })
      return
    }
    req.user = {
      id: 'admin-user-1',
      email: 'admin@example.com',
      tenantId: 'tenant-admin',
      role: authBehaviour === 'admin' ? 'admin' : 'user',
    }
    next()
  }),
  requireAdminRole: vi.fn((req: any, res: any, next: any) => {
    if (authBehaviour === 'nonAdmin') {
      res.status(403).json({ error: 'Forbidden', message: 'Admin role required' })
      return
    }
    next()
  }),
}))

// ── App factory ──────────────────────────────────────────────────────────────

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/rate-limit', createRateLimitAdminRouter())
  return app
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const WINDOW_SEC = 60 // matches default config

function currentWindowKey(keyPrefix: string): string {
  const { key } = buildWindowKey('ratelimit:api', keyPrefix, WINDOW_SEC)
  return key
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/admin/rate-limit/inspect', () => {
  let app: Express

  beforeEach(() => {
    mockRedis.reset()
    authBehaviour = 'admin'
    app = buildApp()
  })

  describe('input validation', () => {
    it('returns 400 when no query params are provided', async () => {
      const res = await request(app).get('/api/admin/rate-limit/inspect')
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('InvalidRequest')
      expect(res.body.message).toMatch(/tenantId or ip/)
    })

    it('returns 400 when both tenantId and ip are provided', async () => {
      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ tenantId: 'tenant-1', ip: '127.0.0.1' })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('InvalidRequest')
      expect(res.body.message).toMatch(/not both/)
    })
  })

  describe('successful inspection by tenantId', () => {
    it('returns 200 with correct shape', async () => {
      const tenantId = 'tenant-abc'
      const key = currentWindowKey(`tenant:${tenantId}`)
      mockRedis.set(key, '42', 47)

      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ tenantId })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toMatchObject({
        key,
        count: 42,
        remaining: expect.any(Number),
        resetAt: expect.any(Number),
        ttl: 47,
        windowSec: WINDOW_SEC,
      })
    })

    it('includes the tenant key prefix in the returned key', async () => {
      const tenantId = 'tenant-xyz'
      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ tenantId })

      expect(res.status).toBe(200)
      expect(res.body.data.key).toContain(`tenant:${tenantId}`)
    })

    it('returns count=0 and ttl=0 when no Redis key exists for the tenant', async () => {
      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ tenantId: 'new-tenant' })

      expect(res.status).toBe(200)
      expect(res.body.data.count).toBe(0)
      expect(res.body.data.ttl).toBe(0)
    })

    it('calculates remaining correctly (limit - count)', async () => {
      const tenantId = 'tenant-full'
      const key = currentWindowKey(`tenant:${tenantId}`)
      mockRedis.set(key, '80', 30)

      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ tenantId })

      expect(res.status).toBe(200)
      const { count, remaining, limit } = res.body.data
      expect(count + remaining).toBe(limit)
    })

    it('clamps remaining to 0 when count exceeds limit', async () => {
      const tenantId = 'tenant-over'
      const key = currentWindowKey(`tenant:${tenantId}`)
      mockRedis.set(key, '150', 10)

      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ tenantId })

      expect(res.status).toBe(200)
      expect(res.body.data.remaining).toBe(0)
    })
  })

  describe('successful inspection by ip', () => {
    it('returns 200 with ip key prefix', async () => {
      const ip = '10.0.0.1'
      const key = currentWindowKey(`ip:${ip}`)
      mockRedis.set(key, '5', 55)

      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ ip })

      expect(res.status).toBe(200)
      expect(res.body.data.key).toContain(`ip:${ip}`)
      expect(res.body.data.count).toBe(5)
    })
  })

  describe('error handling', () => {
    it('returns 503 when Redis throws', async () => {
      mockRedis.shouldThrow = true

      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ tenantId: 'tenant-1' })

      expect(res.status).toBe(503)
      expect(res.body.error).toBe('ServiceUnavailable')
    })
  })

  describe('authentication and authorisation', () => {
    it('returns 401 when no credentials are provided', async () => {
      authBehaviour = 'noAuth'

      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ tenantId: 'tenant-1' })

      expect(res.status).toBe(401)
    })

    it('returns 403 when a non-admin user calls the endpoint', async () => {
      authBehaviour = 'nonAdmin'

      const res = await request(app)
        .get('/api/admin/rate-limit/inspect')
        .query({ tenantId: 'tenant-1' })

      expect(res.status).toBe(403)
    })
  })
})

// ── Unit tests for buildWindowKey ───────────────────────────────────────────

describe('buildWindowKey', () => {
  it('aligns the window start to a multiple of windowSec', () => {
    const windowSec = 60
    const nowSec = 1720000047 // 47 seconds into a window
    const { key, windowStart } = buildWindowKey('ratelimit:api', 'tenant:t1', windowSec, nowSec)

    expect(windowStart % windowSec).toBe(0)
    expect(key).toBe(`ratelimit:api:tenant:t1:${windowStart}`)
  })

  it('sets resetAt to windowStart + windowSec', () => {
    const windowSec = 60
    const nowSec = 1720000047
    const { windowStart, resetAt } = buildWindowKey('ratelimit:api', 'tenant:t1', windowSec, nowSec)

    expect(resetAt).toBe(windowStart + windowSec)
  })

  it('produces the same key as the middleware for the same window', () => {
    const windowSec = 60
    const nowSec = 1720000000
    const { key } = buildWindowKey('ratelimit:api', 'tenant:abc', windowSec, nowSec)

    // Mirror the middleware formula
    const windowStart = nowSec - (nowSec % windowSec)
    expect(key).toBe(`ratelimit:api:tenant:abc:${windowStart}`)
  })
})
