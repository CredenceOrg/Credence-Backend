import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createPayoutsRouter } from '../../src/routes/payouts.js'

vi.mock('../../src/db/pool.js', () => ({
  pool: {
    query: vi.fn(),
  },
  workerPool: {
    query: vi.fn(),
  }
}))

vi.mock('../../src/middleware/idempotency.js', () => ({
  idempotencyMiddleware: () => (req: any, res: any, next: any) => next(),
}))

vi.mock('../../src/middleware/auth.js', () => ({
  requireApiKey: () => (req: any, res: any, next: any) => {
    req.apiKey = { key: 'mock-key', scopes: ['payouts:write'] }
    next()
  },
  ApiScope: {
    PAYOUTS_WRITE: 'payouts:write'
  }
}))

vi.mock('../../src/services/settlementService.js', () => {
  return {
    SettlementService: class {
      upsertSettlementStatus = vi.fn().mockResolvedValue({ id: '1', status: 'settled' });
    }
  }
})

function appWithPayouts() {
  const app = express()
  app.use(express.json())
  app.use('/api/payouts', createPayoutsRouter())
  
  // Basic error handler to catch validation errors
  app.use((err: any, req: any, res: any, next: any) => {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: err.message, details: err.details })
    }
    res.status(500).json({ error: 'Internal Server Error' })
  })
  
  return app
}

describe('Payouts route validation (#325)', () => {
  it('rejects invalid amount', async () => {
    const app = appWithPayouts()
    const res = await request(app).post('/api/payouts').send({
      bondId: '123',
      amount: '-10.5', // negative
      transactionHash: '0x123',
      status: 'settled'
    })
    
    expect(res.status).toBe(400)
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'amount' })
      ])
    )
  })

  it('rejects non-enum status', async () => {
    const app = appWithPayouts()
    const res = await request(app).post('/api/payouts').send({
      bondId: '123',
      amount: '10.5',
      transactionHash: '0x123',
      status: 'unknown_status'
    })
    
    expect(res.status).toBe(400)
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'status' })
      ])
    )
  })

  it('rejects malformed settledAt', async () => {
    const app = appWithPayouts()
    const res = await request(app).post('/api/payouts').send({
      bondId: '123',
      amount: '10.5',
      transactionHash: '0x123',
      status: 'settled',
      settledAt: 'not-a-date'
    })
    
    expect(res.status).toBe(400)
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'settledAt' })
      ])
    )
  })

  it('accepts valid payload', async () => {
    const app = appWithPayouts()
    const res = await request(app).post('/api/payouts').send({
      bondId: '123',
      amount: '10.5',
      transactionHash: '0x123',
      status: 'settled',
      settledAt: new Date().toISOString()
    })
    
    expect(res.status).toBe(201)
  })
})
