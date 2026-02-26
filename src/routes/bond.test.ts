import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createBondRouter } from './bond.js'
import { BondStore, BondService } from '../services/bond/index.js'

function createApp() {
  const store = new BondStore()
  const service = new BondService(store)
  const app = express()
  app.use('/api/bond', createBondRouter(service))
  return { app, store }
}

describe('Bond routes', () => {
  describe('GET /api/bond/:address', () => {
    it('returns 200 with bond data for a known active address', async () => {
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
      expect(res.body.bondedAmount).toBe('1000000000000000000')
      expect(res.body.bondStart).toBe('2024-01-15T00:00:00.000Z')
      expect(res.body.bondDuration).toBe(31536000)
      expect(res.body.active).toBe(true)
      expect(res.body.slashedAmount).toBe('0')
    })

    it('returns 200 with inactive bond data', async () => {
      const { app, store } = createApp()
      store.set({
        address: '0x0000000000000000000000000000000000000001',
        bondedAmount: '0',
        bondStart: null,
        bondDuration: null,
        active: false,
        slashedAmount: '0',
      })

      const res = await request(app).get(
        '/api/bond/0x0000000000000000000000000000000000000001'
      )

      expect(res.status).toBe(200)
      expect(res.body.active).toBe(false)
      expect(res.body.bondedAmount).toBe('0')
      expect(res.body.bondStart).toBeNull()
      expect(res.body.bondDuration).toBeNull()
    })

    it('returns 200 with slashed bond data', async () => {
      const { app, store } = createApp()
      store.set({
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        bondedAmount: '500000000000000000',
        bondStart: '2024-06-01T00:00:00.000Z',
        bondDuration: 15768000,
        active: true,
        slashedAmount: '200000000000000000',
      })

      const res = await request(app).get(
        '/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      )

      expect(res.status).toBe(200)
      expect(res.body.slashedAmount).toBe('200000000000000000')
    })

    it('returns 200 with case-insensitive address lookup', async () => {
      const { app, store } = createApp()
      store.set({
        address: '0xabcdef1234567890abcdef1234567890abcdef12',
        bondedAmount: '100',
        bondStart: null,
        bondDuration: null,
        active: false,
        slashedAmount: '0',
      })

      const res = await request(app).get(
        '/api/bond/0xABCDEF1234567890abcdef1234567890ABCDEF12'
      )

      expect(res.status).toBe(200)
      expect(res.body.address).toBe(
        '0xabcdef1234567890abcdef1234567890abcdef12'
      )
    })

    it('returns 400 for an address without 0x prefix', async () => {
      const { app } = createApp()
      const res = await request(app).get(
        '/api/bond/f39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      )

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Invalid address format/)
    })

    it('returns 400 for an address that is too short', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/bond/0x1234')

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Invalid address format/)
    })

    it('returns 400 for a non-hex address', async () => {
      const { app } = createApp()
      const res = await request(app).get(
        '/api/bond/0xZZZZZZ0000000000000000000000000000000000'
      )

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Invalid address format/)
    })

    it('returns 400 for a plain text string', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/bond/not-an-address')

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Invalid address format/)
    })

    it('returns 404 for a valid address with no bond record', async () => {
      const { app } = createApp()
      const res = await request(app).get(
        '/api/bond/0x1234567890123456789012345678901234567890'
      )

      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/No bond record found/)
    })

    it('returns 404 with the normalised address in the error message', async () => {
      const { app } = createApp()
      const res = await request(app).get(
        '/api/bond/0xABCDEF1234567890ABCDEF1234567890ABCDEF99'
      )

      expect(res.status).toBe(404)
      expect(res.body.error).toContain(
        '0xabcdef1234567890abcdef1234567890abcdef99'
      )
    })
  })
})
