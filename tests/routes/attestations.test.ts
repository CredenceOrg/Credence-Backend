/**
 * @file Integration tests for attestation API routes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import { newDb, type IMemoryDb } from 'pg-mem'

import { AttestationRepository } from '../../src/repositories/attestationRepository.js'
import { createAttestationRouter } from '../../src/routes/attestations.js'
import { AttestationsApiService } from '../../src/services/attestationsApiService.js'
import { AttestationsRepository } from '../../src/db/repositories/attestationsRepository.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { ATTESTATION_CLAIM_MAX_LENGTH } from '../../src/schemas/attestations.js'
import * as invalidation from '../../src/cache/invalidation.js'

const ADDR_ALICE = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
const ADDR_NOBODY = '0x1111111111111111111111111111111111111111'
const verifierAddress = (index: number) =>
  `0x${(index + 1).toString(16).padStart(40, '0')}`

async function request(
  app: Express,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Could not get server address'))
        return
      }

      const url = `http://127.0.0.1:${addr.port}${path}`
      const opts: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      }
      if (body !== undefined) opts.body = JSON.stringify(body)

      fetch(url, opts)
        .then(async (res) => {
          const json = await res.json()
          server.close()
          resolve({ status: res.status, body: json })
        })
        .catch((err) => {
          server.close()
          reject(err)
        })
    })
  })
}

function createInMemoryApp(repo: AttestationRepository): Express {
  const app = express()
  app.use(express.json())
  app.use('/api/attestations', createAttestationRouter(repo))
  app.use(errorHandler)
  return app
}

async function seedViaApi(
  app: Express,
  count: number,
  subject = ADDR_ALICE,
): Promise<Array<{ id: string }>> {
  const results: Array<{ id: string }> = []
  for (let i = 0; i < count; i++) {
    const { body } = await request(app, 'POST', '/api/attestations', {
      subject,
      verifier: verifierAddress(i),
      weight: 50 + i,
      claim: `claim-${i}`,
    })
    results.push(body as { id: string })
  }
  return results
}

async function setupPgMemApp(): Promise<{
  app: Express
  pool: import('pg').Pool
}> {
  const db = newDb()
  db.public.registerFunction({
    name: 'current_database',
    implementation: () => 'test',
  })
  db.public.registerFunction({
    name: 'version',
    implementation: () => 'PostgreSQL 15.0',
  })
  db.public.registerFunction({
    name: 'trim',
    args: ['text'],
    returns: 'text',
    implementation: (value: string) => value.trim(),
  })
  db.public.registerFunction({
    name: 'length',
    args: ['text'],
    returns: 'int',
    implementation: (value: string) => value.length,
  })
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => '00000000-0000-4000-8000-000000000001',
  })

  const { createSchema } = await import('../../src/db/schema.js')
  const pgMem = db.adapters.createPg()
  const pool = new pgMem.Pool()
  const client = await pool.connect()
  try {
    await createSchema(client)
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_outbox (
        id BIGSERIAL PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 5,
        consumer_id TEXT,
        lease_expires_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        error_message TEXT
      )
    `)
    await client.query(
      `INSERT INTO identities (address) VALUES ($1), ($2)`,
      [ADDR_ALICE, verifierAddress(0)],
    )
    await client.query(
      `INSERT INTO bonds (identity_address, amount, start_time, duration_days, status)
       VALUES ($1, 100, NOW(), 365, 'active')`,
      [ADDR_ALICE],
    )
  } finally {
    client.release()
  }

  const repository = new AttestationsRepository(pool)
  const cacheService = {
    async getAttestationsBySubjectPaginated(subjectAddress: string, options: { offset: number; limit: number }) {
      return repository.listBySubjectPaginated(subjectAddress, options)
    },
    async invalidateAfterCreate(attestation: { subjectAddress: string; bondId: number }) {
      await invalidation.invalidatePattern('attestation', `subject:${attestation.subjectAddress}`)
      await invalidation.invalidateCache('attestation', `bond:${attestation.bondId}`)
    },
  }
  const service = new AttestationsApiService({ pool, repository, cacheService })
  const app = express()
  app.use(express.json())
  app.use('/api/attestations', createAttestationRouter(service))
  app.use(errorHandler)

  return { app, pool }
}

describe('Attestation Routes (in-memory)', () => {
  let app: Express
  let repo: AttestationRepository
  const BASE = '/api/attestations'

  beforeEach(() => {
    repo = new AttestationRepository()
    app = createInMemoryApp(repo)
  })

  describe('GET /:identity/count', () => {
    it('should return 0 for an identity with no attestations', async () => {
      const { status, body } = await request(app, 'GET', `${BASE}/${ADDR_NOBODY}/count`)
      expect(status).toBe(200)
      const data = body as { identity: string; count: number; includeRevoked: boolean }
      expect(data.identity).toBe(ADDR_NOBODY.toLowerCase())
      expect(data.count).toBe(0)
      expect(data.includeRevoked).toBe(false)
    })

    it('should return active attestation count', async () => {
      const created = await seedViaApi(app, 3, ADDR_ALICE)
      await request(app, 'DELETE', `${BASE}/${created[0].id}`)

      const { body } = await request(app, 'GET', `${BASE}/${ADDR_ALICE}/count`)
      expect((body as { count: number }).count).toBe(2)
    })
  })

  describe('GET /:identity', () => {
    it('should return empty list for unknown identity', async () => {
      const { status, body } = await request(app, 'GET', `${BASE}/${ADDR_NOBODY}`)
      expect(status).toBe(200)
      const data = body as { attestations: unknown[]; total: number }
      expect(data.attestations).toEqual([])
      expect(data.total).toBe(0)
    })

    it('should paginate with accurate totals', async () => {
      await seedViaApi(app, 5, ADDR_ALICE)

      const { body } = await request(
        app,
        'GET',
        `${BASE}/${ADDR_ALICE}?page=3&limit=2`,
      )
      const data = body as { attestations: unknown[]; total: number; hasNext: boolean }
      expect(data.attestations).toHaveLength(1)
      expect(data.total).toBe(5)
      expect(data.hasNext).toBe(false)
    })

    it('should return empty on out-of-range page', async () => {
      await seedViaApi(app, 3, ADDR_ALICE)

      const { body } = await request(app, 'GET', `${BASE}/${ADDR_ALICE}?page=100&limit=2`)
      expect((body as { attestations: unknown[] }).attestations).toHaveLength(0)
      expect((body as { total: number }).total).toBe(3)
    })

    it('should normalize address casing on lookup', async () => {
      await seedViaApi(app, 1, ADDR_ALICE)

      const checksummed = ADDR_ALICE
      const { body } = await request(app, 'GET', `${BASE}/${checksummed}`)
      expect((body as { attestations: unknown[] }).attestations).toHaveLength(1)
    })

    it('should return 400 when limit exceeds max 100', async () => {
      await seedViaApi(app, 2, ADDR_ALICE)

      const { status, body } = await request(app, 'GET', `${BASE}/${ADDR_ALICE}?limit=999`)
      expect(status).toBe(400)
      expect((body as { error: string }).error).toBe('Validation failed')
    })
  })

  describe('POST /', () => {
    it('should create an attestation and return 201', async () => {
      const { status, body } = await request(app, 'POST', BASE, {
        subject: ADDR_ALICE,
        verifier: verifierAddress(0),
        weight: 75,
        claim: 'Identity verified',
      })

      expect(status).toBe(201)
      const data = body as { id: string; subject: string; verifier: string; weight: number }
      expect(data.id).toBeTruthy()
      expect(data.subject).toBe(ADDR_ALICE.toLowerCase())
      expect(data.weight).toBe(75)
    })

    it('should return 400 for oversized claim', async () => {
      const { status, body } = await request(app, 'POST', BASE, {
        subject: ADDR_ALICE,
        verifier: verifierAddress(1),
        weight: 50,
        claim: 'x'.repeat(ATTESTATION_CLAIM_MAX_LENGTH + 1),
      })
      expect(status).toBe(400)
      expect((body as { error: string }).error).toBe('Validation failed')
    })

    it('should return 400 for invalid weight', async () => {
      const { status } = await request(app, 'POST', BASE, {
        subject: ADDR_ALICE,
        verifier: verifierAddress(2),
        weight: 200,
        claim: 'x',
      })
      expect(status).toBe(400)
    })
  })

  describe('DELETE /:id', () => {
    it('should return 409 when revoking an already-revoked attestation', async () => {
      const [created] = await seedViaApi(app, 1, ADDR_ALICE)
      await request(app, 'DELETE', `${BASE}/${created.id}`)

      const { status, body } = await request(app, 'DELETE', `${BASE}/${created.id}`)
      expect(status).toBe(409)
      expect((body as { error: string }).error).toMatch(/already revoked/i)
    })
  })
})

describe('Attestation Routes (persisted + cache + outbox)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(invalidation, 'invalidatePattern').mockResolvedValue(1)
    vi.spyOn(invalidation, 'invalidateCache').mockResolvedValue(true)
  })

  it('creates attestation, emits outbox event, and invalidates cache', async () => {
    const { app } = await setupPgMemApp()

    const createRes = await request(app, 'POST', '/api/attestations', {
      subject: ADDR_ALICE,
      verifier: verifierAddress(0),
      weight: 80,
      claim: 'KYC verified',
      bondId: 1,
    })
    expect(createRes.status).toBe(201)

    const listRes = await request(app, 'GET', `/api/attestations/${ADDR_ALICE}`)
    const list = listRes.body as { attestations: Array<{ weight: number }>; total: number }
    expect(list.total).toBe(1)
    expect(list.attestations[0]?.weight).toBe(80)

    expect(invalidation.invalidatePattern).toHaveBeenCalled()
  })

  it('returns 409 for duplicate attestation on same bond', async () => {
    const { app } = await setupPgMemApp()

    const payload = {
      subject: ADDR_ALICE,
      verifier: verifierAddress(0),
      weight: 70,
      claim: 'first',
      bondId: 1,
    }
    expect((await request(app, 'POST', '/api/attestations', payload)).status).toBe(201)
    const duplicate = await request(app, 'POST', '/api/attestations', {
      ...payload,
      claim: 'duplicate',
    })
    expect(duplicate.status).toBe(409)
  })
})
