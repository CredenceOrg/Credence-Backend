import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createBondRouter } from '../../src/routes/bond.js'
import { BondStore, BondService } from '../../src/services/bond/index.js'

function createApp() {
  const store = new BondStore()
  const service = new BondService(store)
  const app = express()
  app.use('/api/bond', createBondRouter(service))
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status || 500).json({
      error: err.message,
      code: err.code,
      error_code: err.code,
      details: err.details,
    })
  })
  return { app, store }
}

describe('Bond route integration', () => {
  it('returns 404 for a valid Ethereum address with no bond record', async () => {
    const { app } = createApp()

    const res = await request(app).get(
      '/api/bond/0x1234567890123456789012345678901234567890'
    )

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not found/i)
  })

  it('returns 400 for an invalid bond address', async () => {
    const { app } = createApp()

    const res = await request(app).get('/api/bond/not-an-address')

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Validation failed')
    expect(res.body.error_code).toBe('validation_failed')
  })

  it('returns 200 with bond status for a known address', async () => {
    const { app, store } = createApp()
    store.set({
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      bondedAmount: '1000000000000000000',
      bondStart: '2024-01-15T00:00:00.000Z',
      bondDuration: 31536000,
      active: true,
      slashedAmount: '0',
    })

    const res = await request(app).get(
      '/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    )

    expect(res.status).toBe(200)
    expect(res.body.address).toBe(
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    )
    expect(res.body.status).toBe('active')
    expect(res.body.bondedAmount).toBe('1000000000000000000')
  })

  it('returns correct derived status for slashed bond', async () => {
    const { app, store } = createApp()
    store.set({
      address: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
      bondedAmount: '500000000000000000',
      bondStart: '2024-06-01T00:00:00.000Z',
      bondDuration: 15768000,
      active: true,
      slashedAmount: '100000000000000000',
    })

    const res = await request(app).get(
      '/api/bond/0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'
    )

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('slashed')
    expect(res.body.slashedAmount).toBe('100000000000000000')
  })

  it('returns correct derived status for unbonded address', async () => {
    const { app, store } = createApp()
    store.set({
      address: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
      bondedAmount: '0',
      bondStart: null,
      bondDuration: null,
      active: false,
      slashedAmount: '0',
    })

    const res = await request(app).get(
      '/api/bond/0x90f79bf6eb2c4f870365e785982e1f101e93b906'
    )

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('unbonded')
  })

  it('returns 501 for POST /api/bond (not yet implemented)', async () => {
    const { app } = createApp()

    const res = await request(app)
      .post('/api/bond')
      .send({
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        bondedAmount: '1000000000000000000',
      })

    expect(res.status).toBe(501)
    expect(res.body.error).toBe('Not implemented')
  })
})
