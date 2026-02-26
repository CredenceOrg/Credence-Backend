/**
 * RBAC middleware + RoleService tests.
 * No database required – all tests run in memory.
 *
 * Run:  npx jest tests/rbac.test.ts
 */

import type { Request, Response, NextFunction } from 'express'
import { requireRole, requireMinRole, requireAnyRole } from '../src/middleware/rbac'
import { RoleService } from '../src/services/roles'
import type { Role } from '../src/types/rbac'


// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Builds a minimal Express-like Request stub. */
function makeReq(user?: { id: string; address: string; role: Role }): Request {
     return { user, method: 'GET', path: '/test' } as unknown as Request
}

/** Captures status + json written to the response. */
function makeRes(): Response & { _status: number; _body: unknown } {
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

const next: NextFunction = jest.fn()

beforeEach(() => {
     jest.clearAllMocks()
})

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------

describe('requireRole()', () => {
     describe('unauthenticated (no req.user)', () => {
          it('returns 401 and does not call next', () => {
               const mw = requireRole('admin')
               const res = makeRes()
               mw(makeReq(), res, next)
               expect(res._status).toBe(401)
               expect((res._body as any).error).toBe('Unauthenticated')
               expect(next).not.toHaveBeenCalled()
          })
     })

     describe('single role', () => {
          it('calls next when role matches', () => {
               const mw = requireRole('admin')
               const res = makeRes()
               mw(makeReq({ id: '1', address: '0x1', role: 'admin' }), res, next)
               expect(next).toHaveBeenCalledTimes(1)
               expect(res._status).toBe(200)
          })

          it('returns 403 when role does not match', () => {
               const mw = requireRole('admin')
               const res = makeRes()
               mw(makeReq({ id: '1', address: '0x1', role: 'user' }), res, next)
               expect(res._status).toBe(403)
               expect((res._body as any).error).toBe('Forbidden')
               expect((res._body as any).actual).toBe('user')
               expect(next).not.toHaveBeenCalled()
          })
     })

     describe('multiple roles', () => {
          it('calls next when caller has any of the listed roles', () => {
               const mw = requireRole('admin', 'verifier')
               const resAdmin = makeRes()
               mw(makeReq({ id: '1', address: '0x1', role: 'admin' }), resAdmin, next)
               expect(next).toHaveBeenCalledTimes(1)

               jest.clearAllMocks()

               const resVerifier = makeRes()
               mw(makeReq({ id: '2', address: '0x2', role: 'verifier' }), resVerifier, next)
               expect(next).toHaveBeenCalledTimes(1)
          })

          it('returns 403 for a role not in the list', () => {
               const mw = requireRole('admin', 'verifier')
               const res = makeRes()
               mw(makeReq({ id: '1', address: '0x1', role: 'user' }), res, next)
               expect(res._status).toBe(403)
               expect((res._body as any).required).toEqual(['admin', 'verifier'])
               expect(next).not.toHaveBeenCalled()
          })
     })

     describe('public role', () => {
          it('returns 403 when public caller hits an admin-only route', () => {
               const mw = requireRole('admin')
               const res = makeRes()
               mw(makeReq({ id: '0', address: '0x0', role: 'public' }), res, next)
               expect(res._status).toBe(403)
               expect(next).not.toHaveBeenCalled()
          })
     })
})

// ---------------------------------------------------------------------------
// requireMinRole
// ---------------------------------------------------------------------------

describe('requireMinRole()', () => {
     describe('unauthenticated', () => {
          it('returns 401', () => {
               const mw = requireMinRole('user')
               const res = makeRes()
               mw(makeReq(), res, next)
               expect(res._status).toBe(401)
               expect(next).not.toHaveBeenCalled()
          })
     })

     describe('hierarchy enforcement', () => {
          const cases: [Role, Role, boolean][] = [
               // [callerRole, minRole, expectAllowed]
               ['admin', 'admin', true],
               ['admin', 'verifier', true],
               ['admin', 'user', true],
               ['admin', 'public', true],
               ['verifier', 'admin', false],
               ['verifier', 'verifier', true],
               ['verifier', 'user', true],
               ['verifier', 'public', true],
               ['user', 'admin', false],
               ['user', 'verifier', false],
               ['user', 'user', true],
               ['user', 'public', true],
               ['public', 'admin', false],
               ['public', 'verifier', false],
               ['public', 'user', false],
               ['public', 'public', true],
          ]

          test.each(cases)(
               'caller=%s minRole=%s → allowed=%s',
               (callerRole, minRole, expectAllowed) => {
                    jest.clearAllMocks()
                    const mw = requireMinRole(minRole)
                    const res = makeRes()
                    mw(makeReq({ id: '1', address: '0x1', role: callerRole }), res, next)
                    if (expectAllowed) {
                         expect(next).toHaveBeenCalledTimes(1)
                         expect(res._status).toBe(200)
                    } else {
                         expect(res._status).toBe(403)
                         expect((res._body as any).requiredMinRole).toBe(minRole)
                         expect((res._body as any).actual).toBe(callerRole)
                         expect(next).not.toHaveBeenCalled()
                    }
               },
          )
     })
})

// ---------------------------------------------------------------------------
// requireAnyRole
// ---------------------------------------------------------------------------

describe('requireAnyRole()', () => {
     it('returns 401 when unauthenticated', () => {
          const mw = requireAnyRole()
          const res = makeRes()
          mw(makeReq(), res, next)
          expect(res._status).toBe(401)
          expect(next).not.toHaveBeenCalled()
     })

     const roles: Role[] = ['admin', 'verifier', 'user', 'public']
     test.each(roles)('calls next for role=%s', (role) => {
          jest.clearAllMocks()
          const mw = requireAnyRole()
          const res = makeRes()
          mw(makeReq({ id: '1', address: '0x1', role }), res, next)
          expect(next).toHaveBeenCalledTimes(1)
     })
})

// ---------------------------------------------------------------------------
// RoleService
// ---------------------------------------------------------------------------

describe('RoleService', () => {
     let service: RoleService

     beforeEach(() => {
          service = new RoleService()
          service._reset()
     })

     describe('getRole()', () => {
          it('returns "user" by default for unknown identities', () => {
               expect(service.getRole('unknown-id')).toBe('user')
          })

          it('returns the assigned role', () => {
               service.assignRole('id-1', 'admin')
               expect(service.getRole('id-1')).toBe('admin')
          })
     })

     describe('assignRole()', () => {
          it('assigns each valid role', () => {
               const roles: Role[] = ['admin', 'verifier', 'user', 'public']
               for (const role of roles) {
                    service.assignRole('id-x', role)
                    expect(service.getRole('id-x')).toBe(role)
               }
          })

          it('throws for an invalid role string', () => {
               expect(() => service.assignRole('id-1', 'superuser' as Role)).toThrow(
                    /Unknown role/,
               )
          })

          it('overwrites an existing assignment', () => {
               service.assignRole('id-1', 'user')
               service.assignRole('id-1', 'admin')
               expect(service.getRole('id-1')).toBe('admin')
          })
     })

     describe('revokeRole()', () => {
          it('reverts to "user" default after revocation', () => {
               service.assignRole('id-1', 'admin')
               service.revokeRole('id-1')
               expect(service.getRole('id-1')).toBe('user')
          })

          it('is idempotent for unknown identity', () => {
               expect(() => service.revokeRole('no-such-id')).not.toThrow()
          })
     })

     describe('hasMinRole()', () => {
          it('returns true when candidate meets the minimum', () => {
               expect(service.hasMinRole('admin', 'user')).toBe(true)
               expect(service.hasMinRole('verifier', 'verifier')).toBe(true)
          })

          it('returns false when candidate is below the minimum', () => {
               expect(service.hasMinRole('user', 'admin')).toBe(false)
               expect(service.hasMinRole('public', 'user')).toBe(false)
          })
     })

     describe('hasExactRole()', () => {
          it('returns true for exact match', () => {
               expect(service.hasExactRole('admin', 'admin')).toBe(true)
          })

          it('returns false for non-exact match', () => {
               expect(service.hasExactRole('admin', 'user')).toBe(false)
          })
     })

     describe('_reset()', () => {
          it('clears all role assignments', () => {
               service.assignRole('id-1', 'admin')
               service.assignRole('id-2', 'verifier')
               service._reset()
               expect(service.getRole('id-1')).toBe('user')
               expect(service.getRole('id-2')).toBe('user')
          })
     })
})