import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createJwksRouter, type JwksRouterOptions } from './jwks.js'
import { keyManager } from '../services/keyManager/index.js'

function buildApp(options?: JwksRouterOptions): Express {
  const app = express()
  app.use('/.well-known/jwks.json', createJwksRouter(options))
  return app
}

describe('GET /.well-known/jwks.json', () => {
  let app: Express

  beforeEach(async () => {
    keyManager._resetStore()
    await keyManager.initialize()
    app = buildApp()
  })

  it('returns 200', async () => {
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.status).toBe(200)
  })

  it('Content-Type is application/json', async () => {
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.headers['content-type']).toMatch(/application\/json/)
  })

  it('response body has a keys array', async () => {
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.body).toHaveProperty('keys')
    expect(Array.isArray(res.body.keys)).toBe(true)
  })

  it('keys array has one entry after initialize()', async () => {
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.body.keys).toHaveLength(1)
  })

  it('each key entry has kid, kty, alg, and use', async () => {
    const res = await request(app).get('/.well-known/jwks.json')
    for (const key of res.body.keys as Record<string, unknown>[]) {
      expect(key).toHaveProperty('kid')
      expect(key).toHaveProperty('kty')
      expect(key).toHaveProperty('alg', 'PS256')
      expect(key).toHaveProperty('use', 'sig')
    }
  })

  it('returns two keys immediately after rotation', async () => {
    await keyManager.rotate()
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.body.keys).toHaveLength(2)
  })

  it('active key kid matches the kid in the JWKS response', async () => {
    const activeKid = keyManager.getCurrentKey().kid
    const res = await request(app).get('/.well-known/jwks.json')
    const kids = (res.body.keys as { kid: string }[]).map((k) => k.kid)
    expect(kids).toContain(activeKid)
  })

  it('does not expose private key material in any entry', async () => {
    const res = await request(app).get('/.well-known/jwks.json')
    for (const key of res.body.keys as Record<string, unknown>[]) {
      expect(key).not.toHaveProperty('d')
      expect(key).not.toHaveProperty('p')
      expect(key).not.toHaveProperty('q')
    }
  })

  it('sets Cache-Control header with max-age=300 by default', async () => {
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.headers['cache-control']).toContain('max-age=300')
    expect(res.headers['cache-control']).toContain('stale-while-revalidate=60')
  })

  it('respects custom cacheMaxAgeSeconds option', async () => {
    const customApp = buildApp({ cacheMaxAgeSeconds: 600 })
    const res = await request(customApp).get('/.well-known/jwks.json')
    expect(res.headers['cache-control']).toContain('max-age=600')
    expect(res.headers['cache-control']).toContain('stale-while-revalidate=60')
  })

  it('sets max-age=0 when cacheMaxAgeSeconds is 0', async () => {
    const noCacheApp = buildApp({ cacheMaxAgeSeconds: 0 })
    const res = await request(noCacheApp).get('/.well-known/jwks.json')
    expect(res.headers['cache-control']).toContain('max-age=0')
    expect(res.headers['cache-control']).toContain('stale-while-revalidate=60')
  })

  it('returns 503 if keyManager.getPublicJwks throws', async () => {
    vi.spyOn(keyManager, 'getPublicJwks').mockRejectedValueOnce(new Error('not initialized'))
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.status).toBe(503)
    expect(res.body).toHaveProperty('error')
    vi.restoreAllMocks()
  })

  // ── ETag / 304 Not Modified conditional GET ─────────────────────────────

  it('sets a strong ETag header derived from the JWKS body', async () => {
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.headers['etag']).toBeDefined()
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/)
  })

  it('returns 304 Not Modified when If-None-Match matches the current ETag', async () => {
    const first = await request(app).get('/.well-known/jwks.json')
    const etag = first.headers['etag']
    expect(etag).toBeDefined()

    const second = await request(app)
      .get('/.well-known/jwks.json')
      .set('If-None-Match', etag)

    expect(second.status).toBe(304)
    // 304 has no body
    expect(second.body).toEqual({})
    // Cache-Control + ETag still emitted on 304 so clients can keep caching
    expect(second.headers['etag']).toBe(etag)
    expect(second.headers['cache-control']).toContain('max-age=300')
  })

  it('returns the full body when If-None-Match does not match (cache miss)', async () => {
    const first = await request(app).get('/.well-known/jwks.json')
    const staleEtag = '"deadbeef"'

    const second = await request(app)
      .get('/.well-known/jwks.json')
      .set('If-None-Match', staleEtag)

    expect(second.status).toBe(200)
    expect(Array.isArray(second.body.keys)).toBe(true)
    expect(second.body.keys).toHaveLength(first.body.keys.length)
    // ETag stays in sync with the current body
    expect(second.headers['etag']).toBe(first.headers['etag'])
  })

  it('honours custom cacheMaxAgeSeconds when emitting both max-age and ETag', async () => {
    const customApp = buildApp({ cacheMaxAgeSeconds: 600 })
    const res = await request(customApp).get('/.well-known/jwks.json')
    expect(res.headers['cache-control']).toContain('max-age=600')
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/)
  })

  it('changes the ETag after a key rotation', async () => {
    const before = await request(app).get('/.well-known/jwks.json')
    await keyManager.rotate()
    const after = await request(app).get('/.well-known/jwks.json')

    expect(after.body.keys).toHaveLength(2)
    expect(after.headers['etag']).not.toBe(before.headers['etag'])
    // Re-using the now-stale ETag must yield 200 (not 304) because the body changed.
    const back = await request(app)
      .get('/.well-known/jwks.json')
      .set('If-None-Match', before.headers['etag'])
    expect(back.status).toBe(200)
  })
})
