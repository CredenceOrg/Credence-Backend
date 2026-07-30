/**
 * @file API Contract tests.
 * Verifies that the API routes consistently return standard response envelopes
 * for both success and failure scenarios, conforming to the contract requirements.
 */

import { vi } from 'vitest'

// Run before imports so config schema validation doesn't fail
vi.hoisted(() => {
  process.env.DB_URL = 'postgresql://localhost:5432/credence_test'
  process.env.REDIS_URL = 'redis://localhost:6379'
  process.env.JWT_SECRET = 'test-secret-32chr-1234567890123456'
  process.env.REPORT_STORAGE_SIGNING_SECRET = 'test-secret-32chr-1234567890123456'
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

// Mock DB pool.js
vi.mock('../../src/db/pool.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    on: vi.fn(),
  },
  replicaPool: {},
  workerPool: {},
  withReplica: vi.fn(async (fn: (client: any) => Promise<any>) => fn({
    query: vi.fn().mockResolvedValue({ rows: [] })
  })),
}))

// Mock Redis cache.js
vi.mock('../../src/cache/redis.js', () => {
  const store = new Map()
  return {
    redisConnection: {
      connect: vi.fn(),
      getClient: vi.fn(),
      isHealthy: vi.fn(() => true),
      disconnect: vi.fn(),
    },
    cache: {
      get: vi.fn(async (ns: string, key: string) => store.get(`${ns}:${key}`) || null),
      set: vi.fn(async (ns: string, key: string, value: any) => { store.set(`${ns}:${key}`, value); return true; }),
      delete: vi.fn(async (ns: string, key: string) => { store.delete(`${ns}:${key}`); return true; }),
      healthCheck: vi.fn(async () => ({ healthy: true })),
    }
  }
})

// Mock trust identity repository
const mockIdentity = {
  address: '0x1111111111111111111111111111111111111111',
  bonded_amount: '1000000000000000000', // 1 ETH
  bond_start: '2025-01-01T00:00:00.000Z',
  attestation_count: 5,
}

vi.mock('../../src/db/repositories/trustIdentityRepository.js', () => {
  return {
    PgTrustIdentityRepository: class {
      getIdentityForScoring = vi.fn(async (address: string) => {
        if (address.toLowerCase() === mockIdentity.address.toLowerCase()) {
          return {
            address: mockIdentity.address,
            bondedAmount: mockIdentity.bonded_amount,
            bondStart: mockIdentity.bond_start,
            attestationCount: mockIdentity.attestation_count,
          }
        }
        return null
      })
    }
  }
})

import { createHealthRouter } from '../../src/routes/health.js'
import { createBondRouter } from '../../src/routes/bond.js'
import trustRouter from '../../src/routes/trust.js'
import apiKeysRouter from '../../src/routes/apiKeys.js'
import { createAttestationRouter } from '../../src/routes/attestations.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { BondStore, BondService } from '../../src/services/bond/index.js'
import {
  generateApiKey,
  _setUseInMemory,
  _resetStore,
  ApiKeyScope
} from '../../src/services/apiKeys.js'

// Helper to validate the standard error response envelope
function expectErrorEnvelope(
  body: any,
  expectedCode?: string
) {
  expect(body).toHaveProperty('error')
  expect(typeof body.error).toBe('string')

  if (body.code !== undefined || body.error_code !== undefined) {
    expect(body).toHaveProperty('code')
    expect(typeof body.code).toBe('string')
    expect(body).toHaveProperty('error_code')
    expect(body.error_code).toBe(body.code)
    if (expectedCode) {
      expect(body.code).toBe(expectedCode)
    }
  } else {
    expect(body).toHaveProperty('message')
    expect(typeof body.message).toBe('string')
  }
}

describe('API Contract Validation Tests', () => {
  let app: Express
  let bondStore: BondStore
  let bondService: BondService
  let testApiKey: string

  // Attestations router mocks
  let attestationCacheService: {
    getAttestationsBySubjectPaginated: ReturnType<typeof vi.fn>
    invalidateForAttestation: ReturnType<typeof vi.fn>
  }
  let attestationTransactionManager: {
    withTransaction: ReturnType<typeof vi.fn>
  }
  let attestationOutbox: {
    emit: ReturnType<typeof vi.fn>
  }

  beforeEach(async () => {
    _resetStore()
    _setUseInMemory(true)

    // Create a test API key with bond:write scope for calling endpoints
    const result = await generateApiKey('test-owner', [ApiKeyScope.BOND_WRITE], 'pro')
    testApiKey = result.key

    // Initialize mock stores/services
    bondStore = new BondStore()
    bondService = new BondService(bondStore)

    // Seed mock bond data
    bondStore.set({
      address: '0x1111111111111111111111111111111111111111',
      bondedAmount: '1000000000000000000',
      bondStart: '2025-01-01T00:00:00.000Z',
      bondDuration: 365,
      active: true,
      slashedAmount: '0',
    })

    // Setup Attestations Router mocks
    attestationCacheService = {
      getAttestationsBySubjectPaginated: vi.fn(),
      invalidateForAttestation: vi.fn(),
    }
    attestationOutbox = { emit: vi.fn() }
    attestationTransactionManager = {
      withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(), release: vi.fn() })),
    }

    // Build express app mounting all representative routes
    app = express()
    app.use(express.json())

    // 1. Health
    app.use('/api/health', createHealthRouter({
      postgres: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      horizonListener: async () => ({ status: 'up' }),
      outboxPublisher: async () => ({ status: 'up' }),
      horizon: async () => ({ status: 'up' }),
    }))

    // 2. Bond
    app.use('/api/bond', createBondRouter(bondService))

    // 3. Trust
    app.use('/api/trust', trustRouter)

    // 4. API Keys
    app.use('/api/api-keys', apiKeysRouter)

    // 5. Attestations
    app.use('/api/attestations', createAttestationRouter({
      cacheService: attestationCacheService as any,
      transactionManager: attestationTransactionManager as any,
      outbox: attestationOutbox as any,
      skipTenantCheck: true,
    }))

    // Global Error Handler
    app.use((err: any, req: any, res: any, next: any) => {
      next(err)
    })
    app.use(errorHandler)
  })

  afterEach(() => {
    _resetStore()
    vi.clearAllMocks()
  })

  describe('Success Envelopes', () => {
    it('GET /api/health/live returns a liveness health envelope (200)', async () => {
      const res = await request(app).get('/api/health/live').expect(200)
      expect(res.body).toHaveProperty('status', 'ok')
      expect(res.body).toHaveProperty('service', 'credence-backend')
      expect(res.body).toHaveProperty('version')
      expect(res.body).not.toHaveProperty('dependencies')
    })

    it('GET /api/health returns a full readiness health envelope (200)', async () => {
      const res = await request(app).get('/api/health').expect(200)
      expect(res.body).toHaveProperty('status', 'ok')
      expect(res.body).toHaveProperty('service')
      expect(res.body).toHaveProperty('version')
      expect(res.body).toHaveProperty('dependencies')
      expect(res.body.dependencies.postgres).toHaveProperty('status', 'up')
    })

    it('GET /api/bond/:address returns a bond status envelope (200)', async () => {
      const res = await request(app)
        .get('/api/bond/0x1111111111111111111111111111111111111111')
        .expect(200)

      expect(res.body).toMatchObject({
        address: '0x1111111111111111111111111111111111111111',
        bondedAmount: '1000000000000000000',
        bondStart: '2025-01-01T00:00:00.000Z',
        bondDuration: 365,
        active: true,
        slashedAmount: '0',
        status: 'active',
      })
    })

    it('GET /api/trust/:address returns a trust score envelope (200)', async () => {
      const res = await request(app)
        .get('/api/trust/0x1111111111111111111111111111111111111111')
        .expect(200)

      expect(res.body).toMatchObject({
        address: '0x1111111111111111111111111111111111111111',
        bondedAmount: '1000000000000000000',
        bondStart: '2025-01-01T00:00:00.000Z',
        attestationCount: 5,
        scoringModelVersion: expect.any(String),
      })
      expect(typeof res.body.score).toBe('number')
    })

    it('POST /api/api-keys returns a created API key details envelope (201)', async () => {
      const res = await request(app)
        .post('/api/api-keys')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          ownerId: 'new-owner-1',
          scopes: [ApiKeyScope.BOND_READ, ApiKeyScope.TRUST_READ],
          tier: 'pro',
        })
        .expect(201)

      expect(res.body).toHaveProperty('id')
      expect(res.body).toHaveProperty('key')
      expect(res.body).toHaveProperty('prefix')
      expect(res.body.scopes).toEqual([ApiKeyScope.BOND_READ, ApiKeyScope.TRUST_READ])
      expect(res.body.tier).toBe('pro')
    })

    it('GET /api/attestations/:address returns a cursor-paginated envelope (200)', async () => {
      attestationCacheService.getAttestationsBySubjectPaginated.mockResolvedValueOnce({
        attestations: [
          {
            id: 1,
            bondId: 10,
            attesterAddress: '0x2222222222222222222222222222222222222222',
            subjectAddress: '0x1111111111111111111111111111111111111111',
            score: 95,
            note: '{}',
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
          }
        ],
        hasMore: false,
      })

      const res = await request(app)
        .get('/api/attestations/0x1111111111111111111111111111111111111111')
        .expect(200)

      expect(res.body).toHaveProperty('address', '0x1111111111111111111111111111111111111111')
      expect(Array.isArray(res.body.data)).toBe(true)
      expect(res.body.data[0]).toMatchObject({
        id: 1,
        bondId: 10,
        attesterAddress: '0x2222222222222222222222222222222222222222',
        subjectAddress: '0x1111111111111111111111111111111111111111',
        score: 95,
        createdAt: '2025-01-01T00:00:00.000Z',
      })
      expect(res.body.page).toEqual({
        nextCursor: null,
        hasMore: false,
        limit: 20,
      })
    })
  })

  describe('Error Envelopes', () => {
    it('returns a 400 validation_failed error envelope when input schema validation fails', async () => {
      const res = await request(app)
        .get('/api/bond/invalid-address-format')
        .expect(400)

      expectErrorEnvelope(res.body, 'validation_failed')
      expect(res.body.error).toBe('Validation failed')
      expect(Array.isArray(res.body.details)).toBe(true)
    })

    it('returns a 401 unauthorized error envelope when API key authentication is missing', async () => {
      const res = await request(app)
        .get('/api/api-keys/some-owner')
        .expect(401)

      expectErrorEnvelope(res.body)
      expect(res.body.error).toContain('Unauthorized')
    })

    it('returns a 401 unauthorized error envelope when API key authentication is invalid', async () => {
      const res = await request(app)
        .get('/api/api-keys/some-owner')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401)

      expectErrorEnvelope(res.body)
      expect(res.body.error).toContain('Unauthorized')
    })

    it('returns a 403 forbidden error envelope when API key lacks required scope', async () => {
      // Create a key with read-only scope, then try to make a write action
      const readOnlyResult = await generateApiKey('test-owner-2', [ApiKeyScope.BOND_READ], 'free')
      const readOnlyToken = readOnlyResult.key

      const res = await request(app)
        .post('/api/api-keys')
        .set('Authorization', `Bearer ${readOnlyToken}`)
        .send({ ownerId: 'new-owner-2' })
        .expect(403)

      expectErrorEnvelope(res.body)
      expect(res.body.error).toContain('Forbidden')
    })

    it('returns a 404 not_found error envelope when a resource is not found', async () => {
      const res = await request(app)
        .get('/api/bond/0x2222222222222222222222222222222222222222')
        .expect(404)

      expectErrorEnvelope(res.body, 'not_found')
      expect(res.body.error).toContain('Bond record with ID 0x2222222222222222222222222222222222222222 not found')
    })

    it('returns a 500 internal_server_error envelope when an internal service throws an unhandled error', async () => {
      // Cause Attestation query to throw an error
      attestationCacheService.getAttestationsBySubjectPaginated.mockRejectedValueOnce(
        new Error('Unexpected database failure')
      )

      const res = await request(app)
        .get('/api/attestations/0x1111111111111111111111111111111111111111')
        .expect(500)

      expectErrorEnvelope(res.body, 'internal_server_error')
      expect(res.body.error).toBe('An unexpected internal server error occurred')
    })
  })
})
