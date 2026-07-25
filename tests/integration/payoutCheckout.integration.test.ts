import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

// encodeCursor/decodeCursor (used by the transactions history route) sign
// cursors with JWT_SECRET via loadConfig(), which validates the full env
// up front. Set the minimum required vars before importing the routers,
// same pattern as tests/setup/reportTestEnv.ts.
process.env.DB_URL ??= 'postgresql://user:password@localhost:5432/credence_test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_SECRET ??= 'test-secret-32-characters-long-ok'

import { createPayoutsRouter } from '../../src/routes/payouts.js'
import { createTransactionsRouter } from '../../src/routes/transactions.js'

/**
 * #714: End-to-end happy-path test for the payout "checkout" flow —
 * POST /api/payouts (create/settle a payout) -> poll GET
 * /api/transactions/history (by bondId) -> assert the final settlement
 * state. This repo has no literal /orders endpoint; payouts + the
 * settlements they write are the closest equivalent to a checkout
 * flow (create a transaction, then poll for its resolved status).
 */

type SettlementRow = {
  id: string
  bond_id: string
  amount: string
  transaction_hash: string
  settled_at: Date
  status: 'pending' | 'settled' | 'failed'
  created_at: Date
  updated_at: Date
}

const db = vi.hoisted(() => {
  let rows: SettlementRow[] = []
  let nextId = 1

  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes('INSERT INTO settlements')) {
      const [bondId, amount, transactionHash, settledAt, status] = params as [
        string,
        string,
        string,
        Date,
        SettlementRow['status'],
      ]
      const existingIndex = rows.findIndex((r) => r.transaction_hash === transactionHash)
      const now = new Date()

      if (existingIndex >= 0) {
        rows[existingIndex] = {
          ...rows[existingIndex],
          amount,
          status,
          settled_at: settledAt,
          updated_at: now,
        }
        return { rows: [rows[existingIndex]], rowCount: 1 }
      }

      const row: SettlementRow = {
        id: String(nextId++),
        bond_id: String(bondId),
        amount,
        transaction_hash: transactionHash,
        settled_at: settledAt,
        status,
        created_at: now,
        updated_at: now,
      }
      rows.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (sql.includes('SELECT id FROM settlements WHERE transaction_hash')) {
      const [transactionHash] = params as [string]
      const match = rows.filter((r) => r.transaction_hash === transactionHash)
      return { rows: match, rowCount: match.length }
    }

    if (sql.includes('FROM settlements') && sql.includes('WHERE bond_id')) {
      const [, bondId] = params as [number, string]
      const filtered = rows
        .filter((r) => r.bond_id === String(bondId))
        .sort((a, b) => b.settled_at.getTime() - a.settled_at.getTime())
      return { rows: filtered, rowCount: filtered.length }
    }

    throw new Error(`Unexpected query in payoutCheckout integration test: ${sql}`)
  })

  return {
    query,
    reset() {
      rows = []
      nextId = 1
      query.mockClear()
    },
  }
})

vi.mock('../../src/db/pool.js', () => ({
  pool: { query: db.query, on: vi.fn() },
  workerPool: { query: vi.fn(), on: vi.fn() },
  replicaPool: { query: vi.fn(), on: vi.fn() },
  withReplica: vi.fn(),
}))

vi.mock('../../src/middleware/idempotency.js', () => ({
  idempotencyMiddleware: () => (req: any, res: any, next: any) => next(),
}))

vi.mock('../../src/middleware/auth.js', () => ({
  requireApiKey: () => (req: any, res: any, next: any) => {
    req.apiKey = { key: 'mock-key', scopes: ['payouts:write', 'trust:read'] }
    next()
  },
  ApiScope: {
    PAYOUTS_WRITE: 'payouts:write',
    TRUST_READ: 'trust:read',
  },
}))

vi.mock('../../src/cache/redis.js', () => ({
  cache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../src/cache/invalidation.js', () => ({
  invalidateCache: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/middleware/metrics.js', () => ({
  recordSettlementDuplicate: vi.fn(),
  recordSettlementDrift: vi.fn(),
  setSettlementUnmatchedCount: vi.fn(),
}))

function buildApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/payouts', createPayoutsRouter())
  app.use('/api/transactions', createTransactionsRouter())

  app.use((err: any, req: any, res: any, next: any) => {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: err.message, details: err.details })
    }
    res.status(500).json({ error: 'Internal Server Error' })
  })

  return app
}

beforeEach(() => {
  db.reset()
})

/** Polls a getter function until the predicate passes or attempts run out. */
async function pollUntil<T>(
  getter: () => Promise<T>,
  predicate: (value: T) => boolean,
  { attempts = 10, delayMs = 5 }: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  let last: T
  for (let i = 0; i < attempts; i++) {
    last = await getter()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return last!
}

describe('#714 payout checkout happy path', () => {
  it('creates a settled payout and the poller observes the final settled state', async () => {
    const app = buildApp()
    const bondId = 'bond-happy-1'
    const transactionHash = 'tx-happy-1'

    const postRes = await request(app).post('/api/payouts').send({
      bondId,
      amount: '25.5',
      transactionHash,
      status: 'settled',
      settledAt: new Date().toISOString(),
    })

    expect(postRes.status).toBe(201)
    expect(postRes.body.success).toBe(true)

    const finalState = await pollUntil(
      async () => {
        const res = await request(app).get('/api/transactions/history').query({ bondId })
        return res.body
      },
      (body) => body?.data?.[0]?.status === 'settled',
    )

    expect(finalState.success).toBe(true)
    expect(finalState.data).toHaveLength(1)
    expect(finalState.data[0]).toMatchObject({
      bondId,
      transactionHash,
      amount: '25.5',
      status: 'settled',
    })
  })
})

describe('#714 payout checkout sad path', () => {
  it('polling reflects a failed settlement instead of settled', async () => {
    const app = buildApp()
    const bondId = 'bond-sad-1'
    const transactionHash = 'tx-sad-1'

    const postRes = await request(app).post('/api/payouts').send({
      bondId,
      amount: '10',
      transactionHash,
      status: 'failed',
      settledAt: new Date().toISOString(),
    })

    expect(postRes.status).toBe(201)

    const finalState = await pollUntil(
      async () => {
        const res = await request(app).get('/api/transactions/history').query({ bondId })
        return res.body
      },
      (body) => body?.data?.[0]?.status === 'failed',
    )

    expect(finalState.data[0].status).toBe('failed')
  })

  it('rejects an invalid payout before any settlement is created, so polling finds nothing', async () => {
    const app = buildApp()
    const bondId = 'bond-sad-2'

    const postRes = await request(app).post('/api/payouts').send({
      bondId,
      amount: '-5',
      transactionHash: 'tx-sad-2',
      status: 'settled',
    })

    expect(postRes.status).toBe(400)

    const historyRes = await request(app).get('/api/transactions/history').query({ bondId })
    expect(historyRes.body.data).toHaveLength(0)
  })
})
