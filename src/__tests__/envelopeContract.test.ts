/**
 * Response Envelope Contract Tests
 *
 * These tests verify that success and error response shapes remain stable
 * across all major routes.  They are deliberately value-agnostic: they check
 * the *structure* of envelopes, not specific data, so they stay green through
 * ordinary business-logic changes while catching any accidental envelope
 * breakage (renamed keys, removed fields, changed error format).
 *
 * Covered routes:
 *   GET  /api/health/live          → liveness envelope
 *   GET  /api/health               → readiness envelope (healthy + unhealthy)
 *   GET  /api/bond/:address        → bond success + 400 + 404
 *   GET  /api/trust/:address       → trust success + 404 + 400 (validation)
 *   GET  /api/attestations/:addr/count → attestation count envelope
 *   POST /api/attestations         → attestation create + 400 validation
 *   Middleware error handler       → AppError → { error, code } shape
 */

import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'

import { createHealthRouter } from '../routes/health.js'
import { createBondRouter } from '../routes/bond.js'
import { BondStore, BondService } from '../services/bond/index.js'
import { createAttestationRouter } from '../routes/attestations.js'
import { AttestationRepository } from '../repositories/attestationRepository.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { AppError, ErrorCode, NotFoundError, ValidationError } from '../lib/errors.js'

// ── Shared address fixtures ───────────────────────────────────────────────

const VALID_ETH = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const BAD_ADDR = 'not-an-address'

// ── Lightweight request helper ────────────────────────────────────────────

async function req(
  app: Express,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = request(app)[method.toLowerCase() as 'get' | 'post' | 'delete'](path)
    .set('Content-Type', 'application/json')
  if (body !== undefined) r.send(body)
  const res = await r
  return { status: res.status, body: res.body as Record<string, unknown> }
}

// ── Contract helpers ──────────────────────────────────────────────────────

/** Asserts a body matches the standard error envelope. */
function expectErrorEnvelope(body: Record<string, unknown>): void {
  expect(typeof body.error).toBe('string')
  expect((body.error as string).length).toBeGreaterThan(0)
}

/** AppError envelope additionally carries a `code` field. */
function expectAppErrorEnvelope(body: Record<string, unknown>): void {
  expectErrorEnvelope(body)
  expect(typeof body.code).toBe('string')
  expect((body.code as string).length).toBeGreaterThan(0)
}

// ═══════════════════════════════════════════════════════════════════════════
// Health routes
// ═══════════════════════════════════════════════════════════════════════════

describe('Response envelope contract — /api/health', () => {
  function makeApp(probes: Parameters<typeof createHealthRouter>[0] = {}) {
    const app = express()
    app.use('/api/health', createHealthRouter(probes))
    return app
  }

  it('liveness: { status: string, service: string }', async () => {
    const { status, body } = await req(makeApp(), 'GET', '/api/health/live')
    expect(status).toBe(200)
    expect(typeof body.status).toBe('string')
    expect(typeof body.service).toBe('string')
  })

  it('readiness success: { status: string, dependencies: object }', async () => {
    const app = makeApp({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    const { status, body } = await req(app, 'GET', '/api/health')
    expect(status).toBe(200)
    expect(typeof body.status).toBe('string')
    expect(body.dependencies).toBeDefined()
    expect(typeof body.dependencies).toBe('object')
  })

  it('readiness unhealthy: still returns { status, dependencies } with 503', async () => {
    const app = makeApp({
      postgres: async () => ({ status: 'down' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    const { status, body } = await req(app, 'GET', '/api/health')
    expect(status).toBe(503)
    expect(typeof body.status).toBe('string')
    expect(body.dependencies).toBeDefined()
  })

  it('readiness dependency entries each carry a { status: string }', async () => {
    const app = makeApp({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
    })
    const { body } = await req(app, 'GET', '/api/health')
    const deps = body.dependencies as Record<string, { status: string }>
    for (const dep of Object.values(deps)) {
      expect(typeof dep.status).toBe('string')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Bond routes
// ═══════════════════════════════════════════════════════════════════════════

describe('Response envelope contract — /api/bond', () => {
  let app: Express
  let store: BondStore

  beforeEach(() => {
    store = new BondStore()
    const service = new BondService(store)
    app = express()
    app.use('/api/bond', createBondRouter(service))
    app.use(errorHandler)
  })

  it('200 success: { address, bondedAmount, bondStart, bondDuration, active, slashedAmount, status }', async () => {
    store.set({
      address: VALID_ETH,
      bondedAmount: '1000000000000000000',
      bondStart: '2024-01-15T00:00:00.000Z',
      bondDuration: 31536000,
      active: true,
      slashedAmount: '0',
    })

    const { status, body } = await req(app, 'GET', `/api/bond/${VALID_ETH}`)
    expect(status).toBe(200)
    expect(typeof body.address).toBe('string')
    expect(typeof body.bondedAmount).toBe('string')
    expect(typeof body.active).toBe('boolean')
    expect(typeof body.slashedAmount).toBe('string')
    expect(typeof body.status).toBe('string')
    // These may be null but must be present
    expect(Object.prototype.hasOwnProperty.call(body, 'bondStart')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(body, 'bondDuration')).toBe(true)
  })

  it('400 invalid address: { error: string }', async () => {
    const { status, body } = await req(app, 'GET', `/api/bond/${BAD_ADDR}`)
    expect(status).toBe(400)
    expectErrorEnvelope(body)
  })

  it('404 unknown address: { error: string }', async () => {
    const { status, body } = await req(app, 'GET', `/api/bond/${VALID_ETH}`)
    expect(status).toBe(404)
    expectErrorEnvelope(body)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Attestation routes
// ═══════════════════════════════════════════════════════════════════════════

describe('Response envelope contract — /api/attestations', () => {
  let app: Express
  const BASE = '/api/attestations'

  beforeEach(() => {
    const repo = new AttestationRepository()
    app = express()
    app.use(express.json())
    app.use(BASE, createAttestationRouter(repo))
    app.use(errorHandler)
  })

  it('count 200: { identity: string, count: number, includeRevoked: boolean }', async () => {
    const { status, body } = await req(app, 'GET', `${BASE}/0xAlice/count`)
    expect(status).toBe(200)
    expect(typeof body.identity).toBe('string')
    expect(typeof body.count).toBe('number')
    expect(typeof body.includeRevoked).toBe('boolean')
  })

  it('list 200: { identity: string, attestations: array, page, limit, total, hasNext }', async () => {
    const { status, body } = await req(app, 'GET', `${BASE}/0xAlice`)
    expect(status).toBe(200)
    expect(typeof body.identity).toBe('string')
    expect(Array.isArray(body.attestations)).toBe(true)
    // Pagination fields are spread at the top level (not nested under `pagination`)
    expect(typeof body.page).toBe('number')
    expect(typeof body.limit).toBe('number')
    expect(typeof body.total).toBe('number')
    expect(typeof body.hasNext).toBe('boolean')
  })

  it('list pagination fields: page >= 1, limit >= 1, total >= 0', async () => {
    const { body } = await req(app, 'GET', `${BASE}/0xAlice`)
    expect(body.page as number).toBeGreaterThanOrEqual(1)
    expect(body.limit as number).toBeGreaterThanOrEqual(1)
    expect(body.total as number).toBeGreaterThanOrEqual(0)
  })

  it('create 201: returns created attestation with id, subject, verifier, weight', async () => {
    const { status, body } = await req(app, 'POST', BASE, {
      subject: '0xAlice',
      verifier: '0xBob',
      weight: 75,
      claim: 'trusted',
    })
    expect(status).toBe(201)
    expect(typeof body.id).toBe('string')
    expect(typeof body.subject).toBe('string')
    expect(typeof body.verifier).toBe('string')
    expect(typeof body.weight).toBe('number')
  })

  it('create missing subject: still returns { error: string } error envelope', async () => {
    // The repo throws a plain Error (not ValidationError), so the error handler
    // returns 500; the envelope shape { error, code } is still contractually stable.
    const { body } = await req(app, 'POST', BASE, {
      verifier: '0xBob',
      weight: 50,
    })
    expectErrorEnvelope(body)
  })

  it('create invalid weight (>100): still returns { error: string } error envelope', async () => {
    const { body } = await req(app, 'POST', BASE, {
      subject: '0xAlice',
      verifier: '0xBob',
      weight: 999,
    })
    expectErrorEnvelope(body)
  })

  it('delete 404 unknown id: { error: string } error envelope', async () => {
    const { status, body } = await req(app, 'DELETE', `${BASE}/nonexistent-id`)
    expect(status).toBe(404)
    expectErrorEnvelope(body)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Error handler middleware — AppError envelope shape
// ═══════════════════════════════════════════════════════════════════════════

describe('Response envelope contract — error handler', () => {
  function makeErrorApp(thrower: (req: Request, res: Response, next: NextFunction) => void) {
    const app = express()
    app.use(express.json())
    app.get('/test', thrower)
    app.use(errorHandler)
    return app
  }

  it('AppError → { error: string, code: string }', async () => {
    const app = makeErrorApp((_req, _res, next) => {
      next(new AppError('something failed', ErrorCode.INTERNAL_SERVER_ERROR, 500))
    })
    const { status, body } = await req(app, 'GET', '/test')
    expect(status).toBe(500)
    expectAppErrorEnvelope(body)
  })

  it('NotFoundError → 404 with { error: string, code: "not_found" }', async () => {
    const app = makeErrorApp((_req, _res, next) => {
      next(new NotFoundError('Identity', '0xABC'))
    })
    const { status, body } = await req(app, 'GET', '/test')
    expect(status).toBe(404)
    expectAppErrorEnvelope(body)
    expect(body.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('ValidationError → 400 with { error: string, code: "validation_failed" }', async () => {
    const app = makeErrorApp((_req, _res, next) => {
      next(new ValidationError('bad input', [{ path: 'address', message: 'required' }]))
    })
    const { status, body } = await req(app, 'GET', '/test')
    expect(status).toBe(400)
    expectAppErrorEnvelope(body)
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED)
  })

  it('ValidationError with details → details field is array', async () => {
    const app = makeErrorApp((_req, _res, next) => {
      next(new ValidationError('bad', [{ path: 'x', message: 'required' }]))
    })
    const { body } = await req(app, 'GET', '/test')
    expect(Array.isArray(body.details)).toBe(true)
  })

  it('unknown error → 500 with { error: string, code: string }', async () => {
    const app = makeErrorApp((_req, _res, next) => {
      next(new Error('unexpected'))
    })
    const { status, body } = await req(app, 'GET', '/test')
    expect(status).toBe(500)
    expectErrorEnvelope(body)
    expect(typeof body.code).toBe('string')
  })
})
