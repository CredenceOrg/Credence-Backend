/**
 * Integration tests for routes/policy.ts
 *
 * Covers the full HTTP surface of the policy management endpoints:
 *   POST   /api/orgs/:orgId/policies          – create rule
 *   GET    /api/orgs/:orgId/policies          – list rules (paginated)
 *   GET    /api/orgs/:orgId/policies/:ruleId  – get rule by id
 *   PATCH  /api/orgs/:orgId/policies/:ruleId  – update rule
 *   DELETE /api/orgs/:orgId/policies/:ruleId  – delete rule
 *
 * Allow/deny decision matrix exercised via the requirePolicy middleware on read
 * routes and the role-seeded actors used for mutations:
 *
 * ┌────────────────────────┬────────┬──────────┬──────────────────────────┐
 * │ Caller                 │ CREATE │ LIST/GET │ PATCH/DELETE             │
 * ├────────────────────────┼────────┼──────────┼──────────────────────────┤
 * │ admin (no rules)       │ ✓ 201  │ ✓ 200    │ ✓ 200 / 204              │
 * │ user  (allow rule)     │ ✗ 403  │ ✓ 200    │ ✗ 403                    │
 * │ user  (no allow rule)  │ ✗ 403  │ ✗ 403    │ ✗ 403                    │
 * │ unauthenticated        │ ✗ 401  │ ✗ 401    │ ✗ 401                    │
 * └────────────────────────┴────────┴──────────┴──────────────────────────┘
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { createPolicyRouter } from './policy.js'
import { policyStore } from '../services/policy/store.js'
import { AppError } from '../lib/errors.js'

// ---------------------------------------------------------------------------
// Auth middleware mock
//
// We mock the entire auth middleware module so that tests can control which
// user is "authenticated" without needing real API key round-trips.
// The mocked `requireUserAuth` injects `req.user` from a module-level
// variable that tests set before each request.
// ---------------------------------------------------------------------------

/** Current user injected by requireUserAuth. Set to null to simulate 401. */
let currentUser: {
  id: string
  role: 'admin' | 'super-admin' | 'verifier' | 'user'
  email: string
  tenantId: string
} | null = null

vi.mock('../middleware/auth.js', () => ({
  /** Injects currentUser into req.user, or responds 401 when null. */
  requireUserAuth: (req: any, res: Response, next: NextFunction) => {
    if (!currentUser) {
      res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required' })
      return
    }
    req.user = currentUser
    next()
  },
  /** Allows only admin/super-admin roles. */
  requireAdminRole: (req: any, res: Response, next: NextFunction) => {
    const user = req.user as typeof currentUser
    if (!user) {
      res.status(401).json({ error: 'Unauthorized', message: 'User authentication required' })
      return
    }
    if (user.role !== 'admin' && user.role !== 'super-admin') {
      res.status(403).json({ error: 'Forbidden', message: 'Admin role required' })
      return
    }
    next()
  },
  UserRole: {
    SUPER_ADMIN: 'super-admin',
    ADMIN: 'admin',
    VERIFIER: 'verifier',
    USER: 'user',
  },
  // Re-export types used by the module under test
  ApiScope: {},
  MOCK_USERS: {},
  API_KEY_TO_USER: {},
}))

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app that mounts the policy router under the same
 * path used in production. The error handler mirrors the production one so
 * ValidationError → 400 and ForbiddenError → 403 envelopes work correctly.
 */
function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/orgs/:orgId/policies', createPolicyRouter())

  // Mirror production error handler: AppError → status + JSON, else 500
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json(err.toJSON({ exposeMessage: true, exposeDetails: true }))
      return
    }
    res.status(500).json({ error: 'Internal Server Error' })
  })

  return app
}

// ---------------------------------------------------------------------------
// Convenience actor setters
// ---------------------------------------------------------------------------

function asAdmin() {
  currentUser = { id: 'actor-admin', role: 'admin', email: 'admin@test.com', tenantId: 'tenant-test' }
}
function asUser() {
  currentUser = { id: 'actor-user', role: 'user', email: 'user@test.com', tenantId: 'tenant-test' }
}
function asVerifier() {
  currentUser = { id: 'actor-verifier', role: 'verifier', email: 'verifier@test.com', tenantId: 'tenant-test' }
}
function asUnauthenticated() {
  currentUser = null
}

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  policyStore._reset()
  currentUser = null
})

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

const ORG = 'org-test'
const BASE = `/api/orgs/${ORG}/policies`

/** Minimal valid create body */
const VALID_RULE = {
  subject: 'user',
  action: 'org:read' as const,
  resource: '*',
  effect: 'allow' as const,
}

// ===========================================================================
// POST /api/orgs/:orgId/policies  – create rule
// ===========================================================================

describe('POST /api/orgs/:orgId/policies', () => {
  it('201 – admin creates a policy rule, response envelope is correct', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app).post(BASE).send(VALID_RULE)

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data).toMatchObject({
      id: expect.any(String),
      orgId: ORG,
      subject: 'user',
      action: 'org:read',
      resource: '*',
      effect: 'allow',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })
  })

  it('201 – admin can create a deny rule with conditions', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app)
      .post(BASE)
      .send({
        subject: 'user:actor-user',
        action: 'org:member:invite',
        resource: `org:${ORG}:members`,
        effect: 'deny',
        conditions: { region: 'eu-west-1' },
      })

    expect(res.status).toBe(201)
    expect(res.body.data.effect).toBe('deny')
    expect(res.body.data.conditions).toEqual({ region: 'eu-west-1' })
  })

  it('403 – non-admin (user role) cannot create a rule', async () => {
    const app = createApp()
    asUser()

    const res = await request(app).post(BASE).send(VALID_RULE)

    expect(res.status).toBe(403)
    expect(res.body.error).toBeDefined()
  })

  it('403 – non-admin (verifier role) cannot create a rule', async () => {
    const app = createApp()
    asVerifier()

    const res = await request(app).post(BASE).send(VALID_RULE)

    expect(res.status).toBe(403)
  })

  it('401 – unauthenticated request is rejected', async () => {
    const app = createApp()
    asUnauthenticated()

    const res = await request(app).post(BASE).send(VALID_RULE)

    expect(res.status).toBe(401)
  })

  // ── Zod validation ──────────────────────────────────────────────────────

  it('400 – missing required field "effect" returns validation error envelope', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'org:read', resource: '*' })

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
    expect(Array.isArray(res.body.details)).toBe(true)
    expect(res.body.details.some((d: { path: string }) => d.path === 'effect')).toBe(true)
  })

  it('400 – invalid action enum value returns validation error', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'invalid:action', resource: '*', effect: 'allow' })

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
    expect(Array.isArray(res.body.details)).toBe(true)
  })

  it('400 – extra unknown fields are rejected by strict schema', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app)
      .post(BASE)
      .send({ ...VALID_RULE, unknownField: 'bad' })

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
  })

  it('400 – invalid effect value returns validation error', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'org:read', resource: '*', effect: 'maybe' })

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
  })

  it('400 – empty subject string fails min-length validation', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app)
      .post(BASE)
      .send({ subject: '', action: 'org:read', resource: '*', effect: 'allow' })

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
    expect(res.body.details.some((d: { path: string }) => d.path === 'subject')).toBe(true)
  })

  it('400 – empty resource string fails min-length validation', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'org:read', resource: '', effect: 'allow' })

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
  })
})

// ===========================================================================
// GET /api/orgs/:orgId/policies  – list rules
// ===========================================================================

describe('GET /api/orgs/:orgId/policies', () => {
  it('200 – admin can list rules even with an empty store', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app).get(BASE)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data).toHaveLength(0)
    // Pagination meta
    expect(res.body.total).toBe(0)
    expect(typeof res.body.page).toBe('number')
    expect(typeof res.body.limit).toBe('number')
    expect(typeof res.body.hasNext).toBe('boolean')
  })

  it('200 – lists created rules and returns them in the data array', async () => {
    const app = createApp()
    asAdmin()

    // Seed two rules via the API
    await request(app).post(BASE).send(VALID_RULE)
    await request(app)
      .post(BASE)
      .send({ subject: 'admin', action: 'org:update', resource: `org:${ORG}`, effect: 'allow' })

    const res = await request(app).get(BASE)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.total).toBe(2)
  })

  it('200 – pagination params (limit=1, page=1) are respected', async () => {
    const app = createApp()
    asAdmin()

    // Seed two rules
    await request(app).post(BASE).send(VALID_RULE)
    await request(app)
      .post(BASE)
      .send({ subject: 'admin', action: 'org:update', resource: '*', effect: 'allow' })

    const res = await request(app).get(`${BASE}?limit=1&page=1`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.limit).toBe(1)
    expect(res.body.hasNext).toBe(true)
  })

  it('200 – user with an org:policy:read allow rule can list rules', async () => {
    const app = createApp()

    // Admin seeds the read-access rule
    asAdmin()
    await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'org:policy:read', resource: `org:${ORG}`, effect: 'allow' })

    // Now user should be allowed
    asUser()
    const res = await request(app).get(BASE)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('403 – user without any allow rule is denied list access', async () => {
    const app = createApp()
    asUser()

    const res = await request(app).get(BASE)

    expect(res.status).toBe(403)
  })

  it('401 – unauthenticated request is rejected', async () => {
    const app = createApp()
    asUnauthenticated()

    const res = await request(app).get(BASE)

    expect(res.status).toBe(401)
  })

  it('400 – limit above max (101) returns validation error', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app).get(`${BASE}?limit=101`)

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
  })

  it('200 – limit=100 (max) returns all rules up to 100', async () => {
    const app = createApp()
    asAdmin()

    // Seed 3 rules
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(BASE)
        .send({ subject: 'user', action: 'org:read', resource: `res-${i}`, effect: 'allow' })
    }

    const res = await request(app).get(`${BASE}?limit=100&page=1`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(3)
    expect(res.body.limit).toBe(100)
  })
})

// ===========================================================================
// GET /api/orgs/:orgId/policies/:ruleId  – get single rule
// ===========================================================================

describe('GET /api/orgs/:orgId/policies/:ruleId', () => {
  it('200 – admin fetches an existing rule by id', async () => {
    const app = createApp()
    asAdmin()

    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    const res = await request(app).get(`${BASE}/${ruleId}`)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.id).toBe(ruleId)
    expect(res.body.data.orgId).toBe(ORG)
  })

  it('404 – fetching a non-existent rule id returns 404', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app).get(`${BASE}/nonexistent-rule-id`)

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })

  it('200 – user with org:policy:read allow rule can get a single rule', async () => {
    const app = createApp()

    // Seed the read-access rule + a rule to retrieve
    asAdmin()
    await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'org:policy:read', resource: `org:${ORG}`, effect: 'allow' })
    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    asUser()
    const res = await request(app).get(`${BASE}/${ruleId}`)

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(ruleId)
  })

  it('403 – user without allow rule cannot get a rule', async () => {
    const app = createApp()

    // Admin seeds a rule but no read access for users
    asAdmin()
    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    asUser()
    const res = await request(app).get(`${BASE}/${ruleId}`)

    expect(res.status).toBe(403)
  })

  it('401 – unauthenticated request is rejected', async () => {
    const app = createApp()
    asUnauthenticated()

    const res = await request(app).get(`${BASE}/any-rule-id`)

    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// PATCH /api/orgs/:orgId/policies/:ruleId  – update rule
// ===========================================================================

describe('PATCH /api/orgs/:orgId/policies/:ruleId', () => {
  it('200 – admin can update an existing rule', async () => {
    const app = createApp()
    asAdmin()

    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    const res = await request(app)
      .patch(`${BASE}/${ruleId}`)
      .send({ effect: 'deny' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.effect).toBe('deny')
    expect(res.body.data.id).toBe(ruleId)
    // updatedAt must have changed
    expect(res.body.data.updatedAt).not.toBe(createRes.body.data.updatedAt)
  })

  it('200 – admin can update subject and action', async () => {
    const app = createApp()
    asAdmin()

    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    const res = await request(app)
      .patch(`${BASE}/${ruleId}`)
      .send({ subject: 'admin', action: 'org:update' })

    expect(res.status).toBe(200)
    expect(res.body.data.subject).toBe('admin')
    expect(res.body.data.action).toBe('org:update')
    // Other fields unchanged
    expect(res.body.data.resource).toBe('*')
    expect(res.body.data.effect).toBe('allow')
  })

  it('404 – patching a non-existent rule returns 404', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app).patch(`${BASE}/no-such-rule`).send({ effect: 'deny' })

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })

  it('403 – non-admin user cannot update a rule', async () => {
    const app = createApp()

    asAdmin()
    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    asUser()
    const res = await request(app).patch(`${BASE}/${ruleId}`).send({ effect: 'deny' })

    expect(res.status).toBe(403)
  })

  it('401 – unauthenticated request is rejected', async () => {
    const app = createApp()
    asUnauthenticated()

    const res = await request(app).patch(`${BASE}/some-id`).send({ effect: 'deny' })

    expect(res.status).toBe(401)
  })

  it('400 – invalid action in patch body returns validation error', async () => {
    const app = createApp()
    asAdmin()

    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    const res = await request(app)
      .patch(`${BASE}/${ruleId}`)
      .send({ action: 'totally:invalid:action' })

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
  })

  it('400 – extra unknown fields in patch body are rejected', async () => {
    const app = createApp()
    asAdmin()

    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    const res = await request(app)
      .patch(`${BASE}/${ruleId}`)
      .send({ effect: 'deny', hackerField: 'injected' })

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
  })
})

// ===========================================================================
// DELETE /api/orgs/:orgId/policies/:ruleId  – delete rule
// ===========================================================================

describe('DELETE /api/orgs/:orgId/policies/:ruleId', () => {
  it('204 – admin can delete an existing rule (no body)', async () => {
    const app = createApp()
    asAdmin()

    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    const deleteRes = await request(app).delete(`${BASE}/${ruleId}`)

    expect(deleteRes.status).toBe(204)
    expect(deleteRes.body).toEqual({})

    // Rule is no longer retrievable
    const getRes = await request(app).get(`${BASE}/${ruleId}`)
    expect(getRes.status).toBe(404)
  })

  it('404 – deleting a non-existent rule returns 404', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app).delete(`${BASE}/ghost-rule`)

    expect(res.status).toBe(404)
  })

  it('403 – non-admin user cannot delete a rule', async () => {
    const app = createApp()

    asAdmin()
    const createRes = await request(app).post(BASE).send(VALID_RULE)
    const ruleId = createRes.body.data.id

    asUser()
    const deleteRes = await request(app).delete(`${BASE}/${ruleId}`)

    expect(deleteRes.status).toBe(403)

    // Confirm rule still exists
    asAdmin()
    const getRes = await request(app).get(`${BASE}/${ruleId}`)
    expect(getRes.status).toBe(200)
  })

  it('401 – unauthenticated request is rejected', async () => {
    const app = createApp()
    asUnauthenticated()

    const res = await request(app).delete(`${BASE}/some-id`)

    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// Allow / deny decision path – end-to-end through requirePolicy middleware
// ===========================================================================

describe('Policy evaluation – allow/deny decision path', () => {
  /**
   * The `requirePolicy` middleware calls `policyService.authorize()` which
   * runs the evaluator against the shared policyStore. These tests verify the
   * full wiring from HTTP request → middleware → evaluator → response.
   *
   * Decision matrix under test:
   *   - allow rule + matching caller      → 200
   *   - deny rule wins over allow rule    → 403 (deny-wins)
   *   - admin with no rules              → 200 (admin fallback)
   *   - verifier with no rules           → 403
   *   - role inheritance user→verifier   → 200
   *   - wildcard action rule             → 200
   *   - empty rule set, non-admin        → 403 (deny-by-default)
   */

  it('ALLOW – explicit allow rule grants access to a user', async () => {
    const app = createApp()

    asAdmin()
    await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'org:policy:read', resource: `org:${ORG}`, effect: 'allow' })

    asUser()
    const res = await request(app).get(BASE)
    expect(res.status).toBe(200)
  })

  it('DENY – explicit deny rule wins over a conflicting allow rule', async () => {
    /**
     * Both an allow and a deny rule match. The evaluator must choose deny.
     * This exercises the "deny wins" algorithm in PolicyEvaluator.
     */
    const app = createApp()
    asAdmin()

    await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'org:policy:read', resource: `org:${ORG}`, effect: 'allow' })
    await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'org:policy:read', resource: `org:${ORG}`, effect: 'deny' })

    asUser()
    const res = await request(app).get(BASE)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Forbidden')
    expect(typeof res.body.reason).toBe('string')
    expect(res.body.reason).toMatch(/explicit deny/i)
  })

  it('ALLOW (admin fallback) – admin accesses list even when no explicit rules exist', async () => {
    const app = createApp()
    asAdmin()

    // No rules seeded
    const res = await request(app).get(BASE)
    expect(res.status).toBe(200)
  })

  it('DENY (deny-by-default) – empty rule set denies non-admin callers', async () => {
    const app = createApp()
    asUser()

    const res = await request(app).get(BASE)
    expect(res.status).toBe(403)
    expect(res.body.reason).toMatch(/deny by default/i)
  })

  it('DENY – verifier without an explicit allow rule is denied', async () => {
    /**
     * Verifier weight < admin (weight 3), so the admin fallback does not apply.
     * Without an explicit allow rule the evaluator falls through to deny-by-default.
     */
    const app = createApp()
    asVerifier()

    const res = await request(app).get(BASE)
    expect(res.status).toBe(403)
  })

  it('ALLOW (role inheritance) – allow rule for "user" also grants access to verifier', async () => {
    /**
     * The evaluator's subject-matching is hierarchical: a rule granting 'user'
     * also matches callers with higher roles (verifier, admin).
     */
    const app = createApp()
    asAdmin()
    await request(app)
      .post(BASE)
      .send({ subject: 'user', action: 'org:policy:read', resource: `org:${ORG}`, effect: 'allow' })

    asVerifier()
    const res = await request(app).get(BASE)
    expect(res.status).toBe(200)
  })

  it('ALLOW – wildcard action rule grants access for any action', async () => {
    const app = createApp()
    asAdmin()
    await request(app)
      .post(BASE)
      .send({ subject: 'user', action: '*', resource: `org:${ORG}`, effect: 'allow' })

    asUser()
    const res = await request(app).get(BASE)
    expect(res.status).toBe(200)
  })

  it('ALLOW – wildcard subject rule grants access to all callers', async () => {
    const app = createApp()
    asAdmin()
    await request(app)
      .post(BASE)
      .send({ subject: '*', action: 'org:policy:read', resource: `org:${ORG}`, effect: 'allow' })

    asUser()
    const res = await request(app).get(BASE)
    expect(res.status).toBe(200)
  })

  it('ALLOW – user-specific subject matches that user exactly', async () => {
    const app = createApp()
    asAdmin()
    // Grant only actor-user specifically
    await request(app)
      .post(BASE)
      .send({ subject: 'user:actor-user', action: 'org:policy:read', resource: `org:${ORG}`, effect: 'allow' })

    asUser()
    const res = await request(app).get(BASE)
    expect(res.status).toBe(200)
  })

  it('DENY – user-specific subject does not match a different user', async () => {
    /**
     * The allow rule is for 'user:actor-verifier'. The caller is actor-user.
     * Verifier-specific grant must not bleed to a different user.
     */
    const app = createApp()
    asAdmin()
    await request(app)
      .post(BASE)
      .send({ subject: 'user:actor-verifier', action: 'org:policy:read', resource: `org:${ORG}`, effect: 'allow' })

    asUser()
    const res = await request(app).get(BASE)
    // actor-user is not actor-verifier → no match → deny-by-default
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// Response envelope consistency
// ===========================================================================

describe('Response envelope shape – consistency across success and error paths', () => {
  it('all successful mutation/read endpoints share { success: true, data }', async () => {
    const app = createApp()
    asAdmin()

    // POST → 201
    const postRes = await request(app).post(BASE).send(VALID_RULE)
    expect(postRes.body).toHaveProperty('success', true)
    expect(postRes.body).toHaveProperty('data')

    const ruleId = postRes.body.data.id

    // GET one → 200
    const getOneRes = await request(app).get(`${BASE}/${ruleId}`)
    expect(getOneRes.body).toHaveProperty('success', true)
    expect(getOneRes.body).toHaveProperty('data')

    // GET list → 200
    const listRes = await request(app).get(BASE)
    expect(listRes.body).toHaveProperty('success', true)
    expect(listRes.body).toHaveProperty('data')
    // List also includes pagination meta
    expect(typeof listRes.body.total).toBe('number')
    expect(typeof listRes.body.page).toBe('number')
    expect(typeof listRes.body.limit).toBe('number')
    expect(typeof listRes.body.hasNext).toBe('boolean')

    // PATCH → 200
    const patchRes = await request(app).patch(`${BASE}/${ruleId}`).send({ effect: 'deny' })
    expect(patchRes.body).toHaveProperty('success', true)
    expect(patchRes.body).toHaveProperty('data')
  })

  it('401 envelope includes error field', async () => {
    const app = createApp()
    asUnauthenticated()

    const res = await request(app).post(BASE).send(VALID_RULE)

    expect(res.status).toBe(401)
    expect(res.body).toHaveProperty('error')
  })

  it('403 from requireAdminRole includes error field', async () => {
    const app = createApp()
    asUser()

    const res = await request(app).post(BASE).send(VALID_RULE)

    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('error')
  })

  it('403 from requirePolicy includes reason field from evaluator', async () => {
    const app = createApp()
    asUser()

    // No rules → deny-by-default reason surfaced in response
    const res = await request(app).get(BASE)

    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('reason')
    expect(typeof res.body.reason).toBe('string')
  })

  it('400 validation envelope includes error_code and details array with path/message/code', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app)
      .post(BASE)
      .send({ subject: 'user' }) // missing action, resource, effect

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe('validation_failed')
    expect(Array.isArray(res.body.details)).toBe(true)
    // Each detail item has the three required fields
    const detail = res.body.details[0]
    expect(detail).toHaveProperty('path')
    expect(detail).toHaveProperty('message')
    expect(detail).toHaveProperty('code')
  })
})

// ===========================================================================
// Edge cases
// ===========================================================================

describe('Edge cases', () => {
  it('malformed JSON body is rejected before the route handler runs', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app)
      .post(BASE)
      .set('Content-Type', 'application/json')
      .send('{ invalid json }')

    // Express json() throws a SyntaxError on malformed JSON. In production this
    // is caught by requestSizeLimitErrorHandler and returned as 400. The minimal
    // test app's generic error handler returns 500 for non-AppErrors, but the key
    // assertion is that the request never reaches the route handler (no 2xx/3xx).
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('each test is isolated: rules from a prior test are not visible', async () => {
    // beforeEach resets the store; the store should always be empty at test start
    const app = createApp()
    asAdmin()

    const listRes = await request(app).get(BASE)
    expect(listRes.status).toBe(200)
    expect(listRes.body.data).toHaveLength(0)
  })

  it('unknown policy id on GET /:ruleId returns 404', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app).get(`${BASE}/00000000deadbeef`)

    expect(res.status).toBe(404)
  })

  it('PATCH on unknown rule id returns 404', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app).patch(`${BASE}/00000000deadbeef`).send({ effect: 'deny' })

    expect(res.status).toBe(404)
  })

  it('DELETE on unknown rule id returns 404', async () => {
    const app = createApp()
    asAdmin()

    const res = await request(app).delete(`${BASE}/00000000deadbeef`)

    expect(res.status).toBe(404)
  })
})
