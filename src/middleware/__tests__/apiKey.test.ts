import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import { requireApiKey, requireScope } from '../apiKey.js'
import { generateApiKey, _resetStore, ApiKeyScope } from '../../services/apiKeys.js'

async function req(app: express.Express, token?: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('No address'))
        return
      }
      const url = `http://127.0.0.1:${addr.port}/test`
      fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token ?? ''}` } })
        .then(async (res) => {
          const body = await res.json().catch(() => null)
          server.close()
          resolve({ status: res.status, body })
        })
        .catch((err) => {
          server.close()
          reject(err)
        })
    })
  })
}

beforeEach(() => {
  _resetStore()
})

describe('requireScope middleware', () => {
  it('rejects a key that lacks the required scope (403 Forbidden)', async () => {
    const created = generateApiKey('user-1', 'read')
    const app = express()
    app.get('/test', requireApiKey(), requireScope(ApiKeyScope.ATTESTATIONS_WRITE), (_req, res) => {
      res.json({ ok: true })
    })

    const { status, body } = await req(app, created.key)
    expect(status).toBe(403)
    expect(body.code).toBe('FORBIDDEN')
    expect(body.error).toContain('Insufficient scope')
  })

  it('accepts a key that has the required granular scope', async () => {
    const created = generateApiKey('user-1', ApiKeyScope.ATTESTATIONS_WRITE)
    const app = express()
    app.get('/test', requireApiKey(), requireScope(ApiKeyScope.ATTESTATIONS_WRITE), (_req, res) => {
      res.json({ ok: true })
    })

    const { status } = await req(app, created.key)
    expect(status).toBe(200)
  })

  it('accepts a full/enterprise key for any granular scope', async () => {
    const created = generateApiKey('user-1', 'full')
    const app = express()
    app.get('/test', requireApiKey(), requireScope(ApiKeyScope.ATTESTATIONS_WRITE), (_req, res) => {
      res.json({ ok: true })
    })

    const { status } = await req(app, created.key)
    expect(status).toBe(200)
  })

  it('rejects request with 401 when requireScope is used without requireApiKey', () => {
    const app = express()
    const handler = requireScope(ApiKeyScope.TRUST_READ)
    const req = { apiKeyRecord: undefined } as any
    const res = {} as any
    expect(() => handler(req, res, () => {})).toThrow('API key required')
  })

  it('returns typed error FORBIDDEN for insufficient scope', async () => {
    const created = generateApiKey('user-1', [ApiKeyScope.TRUST_READ])
    const app = express()
    app.get('/test', requireApiKey(), requireScope(ApiKeyScope.PAYOUTS_WRITE), (_req, res) => {
      res.json({ ok: true })
    })

    const { status, body } = await req(app, created.key)
    expect(status).toBe(403)
    expect(body.code).toBe('FORBIDDEN')
  })
})
