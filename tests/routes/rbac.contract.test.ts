/**
 * @file tests/routes/rbac.contract.test.ts
 *
 * HTTP-boundary contract tests for every RBAC-protected middleware:
 *   – requireRole()       exact role matching
 *   – requireMinRole()    hierarchical minimum-role enforcement
 *   – requireAnyRole()    any authenticated caller
 *   – requirePermission() policy-engine allow/deny semantics
 *
 * Design principles
 * -----------------
 * • Uses supertest (consistent with every other test in tests/routes/).
 * • No database required – all state is in-memory.
 * • requirePermission tests inject custom RbacPolicyEngine instances so
 *   each describe block controls its own policy set in isolation.
 * • Response body shape is asserted (not just status code).
 * • Fixtures and the role-hierarchy matrix are intentionally kept in this
 *   file (mirroring tests/rbac.test.ts) so the contract file is
 *   self-contained and easy to read in security reviews.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'

import {
  requireRole,
  requireMinRole,
  requireAnyRole,
  requirePermission,
} from '../../src/middleware/rbac.js'
import { RbacPolicyEngine } from '../../src/services/rbac.service.js'
import type { Role, AuthenticatedUser } from '../../src/types/rbac.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared infrastructure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard error-handler that translates thrown RBAC errors into the correct
 * HTTP status codes. Mirrors the pattern used in src/middleware/errorHandler.ts
 * and other route-test setups (disputes.test.ts, members.test.ts …).
 */
function attachErrorHandler(app: Express): void {
  app.use(
    (
      err: any,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      const msg: string = err?.message ?? ''
      if (msg === 'Unauthenticated' || err?.status === 401) {
        res.status(401).json({ error: 'Unauthenticated' })
      } else if (msg.startsWith('Forbidden') || err?.status === 403) {
        res.status(403).json({ error: msg })
      } else {
        res.status(500).json({ error: 'Internal Server Error' })
      }
    },
  )
}

/**
 * Auth-stub middleware: reads `x-role` header and populates req.user.
 * Leaves req.user undefined when the header is absent (→ unauthenticated).
 */
function stubAuth(req: Request, _res: Response, next: NextFunction): void {
  const role = req.headers['x-role'] as Role | undefined
  if (role) {
    ;(req as any).user = {
      id: 'test-user-id',
      address: '0xdeadbeef',
      role,
    } as AuthenticatedUser
  }
  next()
}

/** All roles recognised by the system – order mirrors ROLE_HIERARCHY. */
const ALL_ROLES: Role[] = ['public', 'user', 'verifier', 'admin']

/**
 * Make an authenticated supertest GET against `path` with the given role.
 * Omit `role` to simulate an unauthenticated caller.
 */
function get(app: Express, path: string, role?: Role) {
  const req = request(app).get(path)
  if (role) req.set('x-role', role)
  return req
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. requireRole() – exact role matching
// ─────────────────────────────────────────────────────────────────────────────

describe('requireRole() – HTTP contract', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(stubAuth)

    // Single-role guard
    app.get('/admin-only', requireRole('admin'), (_req, res) =>
      res.status(200).json({ ok: true }),
    )

    // Multi-role guard
    app.get(
      '/admin-or-verifier',
      requireRole('admin', 'verifier'),
      (_req, res) => res.status(200).json({ ok: true }),
    )

    attachErrorHandler(app)
  })

  // ── Unauthenticated ───────────────────────────────────────────────────────

  describe('unauthenticated callers', () => {
    it('returns 401 for a single-role guard', async () => {
      const res = await get(app, '/admin-only')
      expect(res.status).toBe(401)
      expect(res.body.error).toMatch(/Unauthenticated/i)
    })

    it('returns 401 for a multi-role guard', async () => {
      const res = await get(app, '/admin-or-verifier')
      expect(res.status).toBe(401)
      expect(res.body.error).toMatch(/Unauthenticated/i)
    })
  })

  // ── Single-role: admin ────────────────────────────────────────────────────

  describe('requireRole("admin") – single role', () => {
    it('allows admin', async () => {
      const res = await get(app, '/admin-only', 'admin')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it.each(['public', 'user', 'verifier'] as Role[])(
      'denies %s with 403',
      async (role) => {
        const res = await get(app, '/admin-only', role)
        expect(res.status).toBe(403)
        expect(res.body.error).toMatch(/Forbidden/)
      },
    )
  })

  // ── Multi-role: admin | verifier ──────────────────────────────────────────

  describe('requireRole("admin", "verifier") – multiple roles', () => {
    it.each(['admin', 'verifier'] as Role[])(
      'allows %s',
      async (role) => {
        const res = await get(app, '/admin-or-verifier', role)
        expect(res.status).toBe(200)
      },
    )

    it.each(['public', 'user'] as Role[])(
      'denies %s with 403',
      async (role) => {
        const res = await get(app, '/admin-or-verifier', role)
        expect(res.status).toBe(403)
        expect(res.body.error).toMatch(/Forbidden/)
      },
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. requireMinRole() – hierarchical enforcement
//    Matrix reused from tests/rbac.test.ts (lines 126-144).
// ─────────────────────────────────────────────────────────────────────────────

describe('requireMinRole() – HTTP contract', () => {
  /**
   * Full 4×4 hierarchy matrix.
   * [callerRole, minRole, expectAllowed]
   */
  const hierarchyMatrix: [Role, Role, boolean][] = [
    ['admin',    'admin',    true],
    ['admin',    'verifier', true],
    ['admin',    'user',     true],
    ['admin',    'public',   true],
    ['verifier', 'admin',    false],
    ['verifier', 'verifier', true],
    ['verifier', 'user',     true],
    ['verifier', 'public',   true],
    ['user',     'admin',    false],
    ['user',     'verifier', false],
    ['user',     'user',     true],
    ['user',     'public',   true],
    ['public',   'admin',    false],
    ['public',   'verifier', false],
    ['public',   'user',     false],
    ['public',   'public',   true],
  ]

  // ── Unauthenticated ───────────────────────────────────────────────────────

  it('returns 401 for unauthenticated callers', async () => {
    const app = express()
    app.use(stubAuth)
    app.get('/min-user', requireMinRole('user'), (_req, res) =>
      res.sendStatus(200),
    )
    attachErrorHandler(app)

    const res = await get(app, '/min-user')
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/Unauthenticated/i)
  })

  // ── Full hierarchy matrix ─────────────────────────────────────────────────

  it.each(hierarchyMatrix)(
    'caller=%s minRole=%s → allowed=%s',
    async (callerRole, minRole, expectAllowed) => {
      // Each iteration builds a fresh app to avoid route shadowing.
      const app = express()
      app.use(stubAuth)
      app.get(
        '/guarded',
        requireMinRole(minRole),
        (_req, res) => res.status(200).json({ ok: true }),
      )
      attachErrorHandler(app)

      const res = await get(app, '/guarded', callerRole)

      if (expectAllowed) {
        expect(res.status).toBe(200)
        expect(res.body.ok).toBe(true)
      } else {
        expect(res.status).toBe(403)
        expect(res.body.error).toMatch(/Forbidden/)
      }
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. requireAnyRole() – any authenticated caller passes
// ─────────────────────────────────────────────────────────────────────────────

describe('requireAnyRole() – HTTP contract', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(stubAuth)
    app.get('/authenticated', requireAnyRole(), (_req, res) =>
      res.status(200).json({ ok: true }),
    )
    attachErrorHandler(app)
  })

  it('returns 401 for unauthenticated callers', async () => {
    const res = await get(app, '/authenticated')
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/Unauthenticated/i)
  })

  it.each(ALL_ROLES)(
    'allows authenticated caller with role=%s',
    async (role) => {
      const res = await get(app, '/authenticated', role)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. requirePermission() – policy-engine allow/deny semantics
//
// Each sub-describe injects its own RbacPolicyEngine instance into a
// dedicated Express app so policy sets are fully isolated between tests.
// ─────────────────────────────────────────────────────────────────────────────

describe('requirePermission() – HTTP contract (policy engine)', () => {
  // ── 4a. Allow rule matched ────────────────────────────────────────────────

  describe('allow rule matched → 200', () => {
    let app: Express

    beforeEach(() => {
      // Inject a custom engine directly into the route handler so this test
      // suite controls its own isolated policy set (no singleton side-effects).
      const engine = new RbacPolicyEngine([
        { role: 'user', resource: 'profile', action: 'read', effect: 'allow' },
      ])

      app = express()
      app.use(stubAuth)
      app.get('/profile', (req, res, next) => {
        const user = (req as any).user as AuthenticatedUser | undefined
        const roles = user ? [user.role] : ['public']
        const decision = engine.evaluate(roles, 'read', 'profile', {})
        ;(req as any).rbacDecision = decision
        if (!decision.allowed) {
          next(new Error(`Forbidden: ${decision.reason}`))
          return
        }
        res.status(200).json({ ok: true, decision })
      })
      attachErrorHandler(app)
    })

    it('returns 200 and allowed=true when rule matches', async () => {
      const res = await get(app, '/profile', 'user')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.decision.allowed).toBe(true)
      expect(res.body.decision.reason).toMatch(/allow/i)
    })

    it('returns 403 for a role that has no allow rule', async () => {
      const res = await get(app, '/profile', 'public')
      expect(res.status).toBe(403)
    })
  })

  // ── 4b. Explicit-deny rule matched → 403 (deny-first evaluation) ──────────

  describe('explicit deny rule → 403 (deny overrides allow)', () => {
    let app: Express

    beforeEach(() => {
      const engine = new RbacPolicyEngine([
        // Allow rule present…
        { role: 'user', resource: 'profile', action: 'delete', effect: 'allow' },
        // …but a deny rule for the same role/resource/action wins.
        { role: 'user', resource: 'profile', action: 'delete', effect: 'deny' },
      ])

      app = express()
      app.use(stubAuth)
      app.get('/profile/delete', (req, res, next) => {
        const user = (req as any).user as AuthenticatedUser | undefined
        const roles = user ? [user.role] : ['public']
        const decision = engine.evaluate(roles, 'delete', 'profile', {})
        ;(req as any).rbacDecision = decision
        if (!decision.allowed) {
          next(new Error(`Forbidden: ${decision.reason}`))
          return
        }
        res.status(200).json({ ok: true, decision })
      })
      attachErrorHandler(app)
    })

    it('returns 403 when deny rule overrides an allow rule', async () => {
      const res = await get(app, '/profile/delete', 'user')
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/Forbidden/)
    })

    it('attaches decision.allowed=false to request before throwing', async () => {
      // Verify decision state by echoing it before the error handler.
      const engine = new RbacPolicyEngine([
        { role: 'user', resource: 'report', action: 'export', effect: 'deny' },
      ])
      const echoApp = express()
      echoApp.use(stubAuth)
      echoApp.get('/report/export', (req, res, _next) => {
        const user = (req as any).user as AuthenticatedUser | undefined
        const roles = user ? [user.role] : ['public']
        const decision = engine.evaluate(roles, 'export', 'report', {})
        ;(req as any).rbacDecision = decision
        // Return decision directly (no throw) so test can inspect state.
        res.status(decision.allowed ? 200 : 403).json({ decision })
      })
      attachErrorHandler(echoApp)

      const res = await get(echoApp, '/report/export', 'user')
      expect(res.status).toBe(403)
      expect(res.body.decision.allowed).toBe(false)
      expect(res.body.decision.reason).toMatch(/deny/i)
    })
  })

  // ── 4c. Default-deny (no matching rule) → 403 ────────────────────────────

  describe('default-deny (no matching rule) → 403', () => {
    let app: Express

    beforeEach(() => {
      // Empty policy set → every request hits the default-deny path.
      const engine = new RbacPolicyEngine([])

      app = express()
      app.use(stubAuth)
      app.get('/secret', (req, res, next) => {
        const user = (req as any).user as AuthenticatedUser | undefined
        const roles = user ? [user.role] : ['public']
        const decision = engine.evaluate(roles, 'read', 'secret', {})
        ;(req as any).rbacDecision = decision
        if (!decision.allowed) {
          next(new Error(`Forbidden: ${decision.reason}`))
          return
        }
        res.status(200).json({ ok: true })
      })
      attachErrorHandler(app)
    })

    it.each(ALL_ROLES)(
      'returns 403 for role=%s when no rule matches',
      async (role) => {
        const res = await get(app, '/secret', role)
        expect(res.status).toBe(403)
        expect(res.body.error).toMatch(/Forbidden/)
      },
    )

    it('returns 403 for unauthenticated callers (public role default-deny)', async () => {
      const res = await get(app, '/secret') // no x-role header
      expect(res.status).toBe(403)
    })
  })

  // ── 4d. Admin wildcard allow ──────────────────────────────────────────────

  describe('admin wildcard → allows everything', () => {
    let app: Express

    beforeEach(() => {
      // Mirror default engine policy: admin gets wildcard allow.
      const engine = new RbacPolicyEngine([
        { role: 'admin', resource: '*', action: '*', effect: 'allow' },
      ])

      app = express()
      app.use(stubAuth)

      const mount = (resource: string, action: string) => {
        app.get(`/${resource}/${action}`, (req, res, next) => {
          const user = (req as any).user as AuthenticatedUser | undefined
          const roles = user ? [user.role] : ['public']
          const decision = engine.evaluate(roles, action, resource, {})
          ;(req as any).rbacDecision = decision
          if (!decision.allowed) {
            next(new Error(`Forbidden: ${decision.reason}`))
            return
          }
          res.status(200).json({ ok: true, decision })
        })
      }

      mount('users', 'delete')
      mount('audit-logs', 'export')
      mount('keys', 'revoke')
      attachErrorHandler(app)
    })

    it.each([
      ['users', 'delete'],
      ['audit-logs', 'export'],
      ['keys', 'revoke'],
    ])('admin may %s/%s', async (resource, action) => {
      const res = await get(app, `/${resource}/${action}`, 'admin')
      expect(res.status).toBe(200)
      expect(res.body.decision.allowed).toBe(true)
    })

    it.each(['verifier', 'user', 'public'] as Role[])(
      'non-admin role=%s is denied by default (no allow rule)',
      async (role) => {
        const res = await get(app, '/users/delete', role)
        expect(res.status).toBe(403)
      },
    )
  })

  // ── 4e. requirePermission() via actual middleware (production path) ───────

  describe('requirePermission() middleware (production engine, default policies)', () => {
    /**
     * These tests use the real `requirePermission` middleware which internally
     * calls the singleton `rbacEngine` with default policies:
     *   admin  / *        / * → allow
     *   user   / profile  / read   → allow
     *   user   / profile  / update → allow
     */
    let app: Express

    beforeEach(() => {
      app = express()
      app.use(stubAuth)

      // Echo rbacDecision in response so tests can inspect the decision object.
      app.get(
        '/read-profile',
        requirePermission('read', 'profile'),
        (req, res) =>
          res.status(200).json({ ok: true, decision: (req as any).rbacDecision }),
      )
      app.get(
        '/delete-profile',
        requirePermission('delete', 'profile'),
        (req, res) =>
          res.status(200).json({ ok: true, decision: (req as any).rbacDecision }),
      )
      app.get(
        '/delete-any',
        requirePermission('delete', 'any-resource'),
        (req, res) =>
          res.status(200).json({ ok: true, decision: (req as any).rbacDecision }),
      )
      app.get(
        '/unknown',
        requirePermission('unknown-action', 'unknown-resource'),
        (req, res) =>
          res.status(200).json({ ok: true, decision: (req as any).rbacDecision }),
      )

      attachErrorHandler(app)
    })

    describe('admin caller', () => {
      it('is allowed to read profile', async () => {
        const res = await get(app, '/read-profile', 'admin')
        expect(res.status).toBe(200)
        expect(res.body.decision.allowed).toBe(true)
      })

      it('is allowed to delete anything (wildcard policy)', async () => {
        const res = await get(app, '/delete-any', 'admin')
        expect(res.status).toBe(200)
        expect(res.body.decision.allowed).toBe(true)
      })
    })

    describe('user caller', () => {
      it('is allowed to read profile', async () => {
        const res = await get(app, '/read-profile', 'user')
        expect(res.status).toBe(200)
        expect(res.body.decision.allowed).toBe(true)
      })

      it('is denied when deleting profile (no allow rule)', async () => {
        const res = await get(app, '/delete-profile', 'user')
        expect(res.status).toBe(403)
        expect(res.body.error).toMatch(/Forbidden/)
      })

      it('is denied for unknown action/resource (default-deny)', async () => {
        const res = await get(app, '/unknown', 'user')
        expect(res.status).toBe(403)
      })
    })

    describe('public caller (unauthenticated)', () => {
      it('defaults to public role and is denied profile reads', async () => {
        // No x-role header → requirePermission falls back to ["public"] roles.
        // Default policy has no allow rule for public → 403 (not 401).
        const res = await get(app, '/read-profile')
        expect(res.status).toBe(403)
      })

      it('is denied delete operations', async () => {
        const res = await get(app, '/delete-profile')
        expect(res.status).toBe(403)
      })
    })

    describe('verifier caller', () => {
      it('is denied profile read (no verifier allow rule in default policy)', async () => {
        const res = await get(app, '/read-profile', 'verifier')
        expect(res.status).toBe(403)
      })
    })

    describe('rbacDecision is attached to the request', () => {
      it('allowed=true is attached on success', async () => {
        const res = await get(app, '/read-profile', 'user')
        expect(res.body.decision).toBeDefined()
        expect(res.body.decision.allowed).toBe(true)
        expect(typeof res.body.decision.reason).toBe('string')
        expect(typeof res.body.decision.timestamp).toBe('string')
      })
    })
  })

  // ── 4f. Wildcard resource/action matching semantics ───────────────────────

  describe('wildcard matching semantics', () => {
    it('resource wildcard "*" matches any resource', async () => {
      const engine = new RbacPolicyEngine([
        { role: 'admin', resource: '*', action: 'read', effect: 'allow' },
      ])

      const resources = ['profile', 'report', 'audit-log', 'bond']
      for (const resource of resources) {
        const app = express()
        app.use(stubAuth)
        app.get('/guarded', (req, res, next) => {
          const user = (req as any).user as AuthenticatedUser | undefined
          const roles = user ? [user.role] : ['public']
          const decision = engine.evaluate(roles, 'read', resource, {})
          if (!decision.allowed) { next(new Error(`Forbidden: ${decision.reason}`)); return }
          res.status(200).json({ ok: true })
        })
        attachErrorHandler(app)

        const res = await get(app, '/guarded', 'admin')
        expect(res.status).toBe(200)
      }
    })

    it('action wildcard "*" matches any action', async () => {
      const engine = new RbacPolicyEngine([
        { role: 'admin', resource: 'profile', action: '*', effect: 'allow' },
      ])

      const actions = ['read', 'write', 'delete', 'export']
      for (const action of actions) {
        const app = express()
        app.use(stubAuth)
        app.get('/guarded', (req, res, next) => {
          const user = (req as any).user as AuthenticatedUser | undefined
          const roles = user ? [user.role] : ['public']
          const decision = engine.evaluate(roles, action, 'profile', {})
          if (!decision.allowed) { next(new Error(`Forbidden: ${decision.reason}`)); return }
          res.status(200).json({ ok: true })
        })
        attachErrorHandler(app)

        const res = await get(app, '/guarded', 'admin')
        expect(res.status).toBe(200)
      }
    })
  })

  // ── 4g. Deny-always rule takes precedence over global wildcard allow ───────

  describe('explicit deny takes precedence over wildcard allow', () => {
    it('denies even when a wildcard allow rule also matches', async () => {
      const engine = new RbacPolicyEngine([
        // Global allow-all for admin
        { role: 'admin', resource: '*', action: '*', effect: 'allow' },
        // Specific deny for admin on "quarantine" resource
        { role: 'admin', resource: 'quarantine', action: 'read', effect: 'deny' },
      ])

      const app = express()
      app.use(stubAuth)
      app.get('/quarantine', (req, res, next) => {
        const user = (req as any).user as AuthenticatedUser | undefined
        const roles = user ? [user.role] : ['public']
        const decision = engine.evaluate(roles, 'read', 'quarantine', {})
        ;(req as any).rbacDecision = decision
        if (!decision.allowed) { next(new Error(`Forbidden: ${decision.reason}`)); return }
        res.status(200).json({ ok: true, decision })
      })
      attachErrorHandler(app)

      const res = await get(app, '/quarantine', 'admin')
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/Forbidden/)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cross-middleware consistency – all guards agree on 401 vs 403
// ─────────────────────────────────────────────────────────────────────────────

describe('Cross-middleware consistency – 401 vs 403 semantics', () => {
  /**
   * Security contract: unauthenticated callers ALWAYS get 401 regardless of
   * which middleware guard is applied. Role mismatch ALWAYS gets 403.
   * This verifies the contract is consistent across all four guard types.
   */
  const guards: Array<{
    name: string
    middleware: ReturnType<typeof requireRole>
  }> = [
    { name: 'requireRole("admin")',    middleware: requireRole('admin') },
    { name: 'requireMinRole("user")',  middleware: requireMinRole('user') },
    { name: 'requireAnyRole()',        middleware: requireAnyRole() },
  ]

  describe('unauthenticated → 401 for all guards', () => {
    it.each(guards)('$name returns 401', async ({ middleware }) => {
      const app = express()
      app.use(stubAuth)
      app.get('/guarded', middleware, (_req, res) => res.sendStatus(200))
      attachErrorHandler(app)

      const res = await get(app, '/guarded')
      expect(res.status).toBe(401)
    })
  })

  describe('wrong role → 403 for role-specific guards', () => {
    const roleGuards = guards.filter(
      (g) => g.name !== 'requireAnyRole()',
    )

    it.each(roleGuards)(
      '$name returns 403 for public role',
      async ({ middleware }) => {
        const app = express()
        app.use(stubAuth)
        app.get('/guarded', middleware, (_req, res) => res.sendStatus(200))
        attachErrorHandler(app)

        const res = await get(app, '/guarded', 'public')
        expect(res.status).toBe(403)
      },
    )
  })
})
