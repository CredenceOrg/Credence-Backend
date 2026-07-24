import { describe, it, expect, beforeEach } from 'vitest'
import { Request, Response, NextFunction } from 'express'
import {
  tenantContextMiddleware,
  requireTenant,
  getTenantId,
  isValidTenantId,
  configureTenantContext,
} from '../tenantContext.js'

interface TestRequest extends Request {
  user?: {
    id: string
    tenantId: string
    email: string
    role: string
  }
  tenantId?: string
  path: string
}

interface TestResponse extends Response {
  statusCode: number
  jsonData?: any
  status: (code: number) => TestResponse
  json: (data: any) => void
}

function createMockResponse(): TestResponse {
  const res: any = {}
  res.statusCode = 200
  res.status = (code: number) => {
    res.statusCode = code
    return res
  }
  res.json = (data: any) => {
    res.jsonData = data
  }
  return res
}

beforeEach(() => {
  configureTenantContext({
    allowHeaderFallback: false,
    allowDefaultTenant: false,
    tenantScopedRoutes: ['/api/tenant/:id/.*', '/api/orgs/:id/.*'],
    requiredOnScoped: true,
  })
})

describe('tenantContext middleware', () => {
  describe('isValidTenantId', () => {
    it('accepts valid tenant IDs', () => {
      expect(isValidTenantId('tenant-1')).toBe(true)
      expect(isValidTenantId('my-org')).toBe(true)
      expect(isValidTenantId('ABC123')).toBe(true)
      expect(isValidTenantId('a')).toBe(true)
    })

    it('rejects invalid tenant IDs', () => {
      expect(isValidTenantId('-tenant')).toBe(false)
      expect(isValidTenantId('tenant-')).toBe(false)
      expect(isValidTenantId('tenant_id')).toBe(false)
      expect(isValidTenantId('tenant id')).toBe(false)
      expect(isValidTenantId('')).toBe(false)
    })

    it('rejects tenant IDs longer than 255 characters', () => {
      const longId = 'a'.repeat(256)
      expect(isValidTenantId(longId)).toBe(false)
    })
  })

  describe('tenantContextMiddleware', () => {
    it('derives tenant from authenticated principal', () => {
      const req: TestRequest = {
        headers: {},
        path: '/api/users',
        user: {
          id: 'user-1',
          tenantId: 'tenant-from-auth',
          email: 'user@example.com',
          role: 'admin',
        },
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(req.tenantId).toBe('tenant-from-auth')
    })

    it('rejects malformed tenant ID from principal', () => {
      const req: TestRequest = {
        headers: {},
        path: '/api/users',
        user: {
          id: 'user-1',
          tenantId: 'invalid_tenant',
          email: 'user@example.com',
          role: 'admin',
        },
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(res.statusCode).toBe(400)
      expect(res.jsonData?.message).toContain('Invalid tenant context')
    })

    it('uses header fallback when configured and principal has no tenant', () => {
      configureTenantContext({ allowHeaderFallback: true })

      const req: TestRequest = {
        headers: { 'x-tenant-id': 'tenant-from-header' },
        path: '/api/users',
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(req.tenantId).toBe('tenant-from-header')
    })

    it('normalizes header to lowercase', () => {
      configureTenantContext({ allowHeaderFallback: true })

      const req: TestRequest = {
        headers: { 'x-tenant-id': 'TENANT-ABC' },
        path: '/api/users',
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(req.tenantId).toBe('tenant-abc')
    })

    it('prefers principal tenant over header when both present', () => {
      configureTenantContext({ allowHeaderFallback: true })

      const req: TestRequest = {
        headers: { 'x-tenant-id': 'tenant-from-header' },
        path: '/api/users',
        user: {
          id: 'user-1',
          tenantId: 'tenant-from-auth',
          email: 'user@example.com',
          role: 'admin',
        },
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(req.tenantId).toBe('tenant-from-auth')
    })

    it('rejects with 401 on scoped route when tenant cannot be resolved', () => {
      const req: TestRequest = {
        headers: {},
        path: '/api/tenant/xyz/settings',
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(res.statusCode).toBe(401)
      expect(res.jsonData?.message).toContain('Tenant context required')
    })

    it('rejects with 400 on non-scoped route when tenant cannot be resolved', () => {
      const req: TestRequest = {
        headers: {},
        path: '/api/public/health',
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(res.statusCode).toBe(400)
      expect(res.jsonData?.message).toContain('Tenant ID could not be resolved')
    })

    it('uses default tenant when allowDefaultTenant is true and no tenant available', () => {
      configureTenantContext({ allowDefaultTenant: true })

      const req: TestRequest = {
        headers: {},
        path: '/api/public/health',
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(req.tenantId).toBe('default-tenant')
    })

    it('rejects malformed header tenant ID', () => {
      configureTenantContext({ allowHeaderFallback: true })

      const req: TestRequest = {
        headers: { 'x-tenant-id': 'invalid_tenant_id' },
        path: '/api/users',
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(res.statusCode).toBe(400)
      expect(res.jsonData?.message).toContain('Invalid tenant context')
    })
  })

  describe('requireTenant middleware', () => {
    it('allows request when tenant is set', () => {
      const req: TestRequest = {
        tenantId: 'tenant-1',
      } as any

      const res = createMockResponse()
      const next = () => {}

      requireTenant(req, res, next)

      expect(res.statusCode).toBe(200)
    })

    it('rejects request when tenant is not set', () => {
      const req: TestRequest = {} as any

      const res = createMockResponse()
      const next = () => {}

      requireTenant(req, res, next)

      expect(res.statusCode).toBe(401)
      expect(res.jsonData?.message).toContain('Tenant context required')
    })
  })

  describe('getTenantId', () => {
    it('returns tenant ID when set', () => {
      const req: TestRequest = {
        tenantId: 'my-tenant',
      } as any

      const tenantId = getTenantId(req)

      expect(tenantId).toBe('my-tenant')
    })

    it('returns undefined when tenant not set', () => {
      const req: TestRequest = {} as any

      const tenantId = getTenantId(req)

      expect(tenantId).toBeUndefined()
    })
  })

  describe('Integration scenarios', () => {
    it('handles enterprise tenant flow: auth principal → tenant context → scoped routes', () => {
      const req: TestRequest = {
        headers: { 'x-tenant-id': 'wrong-tenant' },
        path: '/api/tenant/my-org/dashboard',
        user: {
          id: 'user-1',
          tenantId: 'my-org',
          email: 'user@myorg.com',
          role: 'admin',
        },
      } as any

      const res = createMockResponse()
      let nextCalled = false
      const next = () => {
        nextCalled = true
      }

      tenantContextMiddleware(req, res, next)
      expect(nextCalled).toBe(true)
      expect(req.tenantId).toBe('my-org')

      requireTenant(req, res, next)
      expect(res.statusCode).toBe(200)

      expect(getTenantId(req)).toBe('my-org')
    })

    it('handles multi-tenant SaaS flow: header → tenant context → validation', () => {
      configureTenantContext({ allowHeaderFallback: true })

      const req: TestRequest = {
        headers: { 'x-tenant-id': 'saas-customer-1' },
        path: '/api/orgs/saas-customer-1/users',
      } as any

      const res = createMockResponse()
      let nextCalled = false
      const next = () => {
        nextCalled = true
      }

      tenantContextMiddleware(req, res, next)
      expect(nextCalled).toBe(true)
      expect(req.tenantId).toBe('saas-customer-1')

      requireTenant(req, res, next)
      expect(res.statusCode).toBe(200)
    })

    it('rejects malformed tenant across the flow', () => {
      const req: TestRequest = {
        headers: {},
        path: '/api/tenant/invalid_tenant/settings',
        user: {
          id: 'user-1',
          tenantId: 'invalid_tenant',
          email: 'user@example.com',
          role: 'admin',
        },
      } as any

      const res = createMockResponse()
      const next = () => {}

      tenantContextMiddleware(req, res, next)

      expect(res.statusCode).toBe(400)
      expect(res.jsonData?.message).toContain('Invalid tenant context')
      expect(req.tenantId).toBeUndefined()
    })
  })

  describe('AsyncLocalStorage handling', () => {
    it('should properly manage context without leaks', () => {
      const req1: TestRequest = {
        headers: {},
        path: '/api/users',
        user: {
          id: 'user-1',
          tenantId: 'tenant-1',
          email: 'user@example.com',
          role: 'admin',
        },
      } as any

      const req2: TestRequest = {
        headers: {},
        path: '/api/users',
        user: {
          id: 'user-2',
          tenantId: 'tenant-2',
          email: 'user2@example.com',
          role: 'user',
        },
      } as any

      const res1 = createMockResponse()
      const res2 = createMockResponse()

      const next = () => {}

      tenantContextMiddleware(req1, res1, next)
      tenantContextMiddleware(req2, res2, next)

      expect(req1.tenantId).toBe('tenant-1')
      expect(req2.tenantId).toBe('tenant-2')
    })
  })
})
