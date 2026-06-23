import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createPayoutsRouter } from './payouts.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { ErrorCode } from '../lib/errors.js'
import { recordSettlementDuplicate } from '../middleware/metrics.js'

const db = vi.hoisted(() => {
  type IdempotencyRow = {
    key: string
    actor_id: string
    request_hash: string
    response_code: number
    response_body: string
    ttl_seconds: number
    expires_at: Date
    created_at: Date
  }

  type SettlementRow = {
    id: string
    bond_id: string | number
    amount: string
    transaction_hash: string
    settled_at: Date
    status: 'pending' | 'settled' | 'failed'
    created_at: Date
    updated_at: Date
    is_duplicate?: boolean
  }

  const idempotencyKeys = new Map<string, IdempotencyRow>()
  const settlementsByTx = new Map<string, SettlementRow>()
  let nextSettlementId = 1
  let failNextSettlement: Error | undefined

  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes('FROM idempotency_keys')) {
      const key = String(params[0])
      const row = idempotencyKeys.get(key)
      return { rows: row && row.expires_at > new Date() ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (sql.includes('INSERT INTO idempotency_keys')) {
      const [key, actorId, requestHash, responseCode, responseBody, ttlSeconds, expiresAt] = params
      idempotencyKeys.set(String(key), {
        key: String(key),
        actor_id: String(actorId),
        request_hash: String(requestHash),
        response_code: Number(responseCode),
        response_body: String(responseBody),
        ttl_seconds: Number(ttlSeconds),
        expires_at: expiresAt as Date,
        created_at: new Date(),
      })
      return { rows: [], rowCount: 1 }
    }

    if (sql.includes('INSERT INTO settlements')) {
      if (failNextSettlement) {
        const error = failNextSettlement
        failNextSettlement = undefined
        throw error
      }

      const [bondId, amount, transactionHash, settledAt, status] = params
      const existing = settlementsByTx.get(String(transactionHash))
      const now = new Date()
      const settledAtDate = (settledAt as Date | undefined) ?? now
      const settlementStatus = (status as SettlementRow['status'] | undefined) ?? 'pending'

      if (existing) {
        const updated = {
          ...existing,
          bond_id: bondId as string | number,
          amount: String(amount),
          settled_at: settledAtDate,
          status: settlementStatus,
          updated_at: new Date(existing.created_at.getTime() + 1),
          is_duplicate: true,
        }
        settlementsByTx.set(String(transactionHash), updated)
        return { rows: [updated], rowCount: 1 }
      }

      const row: SettlementRow = {
        id: String(nextSettlementId++),
        bond_id: bondId as string | number,
        amount: String(amount),
        transaction_hash: String(transactionHash),
        settled_at: settledAtDate,
        status: settlementStatus,
        created_at: now,
        updated_at: now,
        is_duplicate: false,
      }
      settlementsByTx.set(String(transactionHash), row)
      return { rows: [row], rowCount: 1 }
    }

    throw new Error(`Unexpected query in payouts route test: ${sql}`)
  })

  return {
    idempotencyKeys,
    settlementsByTx,
    query,
    failNextSettlement(error: Error) {
      failNextSettlement = error
    },
    reset() {
      idempotencyKeys.clear()
      settlementsByTx.clear()
      nextSettlementId = 1
      failNextSettlement = undefined
      query.mockClear()
    },
  }
})

vi.mock('../db/pool.js', () => ({
  pool: { query: db.query, on: vi.fn() },
  workerPool: { query: vi.fn(), on: vi.fn() },
  replicaPool: { query: vi.fn(), on: vi.fn() },
  withReplica: vi.fn(),
}))

vi.mock('../cache/invalidation.js', () => ({
  invalidateCache: vi.fn().mockResolvedValue(true),
}))

vi.mock('../middleware/metrics.js', () => ({
  recordSettlementDuplicate: vi.fn(),
}))

const VALID_TX_HASH = 'a'.repeat(64)
const PAYOUT_KEY = 'test-payouts-write-key'

const validPayload = {
  bondId: 'bond-123',
  amount: '42.50',
  transactionHash: VALID_TX_HASH,
  settledAt: '2026-06-19T12:00:00.000Z',
  status: 'settled',
}

/** Builds a focused Express app that runs the real payouts route middleware chain. */
function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/payouts', createPayoutsRouter())
  app.use(errorHandler)
  return app
}

/** Posts to the payouts endpoint with the default write-scoped API key. */
function postPayout(
  app: express.Express,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return request(app)
    .post('/api/payouts')
    .set('x-api-key', PAYOUT_KEY)
    .set(headers)
    .send(payload)
}

describe('Payouts route', () => {
  beforeEach(() => {
    db.reset()
    vi.mocked(recordSettlementDuplicate).mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a payout settlement for a valid write-scoped request', async () => {
    const res = await postPayout(createApp(), validPayload)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      success: true,
      data: {
        id: '1',
        bondId: 'bond-123',
        amount: '42.50',
        transactionHash: VALID_TX_HASH,
        status: 'settled',
      },
    })
    expect(db.settlementsByTx.get(VALID_TX_HASH)?.status).toBe('settled')
  })

  it('uses settlement defaults when optional payout fields are omitted', async () => {
    const transactionHash = 'b'.repeat(64)

    const res = await postPayout(createApp(), {
      bondId: 'bond-456',
      amount: '15',
      transactionHash,
    })

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      bondId: 'bond-456',
      amount: '15',
      transactionHash,
      status: 'pending',
    })
    expect(new Date(res.body.data.settledAt).toString()).not.toBe('Invalid Date')
  })

  it('returns the structured validation envelope for malformed payout input', async () => {
    const res = await postPayout(createApp(), {
      ...validPayload,
      amount: '-1',
    })

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'amount' }),
      ]),
    )
    expect(db.settlementsByTx.size).toBe(0)
  })

  it('requires authentication before payout creation', async () => {
    const res = await request(createApp()).post('/api/payouts').send(validPayload)

    expect(res.status).toBe(401)
    expect(res.body).toEqual({
      error: 'Unauthorized',
      message: 'API key is required',
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects API keys without the payouts:write scope', async () => {
    const res = await request(createApp())
      .post('/api/payouts')
      .set('x-api-key', 'test-public-key-67890')
      .send(validPayload)

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({
      error: 'Forbidden',
      requiredScope: 'payouts:write',
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('replays a cached response for the same idempotency key and payload', async () => {
    const app = createApp()

    const first = await postPayout(app, validPayload, { 'idempotency-key': 'payout-create-1' })
    const second = await postPayout(app, validPayload, { 'idempotency-key': 'payout-create-1' })

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)
    expect(db.settlementsByTx.size).toBe(1)
  })

  it('returns a structured 409 when an idempotency key is replayed with a different payload', async () => {
    const app = createApp()

    await postPayout(app, validPayload, { 'idempotency-key': 'payout-create-2' })
    const replay = await postPayout(
      app,
      { ...validPayload, amount: '84.00' },
      { 'idempotency-key': 'payout-create-2' },
    )

    expect(replay.status).toBe(409)
    expect(replay.body.error_code).toBe(ErrorCode.IDEMPOTENCY_KEY_MISMATCH)
    expect(replay.body.code).toBe(ErrorCode.IDEMPOTENCY_KEY_MISMATCH)
    expect(db.settlementsByTx.size).toBe(1)
  })

  it('collapses duplicate transaction hashes through settlement upsert semantics', async () => {
    const app = createApp()

    const first = await postPayout(app, validPayload)
    const duplicate = await postPayout(app, {
      ...validPayload,
      amount: '50.00',
      status: 'failed',
    })

    expect(first.status).toBe(201)
    expect(duplicate.status).toBe(201)
    expect(duplicate.body.data).toMatchObject({
      id: first.body.data.id,
      amount: '50.00',
      transactionHash: VALID_TX_HASH,
      status: 'failed',
    })
    expect(recordSettlementDuplicate).toHaveBeenCalledTimes(1)
  })

  it('maps persistence failures to the structured internal error taxonomy', async () => {
    db.failNextSettlement(new Error('database unavailable'))

    const res = await postPayout(createApp(), validPayload)

    expect(res.status).toBe(500)
    expect(res.body.error_code).toBe(ErrorCode.INTERNAL_SERVER_ERROR)
    expect(res.body.code).toBe(ErrorCode.INTERNAL_SERVER_ERROR)
  })
})
