import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import { createBondRouter } from './bond.js'
import { BondStore, BondService } from '../services/bond/index.js'
import { AppError } from '../lib/errors.js'
import { CacheService } from '../cache/redis.js'

/**
 * Creates a minimal test app that includes:
 *  - The bond router
 *  - A simple error handler that serializes AppErrors to JSON
 *    (mirrors the behaviour of the production errorHandler middleware)
 */
function createApp(cacheService?: CacheService) {
  const store = new BondStore()
  const service = new BondService(store)
  const app = express()
  app.use(express.json())
  app.use('/api/bond', createBondRouter(service, cacheService))

  // Minimal error handler so ValidationError reaches the client
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json(err.toJSON())
      return
    }
    res.status(500).json({ error: 'Internal Server Error' })
  })

  return { app, store }
}

/**
 * Creates a mock CacheService that behaves like an in-memory LRU cache.
 * Matches CacheService.get(namespace, key) signature by joining with ':'.
 */
function createMockCache(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))

  return {
    get: vi.fn(async (namespace: string, key: string) => {
      return store.get(`${namespace}:${key}`) ?? null
    }),
    set: vi.fn(async (namespace: string, key: string, value: unknown) => {
      store.set(`${namespace}:${key}`, value)
      return true
    }),
    delete: vi.fn(async (namespace: string, key: string) => {
      return store.delete(`${namespace}:${key}`)
    }),
  } as unknown as CacheService
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

    // ─── 400 responses (validation via centralized middleware) ──────────────
    // The uniform error envelope is:
    //   { error, error_code, code, details: [{ path, message, code }] }

    it('returns 400 with uniform envelope for an address without 0x prefix', async () => {
      const { app } = createApp()
      const res = await request(app).get(
        '/api/bond/f39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      )

      expect(res.status).toBe(400)
      expect(res.body.error_code).toBe('validation_failed')
      expect(Array.isArray(res.body.details)).toBe(true)
      expect(res.body.details[0].path).toBe('address')
    })

    it('returns 400 with uniform envelope for an address that is too short', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/bond/0x1234')

      expect(res.status).toBe(400)
      expect(res.body.error_code).toBe('validation_failed')
      expect(Array.isArray(res.body.details)).toBe(true)
      expect(res.body.details[0].path).toBe('address')
    })

    it('returns 400 with uniform envelope for a non-hex address', async () => {
      const { app } = createApp()
      const res = await request(app).get(
        '/api/bond/0xZZZZZZ0000000000000000000000000000000000'
      )

      expect(res.status).toBe(400)
      expect(res.body.error_code).toBe('validation_failed')
      expect(Array.isArray(res.body.details)).toBe(true)
    })

    it('returns 400 with uniform envelope for a plain text string', async () => {
      const { app } = createApp()
      const res = await request(app).get('/api/bond/not-an-address')

      expect(res.status).toBe(400)
      expect(res.body.error_code).toBe('validation_failed')
      expect(Array.isArray(res.body.details)).toBe(true)
    })

    // ─── 404 responses ──────────────────────────────────────────────────────

    it('returns 404 for a valid address with no bond record', async () => {
      const { app } = createApp()
      const res = await request(app).get(
        '/api/bond/0x1234567890123456789012345678901234567890'
      )

      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/not found/i)
    })

    it('returns 404 with the normalised (lowercase) address in the error message', async () => {
      const { app } = createApp()
      const res = await request(app).get(
        '/api/bond/0xABCDEF1234567890ABCDEF1234567890ABCDEF99'
      )

      expect(res.status).toBe(404)
      // The Zod address schema lowercases the address before the handler sees it
      // so the 404 will reference the normalized lowercase form
      expect(res.body.error.toLowerCase()).toContain('0xabcdef')
    })
  })

  describe('GET /api/bond/:address (with cache)', () => {
    it('returns x-cache MISS on first request and populates cache', async () => {
      const cache = createMockCache()
      const { app, store } = createApp(cache)
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
      expect(res.headers['x-cache']).toBe('MISS')
      expect(cache.get).toHaveBeenCalledOnce()
      expect(cache.set).toHaveBeenCalledOnce()
    })

    it('returns x-cache HIT on second request from cache', async () => {
      const bond = {
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        bondedAmount: '1000000000000000000',
        bondStart: '2024-01-15T00:00:00.000Z',
        bondDuration: 31536000,
        active: true,
        slashedAmount: '0',
      }
      const cache = createMockCache({
        'bond:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': bond,
      })
      const { app } = createApp(cache)

      const res = await request(app).get(
        '/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      )

      expect(res.status).toBe(200)
      expect(res.headers['x-cache']).toBe('HIT')
      expect(res.body.address).toBe(bond.address)
      expect(res.body.status).toBe('active')
    })

    it('does not cache 404 responses', async () => {
      const cache = createMockCache()
      const { app } = createApp(cache)

      const res = await request(app).get(
        '/api/bond/0x1234567890123456789012345678901234567890'
      )

      expect(res.status).toBe(404)
      expect(cache.set).not.toHaveBeenCalled()
    })

    it('returns correct status for cached slashed bond', async () => {
      const bond = {
        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
        bondedAmount: '500000000000000000',
        bondStart: '2024-06-01T00:00:00.000Z',
        bondDuration: 15768000,
        active: true,
        slashedAmount: '200000000000000000',
      }
      const cache = createMockCache({
        'bond:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': bond,
      })
      const { app } = createApp(cache)

      const res = await request(app).get(
        '/api/bond/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      )

      expect(res.status).toBe(200)
      expect(res.headers['x-cache']).toBe('HIT')
      expect(res.body.status).toBe('slashed')
      expect(res.body.slashedAmount).toBe('200000000000000000')
    })
  })

  describe('POST /api/bond', () => {
    it('returns 501 not implemented', async () => {
      const { app } = createApp()
      const res = await request(app)
        .post('/api/bond')
        .send({ address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', bondedAmount: '1000' })

      expect(res.status).toBe(501)
      expect(res.body.error).toBe('Not implemented')
    })
  })
})
