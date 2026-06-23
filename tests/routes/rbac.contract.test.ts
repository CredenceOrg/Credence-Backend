/**
 * @file API Contract tests for RBAC-protected routes.
 * * Verifies that the RBAC middlewares strictly enforce the allow/deny matrix
 * at the HTTP boundary, returning correct status codes (401, 403, 200).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express } from 'express'

import {
  requireRole,
  requireMinRole,
  requireAnyRole,
} from '../../src/middleware/rbac.js'
import type { Role, AuthenticatedUser } from '../../src/types/rbac.js'

// ── Lightweight fetch helper (matching other route tests) ─────────
async function request(
  app: Express,
  path: string,
  role?: Role
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        return reject(new Error('Could not get server address'))
      }

      const url = `http://127.0.0.1:${addr.port}${path}`
      const headers: HeadersInit = {}
      if (role) headers['x-role'] = role

      fetch(url, { headers })
        .then((res) => {
          server.close()
          resolve({ status: res.status })
        })
        .catch((err) => {
          server.close()
          reject(err)
        })
    })
  })
}

describe('RBAC API Contracts (Allow/Deny Matrix)', () => {
  let app: Express

  beforeEach(() => {
    app = express()

    // Mock authentication middleware to populate req.user based on headers
    app.use((req, res, next) => {
      const role = req.headers['x-role'] as Role | undefined
      if (role) {
        ;(req as any).user = {
          id: '1234',
          address: '0xabc',
          role,
        } as AuthenticatedUser
      }
      next()
    })

    // Protected test routes
    app.get('/api/any', requireAnyRole(), (req, res) => {
      res.sendStatus(200)
    })
    app.get('/api/admin', requireRole('admin'), (req, res) => {
      res.sendStatus(200)
    })
    app.get(
      '/api/admin-or-verifier',
      requireRole('admin', 'verifier'),
      (req, res) => {
        res.sendStatus(200)
      }
    )

    // Mock error handler to translate custom errors to standard HTTP status codes
    app.use(
      (
        err: any,
        req: express.Request,
        res: express.Response,
        next: express.NextFunction
      ) => {
        if (err.message === 'Unauthenticated') {
          res.status(401).json({ error: 'Unauthenticated' })
        } else if (err.message && err.message.startsWith('Forbidden')) {
          res.status(403).json({ error: 'Forbidden' })
        } else {
          res.status(500).json({ error: 'Internal Server Error' })
        }
      }
    )
  })

  describe('Unauthenticated Requests', () => {
    it('returns 401 for requireAnyRole', async () => {
      const { status } = await request(app, '/api/any')
      expect(status).toBe(401)
    })

    it('returns 401 for requireRole', async () => {
      const { status } = await request(app, '/api/admin')
      expect(status).toBe(401)
    })

    it('returns 401 for requireMinRole', async () => {
      // Dynamically mounting this test route inline
      app.get('/api/min-verifier', requireMinRole('verifier'), (req, res) =>
        res.sendStatus(200)
      )
      const { status } = await request(app, '/api/min-verifier')
      expect(status).toBe(401)
    })
  })

  // Reusing the hierarchy matrix cases defined in tests/rbac.test.ts
  describe('requireMinRole Hierarchy Enforcement', () => {
    const cases: [Role, Role, boolean][] = [
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

    it.each(cases)(
      'caller=%s minRole=%s → allowed=%s',
      async (callerRole, minRole, expectAllowed) => {
        // Dynamically mount a route for the specific minRole in this iteration
        app.get(
          `/api/dynamic-min-${minRole}`,
          requireMinRole(minRole),
          (req, res) => {
            res.sendStatus(200)
          }
        )

        const { status } = await request(
          app,
          `/api/dynamic-min-${minRole}`,
          callerRole
        )

        if (expectAllowed) {
          expect(status).toBe(200)
        } else {
          expect(status).toBe(403)
        }
      }
    )
  })

  describe('requireRole Exact Enforcement', () => {
    const roles: Role[] = ['admin', 'verifier', 'user', 'public']

    describe('Single role: admin', () => {
      it.each(roles)('caller=%s → required=admin', async (callerRole) => {
        const { status } = await request(app, '/api/admin', callerRole)
        if (callerRole === 'admin') {
          expect(status).toBe(200)
        } else {
          expect(status).toBe(403)
        }
      })
    })

    describe('Multiple roles: admin or verifier', () => {
      it.each(roles)(
        'caller=%s → required=admin|verifier',
        async (callerRole) => {
          const { status } = await request(
            app,
            '/api/admin-or-verifier',
            callerRole
          )
          if (['admin', 'verifier'].includes(callerRole)) {
            expect(status).toBe(200)
          } else {
            expect(status).toBe(403)
          }
        }
      )
    })
  })

  describe('requireAnyRole Enforcement', () => {
    const roles: Role[] = ['admin', 'verifier', 'user', 'public']
    it.each(roles)(
      'allows authenticated caller with role=%s',
      async (callerRole) => {
        const { status } = await request(app, '/api/any', callerRole)
        expect(status).toBe(200)
      }
    )
  })
})
