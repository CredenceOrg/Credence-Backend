import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createTransactionsRouter } from '../../src/routes/transactions.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { encodeCursor } from '../../src/lib/pagination.js'
import { ErrorCode } from '../../src/lib/errors.js'

const db = vi.hoisted(() => {
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

  let rows: SettlementRow[] = []
  let failNextQuery: Error | undefined
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (!sql.includes('FROM settlements')) {
      throw new Error(`Unexpected query in transactions route test: ${sql}`)
    }

    if (failNextQuery) {
      const error = failNextQuery
      failNextQuery = undefined
      throw error
    }

    const [limit, second, third] = params
    let filtered = [...rows]

    if (sql.includes('WHERE bond_id = $2')) {
      filtered = filtered.filter((row) => row.bond_id === second)
    }

    const hasCursor = sql.includes('(settled_at, id) <')
    if (hasCursor) {
      const cursorTime = new Date(String(sql.includes('WHERE bond_id = $2') ? third : second))
      const cursorId = String(sql.includes('WHERE bond_id = $2') ? params[3] : third)

      filtered = filtered.filter((row) => {
        if (row.settled_at.getTime() < cursorTime.getTime()) return true
        if (row.settled_at.getTime() > cursorTime.getTime()) return false
        return row.id < cursorId
      })
    }

    filtered.sort((left, right) => {
      const byTime = right.settled_at.getTime() - left.settled_at.getTime()
      return byTime || right.id.localeCompare(left.id)
    })

    return { rows: filtered.slice(0, Number(limit)), rowCount: filtered.length }
  })

  return {
    query,
    failNextQuery(error: Error) {
      failNextQuery = error
    },
    reset(nextRows: SettlementRow[]) {
      rows = [...nextRows]
      failNextQuery = undefined
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

const fixtures = [
  settlement('003', 'bond-a', '2026-06-19T12:00:00.000Z', 'settled'),
  settlement('002', 'bond-a', '2026-06-19T11:00:00.000Z', 'pending'),
  settlement('001', 'bond-b', '2026-06-19T10:00:00.000Z', 'failed'),
]

function settlement(
  id: string,
  bondId: string,
  settledAt: string,
  status: 'pending' | 'settled' | 'failed',
) {
  return {
    id,
    bond_id: bondId,
    amount: `${Number(id)}.00`,
    transaction_hash: `tx-${id}`,
    settled_at: new Date(settledAt),
    status,
    created_at: new Date(settledAt),
    updated_at: new Date(settledAt),
  }
}

/** Builds a focused Express app with the real transactions route and error envelope. */
function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/transactions', createTransactionsRouter())
  app.use(errorHandler)
  return app
}

function getHistory(app: express.Express, path = '/api/transactions/history') {
  return request(app).get(path).set('x-api-key', 'test-trust-read-key')
}

describe('Transactions route', () => {
  beforeEach(() => {
    db.reset(fixtures)
  })

  it('lists transaction history in stable newest-first order', async () => {
    const res = await getHistory(createApp())

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.map((item: { id: string }) => item.id)).toEqual(['003', '002', '001'])
    expect(res.body.next_cursor).toBe(encodeCursor('2026-06-19T10:00:00.000Z', '001'))
  })

  it('filters transaction history by bondId', async () => {
    const res = await getHistory(createApp(), '/api/transactions/history?bondId=bond-a')

    expect(res.status).toBe(200)
    expect(res.body.data.map((item: { bondId: string }) => item.bondId)).toEqual(['bond-a', 'bond-a'])
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE bond_id = $2'),
      [20, 'bond-a'],
    )
  })

  it('uses limit boundaries when paginating transaction history', async () => {
    const res = await getHistory(createApp(), '/api/transactions/history?limit=2')

    expect(res.status).toBe(200)
    expect(res.body.data.map((item: { id: string }) => item.id)).toEqual(['003', '002'])
    expect(res.body.next_cursor).toBe(encodeCursor('2026-06-19T11:00:00.000Z', '002'))
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [2])
  })

  it('applies decoded cursor pagination after the previous page boundary', async () => {
    const cursor = encodeCursor('2026-06-19T11:00:00.000Z', '002')

    const res = await getHistory(createApp(), `/api/transactions/history?cursor=${cursor}&limit=20`)

    expect(res.status).toBe(200)
    expect(res.body.data.map((item: { id: string }) => item.id)).toEqual(['001'])
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('(settled_at, id) < ($2, $3)'),
      [20, '2026-06-19T11:00:00.000Z', '002'],
    )
  })

  it('returns an empty list when filters match no settlements', async () => {
    const res = await getHistory(createApp(), '/api/transactions/history?bondId=missing-bond')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      success: true,
      data: [],
      next_cursor: null,
    })
  })

  it('returns the standard validation envelope for invalid query input', async () => {
    const res = await getHistory(createApp(), '/api/transactions/history?limit=101')

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(res.body.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'limit' }),
      ]),
    )
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects tampered cursors with the standard validation envelope', async () => {
    const res = await getHistory(createApp(), '/api/transactions/history?cursor=not-a-cursor')

    expect(res.status).toBe(400)
    expect(res.body.error_code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'cursor', message: 'Invalid cursor format' }),
      ]),
    )
  })

  it('maps repository failures to the standard internal error envelope', async () => {
    db.failNextQuery(new Error('database unavailable'))

    const res = await getHistory(createApp())

    expect(res.status).toBe(500)
    expect(res.body.error_code).toBe(ErrorCode.INTERNAL_SERVER_ERROR)
    expect(res.body.code).toBe(ErrorCode.INTERNAL_SERVER_ERROR)
  })

  it('requires authentication before transaction history can be read', async () => {
    const res = await request(createApp()).get('/api/transactions/history')

    expect(res.status).toBe(401)
    expect(res.body).toEqual({
      error: 'Unauthorized',
      message: 'API key is required',
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects API keys without the trust:read scope', async () => {
    const res = await request(createApp())
      .get('/api/transactions/history')
      .set('x-api-key', 'test-payouts-write-key')

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({
      error: 'Forbidden',
      requiredScope: 'trust:read',
    })
    expect(db.query).not.toHaveBeenCalled()
  })
})
