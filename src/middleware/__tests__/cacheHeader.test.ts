import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { Express } from 'express'
import request from 'supertest'
import { cacheHeaderMiddleware } from '../cacheHeader.js'
import { cache } from '../../cache/redis.js'
import { HEADER_X_CACHE } from '../../config/constants.js'
import { recordCacheHit, recordCacheMiss } from '../../utils/cacheContext.js'

describe('cacheHeaderMiddleware', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(cacheHeaderMiddleware)
    vi.restoreAllMocks()
  })

  it('should not set x-cache header if no cache operations occur', async () => {
    app.get('/no-cache', (_req, res) => {
      res.json({ message: 'ok' })
    })

    const response = await request(app).get('/no-cache')
    expect(response.headers[HEADER_X_CACHE]).toBeUndefined()
  })

  it('should set x-cache header when hit/miss is called directly', async () => {
    app.get('/direct-hit', (_req, res) => {
      recordCacheHit()
      res.json({ message: 'ok' })
    })

    const response = await request(app).get('/direct-hit')
    expect(response.headers[HEADER_X_CACHE]).toBe('HIT')
  })

  it('should set x-cache: HIT when cache get hits L1 cache with fresh data', async () => {
    vi.spyOn(cache['l1Cache'], 'get').mockReturnValue({ data: 'some-data', staleness: { fresh: true, refreshStatus: 'ok' } })

    app.get('/cache-hit', async (_req, res) => {
      await cache.get('test-ns', 'test-key')
      res.json({ message: 'ok' })
    })

    const response = await request(app).get('/cache-hit')
    expect(response.headers[HEADER_X_CACHE]).toBe('HIT')
  })

  it('should set x-cache: MISS when cache get misses L1 and L2 (Redis)', async () => {
    vi.spyOn(cache['l1Cache'], 'get').mockReturnValue(undefined)
    vi.spyOn(cache['redis'], 'connect').mockResolvedValue(undefined)
    vi.spyOn(cache['redis'], 'getClient').mockReturnValue({
      get: vi.fn().mockResolvedValue(null)
    } as any)

    app.get('/cache-miss', async (_req, res) => {
      await cache.get('test-ns', 'test-key')
      res.json({ message: 'ok' })
    })

    const response = await request(app).get('/cache-miss')
    expect(response.headers[HEADER_X_CACHE]).toBe('MISS')
  })

  it('should set x-cache: STALE when cache hit returned is stale', async () => {
    vi.spyOn(cache['l1Cache'], 'get').mockReturnValue({ data: 'stale-data', staleness: { fresh: false, refreshStatus: 'stale' } })

    app.get('/cache-stale', async (_req, res) => {
      await cache.get('test-ns', 'test-key')
      res.json({ message: 'ok' })
    })

    const response = await request(app).get('/cache-stale')
    expect(response.headers[HEADER_X_CACHE]).toBe('STALE')
  })

  it('should set x-cache: STALE when nested or plain object is stale', async () => {
    vi.spyOn(cache['l1Cache'], 'get').mockReturnValue({ data: 'stale-data', refreshStatus: 'stale' })

    app.get('/cache-stale-nested', async (_req, res) => {
      await cache.get('test-ns', 'test-key')
      res.json({ message: 'ok' })
    })

    const response = await request(app).get('/cache-stale-nested')
    expect(response.headers[HEADER_X_CACHE]).toBe('STALE')
  })

  it('should prioritize STALE over MISS and HIT', async () => {
    app.get('/cache-mixed', (_req, res) => {
      recordCacheHit()
      recordCacheMiss()
      recordCacheHit(true) // stale
      res.json({ message: 'ok' })
    })

    const response = await request(app).get('/cache-mixed')
    expect(response.headers[HEADER_X_CACHE]).toBe('STALE')
  })

  it('should prioritize MISS over HIT when no stale exists', async () => {
    app.get('/cache-mixed-miss', (_req, res) => {
      recordCacheHit()
      recordCacheMiss()
      res.json({ message: 'ok' })
    })

    const response = await request(app).get('/cache-mixed-miss')
    expect(response.headers[HEADER_X_CACHE]).toBe('MISS')
  })
})
