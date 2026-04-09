import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createJwksRouter } from './jwks.js'
import { keyManager } from '../services/keyManager/index.js'

function buildApp(): Express {
  const app = express()
  app.use('/.well-known/jwks.json', createJwksRouter())
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

  it('sets Cache-Control header with max-age=300', async () => {
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.headers['cache-control']).toContain('max-age=300')
  })

  it('returns 503 if keyManager.getPublicJwks throws', async () => {
    vi.spyOn(keyManager, 'getPublicJwks').mockRejectedValueOnce(new Error('not initialized'))
    const res = await request(app).get('/.well-known/jwks.json')
    expect(res.status).toBe(503)
    expect(res.body).toHaveProperty('error')
    vi.restoreAllMocks()
  })
})
