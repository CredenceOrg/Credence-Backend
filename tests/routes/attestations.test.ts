import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createAttestationRouter } from '../../src/routes/attestations.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import type { Attestation } from '../../src/db/repositories/attestationsRepository.js'
import { setTenantId } from '../../src/utils/tenantContext.js'
import { encodeCursor } from '../../src/lib/pagination.js'
import { withReplica } from '../../src/db/pool.js'

// Prevent tests from opening real database connections.
vi.mock('../../src/db/pool.js', () => ({
  pool: {},
  replicaPool: {},
  workerPool: {},
  withReplica: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
}))

const SUBJECT = '0x1111111111111111111111111111111111111111'
const ATTESTER = '0x2222222222222222222222222222222222222222'
const MIXED_SUBJECT = '0x111111111111111111111111111111111111AaAa'

const makeAttestation = (id: number, subjectAddress = SUBJECT): Attestation => ({
  id,
  bondId: 10,
  attesterAddress: ATTESTER,
  subjectAddress,
  score: 90,
  note: JSON.stringify({ key: 'kyc', value: `verified-${id}` }),
  createdAt: new Date(`2025-01-0${id}T00:00:00.000Z`),
})

/** Minimal row shape returned by a mocked pg client for attestation INSERT/SELECT. */
const makeRow = (a: Attestation) => ({
  id: a.id,
  bond_id: a.bondId,
  attester_address: a.attesterAddress,
  subject_address: a.subjectAddress,
  score: a.score,
  note: a.note,
  created_at: a.createdAt,
})

describe('attestation routes', () => {
  let app: Express
  let cacheService: {
    getAttestationsBySubjectPaginated: ReturnType<typeof vi.fn>
    invalidateForAttestation: ReturnType<typeof vi.fn>
  }
  let transactionManager: { withTransaction: ReturnType<typeof vi.fn> }
  let outbox: { emit: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    setTenantId('test-tenant')
    vi.mocked(withReplica).mockImplementation(async (fn: any) => fn({}))

    cacheService = {
      getAttestationsBySubjectPaginated: vi.fn(),
      invalidateForAttestation: vi.fn(),
    }
    outbox = { emit: vi.fn() }
    transactionManager = {
      withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(), release: vi.fn() })),
    }

    app = express()
    app.use(express.json())
    app.use(
      '/api/attestations',
      createAttestationRouter({
        cacheService: cacheService as any,
        transactionManager: transactionManager as any,
        outbox: outbox as any,
        skipTenantCheck: true,
      }),
    )
    app.use(errorHandler)
  })

  afterEach(() => {
    setTenantId(null)
    vi.clearAllMocks()
  })

  // ---------------------------------------------------------------------------
  // GET /api/attestations/:address
  // ---------------------------------------------------------------------------

  describe('GET /api/attestations/:address', () => {
    it('returns a repository-backed cursor page with a next cursor when more remain', async () => {
      cacheService.getAttestationsBySubjectPaginated.mockResolvedValue({
        attestations: [makeAttestation(1), makeAttestation(2)],
        hasMore: true,
      })

      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?limit=2`)
        .expect(200)

      expect(cacheService.getAttestationsBySubjectPaginated).toHaveBeenCalledWith(SUBJECT, {
        limit: 2,
        cursor: undefined,
      })
      expect(res.body).toMatchObject({ address: SUBJECT, page: { limit: 2, hasMore: true } })
      expect(res.body.data).toHaveLength(2)
      expect(res.body.data[0].createdAt).toBe('2025-01-01T00:00:00.000Z')
      // A next cursor is emitted because hasMore is true.
      expect(typeof res.body.page.nextCursor).toBe('string')
    })

    it('returns an empty page with no next cursor when there are no more results', async () => {
      cacheService.getAttestationsBySubjectPaginated.mockResolvedValue({
        attestations: [],
        hasMore: false,
      })

      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?limit=2`)
        .expect(200)

      expect(res.body.data).toEqual([])
      expect(res.body.page.hasMore).toBe(false)
      expect(res.body.page.nextCursor).toBeNull()
    })

    it('normalizes Ethereum addresses before querying cache', async () => {
      cacheService.getAttestationsBySubjectPaginated.mockResolvedValue({
        attestations: [],
        hasMore: false,
      })

      await request(app).get(`/api/attestations/${MIXED_SUBJECT}`).expect(200)

      expect(cacheService.getAttestationsBySubjectPaginated).toHaveBeenCalledWith(
        MIXED_SUBJECT.toLowerCase(),
        { limit: 20, cursor: undefined },
      )
    })

    it('rejects a limit that exceeds the maximum (999)', async () => {
      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?limit=999`)
        .expect(400)

      expect(res.body.error).toBe('Validation failed')
      expect(cacheService.getAttestationsBySubjectPaginated).not.toHaveBeenCalled()
    })

    it('rejects limit=0 (below minimum)', async () => {
      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?limit=0`)
        .expect(400)

      expect(res.body.error).toBe('Validation failed')
      expect(cacheService.getAttestationsBySubjectPaginated).not.toHaveBeenCalled()
    })

    it('rejects a malformed Ethereum address in the path', async () => {
      const res = await request(app).get('/api/attestations/0xshort').expect(400)

      expect(res.body.error).toBe('Validation failed')
    })

    it('rejects a plaintext (non-Ethereum, non-Stellar) path parameter', async () => {
      const res = await request(app).get('/api/attestations/not-an-address').expect(400)

      expect(res.body.error).toBe('Validation failed')
    })

    it('forwards a decoded cursor to the cache service', async () => {
      const cursor = encodeCursor('2025-01-01T00:00:00.000Z', '5')

      cacheService.getAttestationsBySubjectPaginated.mockResolvedValue({
        attestations: [],
        hasMore: false,
      })

      await request(app)
        .get(`/api/attestations/${SUBJECT}?cursor=${cursor}&limit=10`)
        .expect(200)

      expect(cacheService.getAttestationsBySubjectPaginated).toHaveBeenCalledWith(SUBJECT, {
        limit: 10,
        cursor: { t: '2025-01-01T00:00:00.000Z', i: '5' },
      })
    })

    it('treats an empty cursor param (?cursor=) as no cursor', async () => {
      cacheService.getAttestationsBySubjectPaginated.mockResolvedValue({
        attestations: [],
        hasMore: false,
      })

      await request(app).get(`/api/attestations/${SUBJECT}?cursor=`).expect(200)

      expect(cacheService.getAttestationsBySubjectPaginated).toHaveBeenCalledWith(SUBJECT, {
        limit: 20,
        cursor: undefined,
      })
    })

    it('returns serialized attestations with all fields required by the reputation scorer', async () => {
      cacheService.getAttestationsBySubjectPaginated.mockResolvedValue({
        attestations: [makeAttestation(3)],
        hasMore: false,
      })

      const res = await request(app).get(`/api/attestations/${SUBJECT}`).expect(200)

      const item = res.body.data[0]
      // Fields consumed by src/services/reputation/attestationScore.ts and downstream scorers.
      expect(item).toMatchObject({
        id: 3,
        bondId: 10,
        attesterAddress: ATTESTER,
        subjectAddress: SUBJECT,
        score: 90,
      })
      expect(typeof item.createdAt).toBe('string')
    })

    it('propagates unexpected cache errors as 500', async () => {
      cacheService.getAttestationsBySubjectPaginated.mockRejectedValue(new Error('redis down'))

      const res = await request(app).get(`/api/attestations/${SUBJECT}`).expect(500)

      expect(res.body.error).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // POST /api/attestations
  // ---------------------------------------------------------------------------

  describe('POST /api/attestations', () => {
    it('persists an attestation, emits an outbox event, and invalidates cache', async () => {
      const created = makeAttestation(7)
      transactionManager.withTransaction.mockImplementationOnce(async (fn) =>
        fn({ query: vi.fn().mockResolvedValue({ rows: [makeRow(created)] }) }),
      )

      const res = await request(app)
        .post('/api/attestations')
        .set('x-tenant-id', 'test-tenant')
        .send({
          bondId: 10,
          attesterAddress: ATTESTER.toUpperCase().replace('X', 'x'),
          subject: SUBJECT,
          key: 'kyc',
          value: 'verified',
          score: 90,
        })
        .expect(201)

      expect(res.body).toMatchObject({
        id: 7,
        bondId: 10,
        attesterAddress: ATTESTER,
        subjectAddress: SUBJECT,
        score: 90,
      })
      expect(outbox.emit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          aggregateType: 'attestation',
          aggregateId: '7',
          eventType: 'attestation.created',
        }),
      )
      expect(cacheService.invalidateForAttestation).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7, subjectAddress: SUBJECT }),
      )
    })

    it('emits a payload with all fields required by the reputation scorer', async () => {
      const created = makeAttestation(4)
      transactionManager.withTransaction.mockImplementationOnce(async (fn) =>
        fn({ query: vi.fn().mockResolvedValue({ rows: [makeRow(created)] }) }),
      )

      await request(app)
        .post('/api/attestations')
        .set('x-tenant-id', 'test-tenant')
        .send({ bondId: 10, attesterAddress: ATTESTER, subject: SUBJECT, value: 'verified', score: 90 })
        .expect(201)

      expect(outbox.emit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          payload: expect.objectContaining({
            id: 4,
            bondId: 10,
            attesterAddress: ATTESTER,
            subjectAddress: SUBJECT,
            score: 90,
            createdAt: created.createdAt.toISOString(),
          }),
        }),
      )
    })

    it('rejects duplicate attestations with 409', async () => {
      transactionManager.withTransaction.mockRejectedValueOnce({ code: '23505' })

      const res = await request(app)
        .post('/api/attestations')
        .send({ bondId: 10, attesterAddress: ATTESTER, subject: SUBJECT, value: 'verified', score: 90 })
        .expect(409)

      expect(res.body.error).toBe('Duplicate attestation')
      expect(cacheService.invalidateForAttestation).not.toHaveBeenCalled()
    })

    it('rejects oversized values (> 2048 chars)', async () => {
      await request(app)
        .post('/api/attestations')
        .send({ bondId: 10, attesterAddress: ATTESTER, subject: SUBJECT, value: 'x'.repeat(2049), score: 90 })
        .expect(400)

      expect(transactionManager.withTransaction).not.toHaveBeenCalled()
    })

    it('rejects oversized keys (> 128 chars)', async () => {
      await request(app)
        .post('/api/attestations')
        .send({ bondId: 10, attesterAddress: ATTESTER, subject: SUBJECT, key: 'k'.repeat(129), value: 'v', score: 90 })
        .expect(400)

      expect(transactionManager.withTransaction).not.toHaveBeenCalled()
    })

    it('returns 400 when bondId is missing', async () => {
      const res = await request(app)
        .post('/api/attestations')
        .send({ attesterAddress: ATTESTER, subject: SUBJECT, value: 'verified' })
        .expect(400)

      expect(res.body.error).toBe('Validation failed')
      expect(transactionManager.withTransaction).not.toHaveBeenCalled()
    })

    it('returns 400 when attesterAddress is missing', async () => {
      const res = await request(app)
        .post('/api/attestations')
        .send({ bondId: 10, subject: SUBJECT, value: 'verified' })
        .expect(400)

      expect(res.body.error).toBe('Validation failed')
      expect(transactionManager.withTransaction).not.toHaveBeenCalled()
    })

    it('returns 400 with an error for each missing required field when both bondId and attesterAddress are absent', async () => {
      const res = await request(app)
        .post('/api/attestations')
        .send({ subject: SUBJECT, value: 'verified' })
        .expect(400)

      expect(res.body.error).toBe('Validation failed')
      const paths = (res.body.details as Array<{ path: string }>).map((d) => d.path)
      expect(paths).toContain('bondId')
      expect(paths).toContain('attesterAddress')
    })

    it('returns 400 when subject is missing', async () => {
      await request(app)
        .post('/api/attestations')
        .send({ bondId: 10, attesterAddress: ATTESTER, value: 'verified' })
        .expect(400)
    })

    it('returns 400 when value is missing', async () => {
      await request(app)
        .post('/api/attestations')
        .send({ bondId: 10, attesterAddress: ATTESTER, subject: SUBJECT })
        .expect(400)
    })

    it('returns 400 when score exceeds 100', async () => {
      await request(app)
        .post('/api/attestations')
        .send({ bondId: 10, attesterAddress: ATTESTER, subject: SUBJECT, value: 'ok', score: 101 })
        .expect(400)
    })

    it('defaults score to 100 when omitted', async () => {
      const created = { ...makeAttestation(5), score: 100 }
      let capturedParams: unknown[] = []

      transactionManager.withTransaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
            capturedParams = params
            return Promise.resolve({ rows: [makeRow(created)] })
          }),
        }
        return fn(client)
      })

      const res = await request(app)
        .post('/api/attestations')
        .set('x-tenant-id', 'test-tenant')
        .send({ bondId: 10, attesterAddress: ATTESTER, subject: SUBJECT, value: 'verified' })
        .expect(201)

      expect(res.body.score).toBe(100)
      // INSERT params order: bondId, attesterAddress, subjectAddress, score, note
      expect(capturedParams[3]).toBe(100)
    })

    it('propagates unexpected transaction errors as 500', async () => {
      transactionManager.withTransaction.mockRejectedValueOnce(new Error('connection lost'))

      const res = await request(app)
        .post('/api/attestations')
        .send({ bondId: 10, attesterAddress: ATTESTER, subject: SUBJECT, value: 'verified' })
        .expect(500)

      expect(res.body.error).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Legacy attestation router (passed a repository object directly)
  // ---------------------------------------------------------------------------

  describe('legacy attestation router', () => {
    let legacyApp: Express
    let legacyRepo: {
      countBySubject: ReturnType<typeof vi.fn>
      findBySubject: ReturnType<typeof vi.fn>
      create: ReturnType<typeof vi.fn>
      revoke: ReturnType<typeof vi.fn>
    }

    beforeEach(() => {
      legacyRepo = {
        countBySubject: vi.fn().mockReturnValue(3),
        findBySubject: vi.fn().mockReturnValue({ attestations: [], total: 0 }),
        create: vi.fn(),
        revoke: vi.fn(),
      }

      legacyApp = express()
      legacyApp.use(express.json())
      legacyApp.use('/api/attestations', createAttestationRouter(legacyRepo as any))
      legacyApp.use(errorHandler)
    })

    describe('GET /:identity/count', () => {
      it('returns the attestation count for an identity', async () => {
        const res = await request(legacyApp)
          .get('/api/attestations/0xABCD/count')
          .expect(200)

        expect(res.body).toEqual({ identity: '0xABCD', count: 3, includeRevoked: false })
        expect(legacyRepo.countBySubject).toHaveBeenCalledWith('0xABCD', false)
      })

      it('passes includeRevoked=true to the repository', async () => {
        legacyRepo.countBySubject.mockReturnValue(5)

        const res = await request(legacyApp)
          .get('/api/attestations/0xABCD/count?includeRevoked=true')
          .expect(200)

        expect(legacyRepo.countBySubject).toHaveBeenCalledWith('0xABCD', true)
        expect(res.body.count).toBe(5)
        expect(res.body.includeRevoked).toBe(true)
      })
    })

    describe('GET /:identity', () => {
      it('returns paginated attestations for an identity', async () => {
        const fakeAtt = { id: 1, verifier: '0xVERIF' }
        legacyRepo.findBySubject.mockReturnValue({ attestations: [fakeAtt], total: 1 })

        const res = await request(legacyApp)
          .get('/api/attestations/0xABCD?limit=10&page=1')
          .expect(200)

        expect(res.body.identity).toBe('0xABCD')
        expect(res.body.attestations).toHaveLength(1)
        expect(res.body.total).toBe(1)
        expect(legacyRepo.findBySubject).toHaveBeenCalledWith(
          '0xABCD',
          expect.objectContaining({ limit: 10, offset: 0 }),
        )
      })

      it('falls back to countBySubject when the repo does not return a numeric total', async () => {
        legacyRepo.findBySubject.mockReturnValue({ attestations: [] }) // no total property
        legacyRepo.countBySubject.mockReturnValue(7)

        const res = await request(legacyApp).get('/api/attestations/0xABCD').expect(200)

        expect(legacyRepo.countBySubject).toHaveBeenCalled()
        expect(res.body.total).toBe(7)
      })

      it('passes includeRevoked=true to findBySubject', async () => {
        legacyRepo.findBySubject.mockReturnValue({ attestations: [], total: 0 })

        await request(legacyApp)
          .get('/api/attestations/0xABCD?includeRevoked=true')
          .expect(200)

        expect(legacyRepo.findBySubject).toHaveBeenCalledWith(
          '0xABCD',
          expect.objectContaining({ includeRevoked: true }),
        )
      })

      it('propagates pagination and repo errors as 500', async () => {
        // The legacy GET handler does not convert PaginationValidationError to a
        // structured 400; unknown errors reach the global error handler as 500.
        legacyRepo.findBySubject.mockImplementation(() => { throw new Error('db error') })

        await request(legacyApp).get('/api/attestations/0xABCD').expect(500)
      })
    })

    describe('POST / (legacy create)', () => {
      it('creates an attestation and returns 201', async () => {
        const body = { subject: '0xSUBJ', verifier: '0xVERIF', weight: 1.5, claim: 'verified' }
        legacyRepo.create.mockReturnValue({ id: 42, ...body })

        const res = await request(legacyApp)
          .post('/api/attestations')
          .send(body)
          .expect(201)

        expect(legacyRepo.create).toHaveBeenCalledWith(body)
        expect(res.body.id).toBe(42)
      })

      it('propagates repo errors as 500', async () => {
        legacyRepo.create.mockImplementation(() => { throw new Error('insert failed') })

        await request(legacyApp)
          .post('/api/attestations')
          .send({ subject: '0xSUBJ', verifier: '0xV', weight: 1, claim: 'c' })
          .expect(500)
      })
    })

    describe('DELETE /:id (revoke)', () => {
      it('revokes an attestation and returns the result when found', async () => {
        const revoked = { id: '5', verifier: '0xV', revoked: true }
        legacyRepo.revoke.mockReturnValue(revoked)

        const res = await request(legacyApp).delete('/api/attestations/5').expect(200)

        expect(legacyRepo.revoke).toHaveBeenCalledWith('5')
        expect(res.body).toMatchObject({ id: '5', revoked: true })
      })

      it('returns 404 when the attestation is not found', async () => {
        legacyRepo.revoke.mockReturnValue(undefined)

        await request(legacyApp).delete('/api/attestations/999').expect(404)

        expect(legacyRepo.revoke).toHaveBeenCalledWith('999')
      })

      it('allows any caller with a valid ID to revoke — author enforcement is not at the route layer', async () => {
        // The legacy router delegates entirely to repo.revoke(id) with no attesterAddress
        // check. Author-only enforcement must be added at the auth middleware or service layer.
        legacyRepo.revoke.mockReturnValue({ id: '3', revoked: true })

        const res = await request(legacyApp).delete('/api/attestations/3').expect(200)

        expect(res.body.revoked).toBe(true)
      })
    })
  })
})
