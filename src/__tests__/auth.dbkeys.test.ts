import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import { requireApiKey } from '../middleware/apiKey.js'
import { generateApiKey, _resetStore, revokeApiKey } from '../services/apiKeys.js'
import { userRepo } from '../repositories/userRepository.js'

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
      fetch(url, { method: 'GET', headers: { Authorization: token ?? '' } })
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
  userRepo._reset()
})

describe('DB-backed API key validation', () => {
  it('rejects revoked keys (401)', async () => {
    const created = generateApiKey('user-1')
    // revoke the key
    const ok = revokeApiKey(created.id)
    expect(ok).toBe(true)

    const app = express()
    app.get('/test', requireApiKey(), (_req, res) => res.json({ ok: true }))

    const { status } = await req(app, `Bearer ${created.key}`)
    expect(status).toBe(401)
  })

  it('rejects invalid-format keys (401)', async () => {
    const app = express()
    app.get('/test', requireApiKey(), (_req, res) => res.json({ ok: true }))

    const { status } = await req(app, 'Bearer bad_key')
    expect(status).toBe(401)
  })

  it('rejects unknown but well-formed keys (401)', async () => {
    // create a random-looking key but do not store it
    const random = 'cr_' + Buffer.from(''.padEnd(32, 'a')).toString('hex')
    const app = express()
    app.get('/test', requireApiKey(), (_req, res) => res.json({ ok: true }))

    const { status } = await req(app, `Bearer ${random}`)
    expect(status).toBe(401)
  })

  it('accepts active keys and attaches apiKeyRecord', async () => {
    const created = generateApiKey('user-42', 'full')
    const app = express()
    app.get('/test', requireApiKey('full'), (req: any, res) => {
      res.json({ id: req.apiKeyRecord?.id, scope: req.apiKeyRecord?.scope })
    })

    const { status, body } = await req(app, `Bearer ${created.key}`)
    expect(status).toBe(200)
    expect(body.id).toBe(created.id)
    expect(body.scope).toBe('full')
  })
})
