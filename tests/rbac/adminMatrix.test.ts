import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { requireRole, requireMinRole } from '../../src/middleware/rbac.js'
import { requireAdminRole } from '../../src/middleware/auth.js'
import type { Role, AuthenticatedUser } from '../../src/types/rbac.js'
import { ADMIN_PERMISSION_MATRIX } from '../../src/routes/admin/permissionMatrix.test.js'

// Helper to create mock Express request
function makeReq(user?: { id: string; email?: string; address?: string; role: string; tenantId?: string }): Request {
  return {
    user,
    method: 'GET',
    path: '/api/admin',
    headers: {},
  } as unknown as Request
}

// Helper to create mock Express response
function makeRes(): Response & { _status: number; _body: any } {
  const res: any = {
    _status: 200,
    _body: undefined,
    status(code: number) {
      this._status = code
      return this
    },
    json(body: unknown) {
      this._body = body
      return this
    },
  }
  return res
}

describe('tests/rbac/adminMatrix.test.ts - Role Gate & Permission Matrix Enforcement', () => {
  const next: NextFunction = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Permission Matrix Coverage Verification', () => {
    it('contains all 40 admin route endpoints in the matrix', () => {
      expect(ADMIN_PERMISSION_MATRIX.length).toBeGreaterThanOrEqual(40)
    })
  })

  describe('requireAdminRole Middleware Matrix', () => {
    it('returns 401 Unauthorized for unauthenticated callers', () => {
      const res = makeRes()
      requireAdminRole(makeReq(undefined), res, next)

      expect(res._status).toBe(401)
      expect(res._body.error).toBe('Unauthorized')
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 403 Forbidden for non-admin roles (user, verifier, public)', () => {
      const nonAdminRoles = ['user', 'verifier', 'public']

      for (const role of nonAdminRoles) {
        const res = makeRes()
        requireAdminRole(makeReq({ id: 'u1', role }), res, next)

        expect(res._status).toBe(403)
        expect(res._body.error).toBe('Forbidden')
        expect(next).not.toHaveBeenCalled()
      }
    })

    it('allows admin role to pass', () => {
      const res = makeRes()
      requireAdminRole(makeReq({ id: 'a1', role: 'admin' }), res, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(res._status).toBe(200)
    })

    it('allows super-admin role to pass', () => {
      const res = makeRes()
      requireAdminRole(makeReq({ id: 'sa1', role: 'super-admin' }), res, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(res._status).toBe(200)
    })
  })

  describe('requireRole("admin") Middleware Matrix', () => {
    const mw = requireRole('admin')

    it('returns 401 Unauthenticated when req.user is missing', () => {
      const res = makeRes()
      expect(() => mw(makeReq(), res, next)).toThrow('Unauthenticated')
    })

    it('returns 403 Forbidden when caller role is not admin', () => {
      const roles: Role[] = ['verifier', 'user', 'public']
      for (const role of roles) {
        const res = makeRes()
        expect(() => mw(makeReq({ id: '1', address: '0x1', role }), res, next)).toThrow('Forbidden')
      }
    })

    it('calls next when caller role is admin', () => {
      const res = makeRes()
      mw(makeReq({ id: '1', address: '0x1', role: 'admin' }), res, next)
      expect(next).toHaveBeenCalledTimes(1)
    })
  })

  describe('requireMinRole("admin") Hierarchy Matrix', () => {
    const mw = requireMinRole('admin')

    it('allows admin role', () => {
      const res = makeRes()
      mw(makeReq({ id: '1', address: '0x1', role: 'admin' }), res, next)
      expect(next).toHaveBeenCalledTimes(1)
    })

    it('denies verifier, user, public roles', () => {
      const roles: Role[] = ['verifier', 'user', 'public']
      for (const role of roles) {
        const res = makeRes()
        expect(() => mw(makeReq({ id: '1', address: '0x1', role }), res, next)).toThrow('Forbidden')
      }
    })
  })
})
