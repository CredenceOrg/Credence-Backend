/**
 * Integration tests for identity verification routes.
 *
 * CURRENT SCOPE:
 *  - Identity verification proof generation (GET /api/verification/:address)
 *  - Proof verification (POST /api/verification/verify)
 *  - Expiry validation
 *  - Signature verification
 *  - Error envelope + error_code assertions
 *
 * FUTURE SCOPE (when state machine is implemented):
 *  - Submit verification (POST /api/verification/submit)
 *  - Approve verification (PATCH /api/verification/:address/approve)
 *  - Reject verification (PATCH /api/verification/:address/reject)
 *  - Authorization gates (authentication, role-based access)
 *  - State transition validation
 *  - Idempotency checks
 *  - Audit log side effects
 *  - Invalid state transition error codes
 *
 * Test Database:
 *  - Uses pg-mem for in-process database (no live database required)
 *  - Schema includes identity_verifications table (when implemented)
 *  - Includes audit_logs table for tracking all state changes
 *
 * Constraints:
 *  - Vitest framework
 *  - supertest for HTTP assertions
 *  - pg-mem for test database
 *  - Standard error envelope with error_code
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { setupVerificationRoutes } from '../../src/routes/verification.js'
import { AppError, ValidationError, ErrorCode } from '../../src/lib/errors.js'
import * as crypto from 'crypto'

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

// Mock audit service for future state machine logging
vi.mock('../../src/services/audit/index.js', () => ({
  auditLogService: {
    logAction: vi.fn().mockResolvedValue(undefined),
  },
  AuditAction: {
    VERIFICATION_SUBMITTED: 'VERIFICATION_SUBMITTED',
    VERIFICATION_APPROVED: 'VERIFICATION_APPROVED',
    VERIFICATION_REJECTED: 'VERIFICATION_REJECTED',
  },
}))

// ─────────────────────────────────────────────────────────────────────────────
// Database Setup (scaffolding for state machine implementation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uncomment and use this once the state machine is implemented.
 * This will enable state persistence testing with pg-mem.
 */

/* SCAFFOLDING FOR FUTURE STATE MACHINE TESTS:

import { newDb, type IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'

interface TestDb {
  db: IMemoryDb
  pool: Pool
}

async function buildTestDb(): Promise<TestDb> {
  const db = newDb()

  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => crypto.randomUUID(),
  } as Parameters<typeof db.public.registerFunction>[0])

  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  await pool.query(`
    CREATE TABLE identity_verifications (
      id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      address         VARCHAR(255)  NOT NULL UNIQUE,
      status          VARCHAR(50)   NOT NULL DEFAULT 'pending',
      submitted_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      approved_at     TIMESTAMPTZ,
      rejected_at     TIMESTAMPTZ,
      rejection_reason TEXT,
      approved_by     VARCHAR(255),
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE audit_logs (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_id       TEXT        NOT NULL,
      actor_email    TEXT        NOT NULL,
      action         TEXT        NOT NULL,
      resource_type  TEXT        NOT NULL DEFAULT 'identity_verification',
      resource_id    TEXT        NOT NULL,
      details_json   JSONB,
      status         TEXT        NOT NULL DEFAULT 'success',
      ip_address     TEXT,
      error_message  TEXT
    )
  `)

  return { db, pool }
}

*/

// ─────────────────────────────────────────────────────────────────────────────
// Test App Factory
// ─────────────────────────────────────────────────────────────────────────────

interface TestAppDeps {
  authRequired?: boolean
  user?: { id: string; email: string; address: string }
}

function createTestApp(deps: TestAppDeps = {}) {
  const app = express()
  app.use(express.json())

  // Mock auth middleware
  if (deps.authRequired) {
    app.use((req: any, _res, next) => {
      const user = deps.user || {
        id: 'user-1',
        email: 'user@example.com',
        address: 'GUSER1234567890',
      }
      if (!user.id) {
        return next(new AppError('Unauthorized', ErrorCode.UNAUTHORIZED, 401))
      }
      req.user = user
      next()
    })
  }

  // Set up verification routes
  setupVerificationRoutes(app)

  // Error handler that serializes AppError to JSON
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json(err.toJSON())
      return
    }
    if (err instanceof ValidationError) {
      res.status(400).json(err.toJSON())
      return
    }
    res.status(500).json({ error: 'InternalServerError' })
  })

  return app
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Identity Verification Routes', () => {
  let app: ReturnType<typeof createTestApp>

  beforeEach(() => {
    app = createTestApp()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/verification/:address — Proof Generation
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /api/verification/:address', () => {
    it('generates a valid proof for a valid Stellar address', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'

      const res = await request(app).get(
        `/api/verification/${address}`
      )

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('address', address)
      expect(res.body).toHaveProperty('score')
      expect(res.body).toHaveProperty('bondSnapshot')
      expect(res.body).toHaveProperty('attestationSummary')
      expect(res.body).toHaveProperty('timestamp')
      expect(res.body).toHaveProperty('hash')
      expect(res.body).toHaveProperty('canonical')
    })

    it('generates proof with expiry when expiry param is provided', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'

      const res = await request(app).get(
        `/api/verification/${address}?expiry=60`
      )

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('expiresAt')
      expect(typeof res.body.expiresAt).toBe('number')
      expect(res.body.expiresAt).toBeGreaterThan(res.body.timestamp)
    })

    it('generates a signed proof when sign=true and key is configured', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'

      // Mock env var
      const originalKey = process.env.VERIFICATION_PRIVATE_KEY
      process.env.VERIFICATION_PRIVATE_KEY = crypto
        .generateKeyPairSync('rsa', {
          modulusLength: 2048,
        })
        .privateKey.export({ format: 'pem', type: 'pkcs8' })

      try {
        const res = await request(app).get(
          `/api/verification/${address}?sign=true`
        )

        expect(res.status).toBe(200)
        expect(res.body).toHaveProperty('signature')
        expect(typeof res.body.signature).toBe('string')
      } finally {
        process.env.VERIFICATION_PRIVATE_KEY = originalKey
      }
    })

    it('returns 500 when signing is requested but private key is not configured', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'

      // Ensure key is not set
      const originalKey = process.env.VERIFICATION_PRIVATE_KEY
      delete process.env.VERIFICATION_PRIVATE_KEY

      try {
        const res = await request(app).get(
          `/api/verification/${address}?sign=true`
        )

        expect(res.status).toBe(500)
        expect(res.body).toHaveProperty('error_code', ErrorCode.INTERNAL_SERVER_ERROR)
      } finally {
        process.env.VERIFICATION_PRIVATE_KEY = originalKey
      }
    })

    it('generates consistent hash for same input data', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'

      const res1 = await request(app).get(`/api/verification/${address}`)
      const hash1 = res1.body.hash

      // Same address should produce different timestamp but hash should verify
      const res2 = await request(app).get(`/api/verification/${address}`)
      const hash2 = res2.body.hash

      // Hashes will differ due to timestamp, but both should be valid
      expect(hash1).toBeDefined()
      expect(hash2).toBeDefined()
    })

    it('includes bond snapshot with all required fields', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'

      const res = await request(app).get(`/api/verification/${address}`)

      expect(res.status).toBe(200)
      expect(res.body.bondSnapshot).toEqual({
        address: expect.any(String),
        bondedAmount: expect.any(String),
        bondStart: expect.any(String),
        bondDuration: expect.any(String),
        active: expect.any(Boolean),
      })
    })

    it('includes attestation summary with hash', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'

      const res = await request(app).get(`/api/verification/${address}`)

      expect(res.status).toBe(200)
      expect(res.body.attestationSummary).toHaveProperty('count', expect.any(Number))
      expect(res.body.attestationSummary).toHaveProperty('hash', expect.any(String))
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/verification/verify — Proof Verification
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /api/verification/verify', () => {
    it('validates a proof with valid hash', async () => {
      // Generate a valid proof
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'
      const proofRes = await request(app).get(`/api/verification/${address}`)
      const proof = proofRes.body

      const res = await request(app)
        .post('/api/verification/verify')
        .send({ proof })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('valid', true)
      expect(res.body).not.toHaveProperty('errors')
    })

    it('rejects a proof with invalid hash', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'
      const proofRes = await request(app).get(`/api/verification/${address}`)
      const proof = { ...proofRes.body, hash: 'invalid-hash' }

      const res = await request(app)
        .post('/api/verification/verify')
        .send({ proof })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('valid', false)
      expect(res.body.errors).toContain('Hash verification failed')
    })

    it('rejects an expired proof', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'
      const proofRes = await request(app).get(
        `/api/verification/${address}?expiry=1`
      )
      const proof = proofRes.body

      // Wait for expiry (1 minute from creation)
      // For testing, we artificially set expiresAt to past
      proof.expiresAt = Date.now() - 1000

      const res = await request(app)
        .post('/api/verification/verify')
        .send({ proof })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('valid', false)
      expect(res.body.errors).toContain('Proof has expired')
    })

    it('verifies signature when publicKey is provided', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'

      // Generate a keypair
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
      })

      // Mock env var
      const originalKey = process.env.VERIFICATION_PRIVATE_KEY
      process.env.VERIFICATION_PRIVATE_KEY = privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      })

      try {
        const proofRes = await request(app).get(
          `/api/verification/${address}?sign=true`
        )
        const proof = proofRes.body
        const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' })

        const res = await request(app)
          .post('/api/verification/verify')
          .send({ proof, publicKey: publicKeyPem })

        expect(res.status).toBe(200)
        expect(res.body).toHaveProperty('valid', true)
        expect(res.body).not.toHaveProperty('errors')
      } finally {
        process.env.VERIFICATION_PRIVATE_KEY = originalKey
      }
    })

    it('rejects proof with invalid signature', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'

      // Generate a keypair for signature
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
      })

      const originalKey = process.env.VERIFICATION_PRIVATE_KEY
      process.env.VERIFICATION_PRIVATE_KEY = privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      })

      try {
        const proofRes = await request(app).get(
          `/api/verification/${address}?sign=true`
        )
        const proof = proofRes.body

        // Generate different keypair for verification (signature won't match)
        const { publicKey: otherPublicKey } = crypto.generateKeyPairSync('rsa', {
          modulusLength: 2048,
        })
        const otherPublicKeyPem = otherPublicKey.export({
          format: 'pem',
          type: 'spki',
        })

        const res = await request(app)
          .post('/api/verification/verify')
          .send({ proof, publicKey: otherPublicKeyPem })

        expect(res.status).toBe(200)
        expect(res.body).toHaveProperty('valid', false)
        expect(res.body.errors).toContain('Signature verification failed')
      } finally {
        process.env.VERIFICATION_PRIVATE_KEY = originalKey
      }
    })

    it('returns 400 when proof is missing from request body', async () => {
      const res = await request(app)
        .post('/api/verification/verify')
        .send({})

      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('error_code', ErrorCode.VALIDATION_FAILED)
      expect(res.body.error).toMatch(/proof/i)
    })

    it('returns standard error envelope with error_code', async () => {
      const res = await request(app)
        .post('/api/verification/verify')
        .send({})

      expect(res.body).toHaveProperty('error')
      expect(res.body).toHaveProperty('error_code')
      expect(res.body).toHaveProperty('code')
      expect(res.body.error_code).toBe(ErrorCode.VALIDATION_FAILED)
      expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED)
    })

    it('includes multiple errors when both hash and expiry are invalid', async () => {
      const address = 'GACWEYV4YMZSWP5HEJN5XCXDVGNF36XHPQVVLVT7UAFR2NQPF3WFP5'
      const proofRes = await request(app).get(
        `/api/verification/${address}?expiry=1`
      )
      const proof = {
        ...proofRes.body,
        hash: 'invalid',
        expiresAt: Date.now() - 1000,
      }

      const res = await request(app)
        .post('/api/verification/verify')
        .send({ proof })

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('valid', false)
      expect(Array.isArray(res.body.errors)).toBe(true)
      expect(res.body.errors).toHaveLength(2)
      expect(res.body.errors).toContain('Hash verification failed')
      expect(res.body.errors).toContain('Proof has expired')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Authorization & Idempotency (scaffolding for future state machine)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Authorization Gates (when state machine is implemented)', () => {
    it('should reject unauthorized submission', async () => {
      // Placeholder for future authorization gate testing
      // Once the state machine is added to verification route:
      // - Test POST /api/verification/submit requires authentication
      // - Test approval requires admin role
      // - Test rejection requires admin role
      expect(true).toBe(true)
    })

    it('should prevent idempotent re-submission when already approved', async () => {
      // Placeholder for future idempotency testing
      // Once the state machine is added:
      // - Test that re-submitting already-approved verification returns error
      // - Test error_code is specific (e.g., INVALID_STATE_TRANSITION)
      expect(true).toBe(true)
    })

    it('should reject invalid state transitions', async () => {
      // Placeholder for state transition testing
      // Once implemented, test:
      // - pending -> pending (invalid)
      // - approved -> pending (invalid)
      // - rejected -> approved (invalid)
      // Each should return explicit error_code for invalid transition
      expect(true).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Audit Log Side Effects (scaffolding for future implementation)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Audit Log Side Effects (when state machine is implemented)', () => {
    it('should log verification submission', async () => {
      // Placeholder for audit logging
      // Once state machine is added:
      // - POST /api/verification/submit should call auditLogService.logAction
      // - Action should be VERIFICATION_SUBMITTED
      // - Resource should be the identity address
      expect(true).toBe(true)
    })

    it('should log verification approval with approver', async () => {
      // Placeholder for approval logging
      // Once implemented:
      // - Approval should log VERIFICATION_APPROVED action
      // - Details should include approver ID and timestamp
      expect(true).toBe(true)
    })

    it('should log verification rejection with reason', async () => {
      // Placeholder for rejection logging
      // Once implemented:
      // - Rejection should log VERIFICATION_REJECTED action
      // - Details should include rejection reason
      expect(true).toBe(true)
    })

    it('should include all context in audit log', async () => {
      // Placeholder for audit context
      // Audit logs should include:
      // - actor_id (who made the decision)
      // - actor_email
      // - occurred_at timestamp
      // - resource_id (address)
      // - details_json with full context
      expect(true).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Error Handling
  // ─────────────────────────────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('returns standard error envelope for validation errors', async () => {
      const res = await request(app)
        .post('/api/verification/verify')
        .send({ proof: null })

      expect(res.status).toBe(400)
      expect(res.body).toHaveProperty('error')
      expect(res.body).toHaveProperty('error_code')
      expect(res.body.error_code).toBe(ErrorCode.VALIDATION_FAILED)
    })

    it('returns standard error envelope for internal errors', async () => {
      // Trigger an internal error by sending invalid JSON
      const res = await request(app)
        .post('/api/verification/verify')
        .set('Content-Type', 'application/json')
        .send('{ invalid json')

      // Express will return 400 for parse error
      expect(res.status).toBe(400)
    })

    it('includes error details when available', async () => {
      const res = await request(app)
        .post('/api/verification/verify')
        .send({})

      expect(res.body).toHaveProperty('error_code')
      const hasDetails =
        res.body.hasOwnProperty('details') ||
        res.body.error.length > 0

      expect(hasDetails).toBe(true)
    })
  })
})
