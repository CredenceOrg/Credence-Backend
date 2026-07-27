/**
 * Integration tests for tenant-level rate limiting on auth login / refresh routes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express, type Request } from 'express'
import request from 'supertest'
import { createAuthRouter } from '../../src/routes/auth.js'
import type { AuthRateLimitConfig } from '../../src/middleware/authRateLimit.js'
import { resolveAuthTenantId } from '../../src/middleware/authRateLimit.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'

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

  reset(): void {
    this.store.clear()
  }
}

const mockRedis = new MockRedis()

vi.mock('../../src/cache/redis.js', () => ({
  RedisConnection: {
    getInstance: () => ({ getClient: () => mockRedis }),
  },
}))

function baseAuthConfig(overrides: Partial<AuthRateLimitConfig> = {}): AuthRateLimitConfig {
  return {
    enabled: true,
    windowSec: 60,
    maxPerTenant: 3,
    failOpen: true,
    ...overrides,
  }
}

function buildApp(config: AuthRateLimitConfig = baseAuthConfig()): Express {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', createAuthRouter(config))
  app.use(errorHandler)
  return app
}

const loginPayload = {
  email: 'user@example.com',
  password: 'secret',
  tenantId: 'tenant-a',
}

const refreshPayload = {
  refreshToken: 'rt_test_token',
  tenantId: 'tenant-a',
}

describe('Auth route rate limiting', () => {
  beforeEach(() => {
    mockRedis.reset()
  })

  describe('resolveAuthTenantId', () => {
    it('prefers X-Tenant-Id over body tenantId', () => {
      const req = {
        headers: { 'x-tenant-id': 'from-header' },
        body: { tenantId: 'from-body' },
      } as Request

      expect(resolveAuthTenantId(req)).toBe('from-header')
    })

    it('reads tenantId from JSON body when header is absent', () => {
      const req = {
        headers: {},
        body: { tenantId: 'from-body' },
      } as Request

      expect(resolveAuthTenantId(req)).toBe('from-body')
    })
  })

  describe('response headers', () => {
    it('includes X-RateLimit-* headers on successful login attempts', async () => {
      const app = buildApp()
      const res = await request(app).post('/api/auth/login').send(loginPayload)

      expect(res.status).toBe(401)
      expect(res.headers['x-ratelimit-limit']).toBe('3')
      expect(res.headers['x-ratelimit-remaining']).toBe('2')
      expect(res.headers['x-ratelimit-reset']).toBeDefined()
    })

    it('includes X-RateLimit-* headers on refresh attempts', async () => {
      const app = buildApp()
      const res = await request(app).post('/api/auth/refresh').send(refreshPayload)

      expect(res.status).toBe(401)
      expect(res.headers['x-ratelimit-limit']).toBe('3')
      expect(res.headers['x-ratelimit-remaining']).toBe('2')
    })
  })

  describe('tenant isolation', () => {
    it('tracks login limits independently per tenant', async () => {
      const app = buildApp()

      for (let i = 0; i < 3; i++) {
        const ok = await request(app)
          .post('/api/auth/login')
          .set('X-Tenant-Id', 'tenant-one')
          .send({ ...loginPayload, tenantId: 'tenant-one' })
        expect(ok.status).toBe(401)
      }

      const blocked = await request(app)
        .post('/api/auth/login')
        .set('X-Tenant-Id', 'tenant-one')
        .send({ ...loginPayload, tenantId: 'tenant-one' })
      expect(blocked.status).toBe(429)
      expect(blocked.headers['retry-after']).toBeDefined()

      const otherTenant = await request(app)
        .post('/api/auth/login')
        .set('X-Tenant-Id', 'tenant-two')
        .send({ ...loginPayload, tenantId: 'tenant-two' })
      expect(otherTenant.status).toBe(401)
      expect(otherTenant.headers['x-ratelimit-remaining']).toBe('2')
    })

    it('shares the same tenant bucket between login and refresh', async () => {
      const app = buildApp()

      await request(app)
        .post('/api/auth/login')
        .set('X-Tenant-Id', 'shared-tenant')
        .send({ ...loginPayload, tenantId: 'shared-tenant' })
      await request(app)
        .post('/api/auth/login')
        .set('X-Tenant-Id', 'shared-tenant')
        .send({ ...loginPayload, tenantId: 'shared-tenant' })

      const refresh = await request(app)
        .post('/api/auth/refresh')
        .set('X-Tenant-Id', 'shared-tenant')
        .send({ ...refreshPayload, tenantId: 'shared-tenant' })

      expect(refresh.status).toBe(401)
      expect(refresh.headers['x-ratelimit-remaining']).toBe('0')

      const blocked = await request(app)
        .post('/api/auth/refresh')
        .set('X-Tenant-Id', 'shared-tenant')
        .send({ ...refreshPayload, tenantId: 'shared-tenant' })
      expect(blocked.status).toBe(429)
    })
  })

  describe('429 responses', () => {
    it('returns standardized rate limit error body on login', async () => {
      const app = buildApp()

      for (let i = 0; i < 3; i++) {
        await request(app).post('/api/auth/login').send(loginPayload)
      }

      const res = await request(app).post('/api/auth/login').send(loginPayload)
      expect(res.status).toBe(429)
      expect(res.body.code).toBe('rate_limit_exceeded')
      expect(res.headers['x-ratelimit-remaining']).toBe('0')
      expect(res.headers['retry-after']).toBeDefined()
    })
  })
})
