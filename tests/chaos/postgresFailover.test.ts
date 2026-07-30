import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { Pool } from 'pg'
import trustRouter from '../../src/routes/trust.js'
import { createRateLimitMiddleware } from '../../src/middleware/rateLimit.js'
import { requestIdMiddleware } from '../../src/middleware/requestId.js'
import { securityHeadersWithOverride } from '../../src/middleware/securityHeaders.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import {
  dockerComposeUp,
  dockerComposeDown,
  dockerComposeRestart,
  waitForDbConnection,
  waitForUrl,
  waitForRedis,
} from './chaosHelpers.js'

vi.setTimeout(120000)

describe('Postgres failover chaos', () => {
  const dbUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://credence:credence@localhost:5433/credence_test'
  const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380'
  const horizonUrl = process.env.TEST_HORIZON_URL ?? 'http://localhost:8000'
  let pool: Pool
  let app: express.Express

  beforeAll(async () => {
    process.env.DB_URL = dbUrl
    process.env.REDIS_URL = redisUrl
    process.env.HORIZON_URL = horizonUrl
    process.env.NODE_ENV = 'test'

    await dockerComposeUp()
    await waitForDbConnection(dbUrl)
    await waitForRedis(redisUrl)
    await waitForUrl(`${horizonUrl}/health`)

    pool = new Pool({ connectionString: dbUrl })
    await pool.query(`
      CREATE TABLE IF NOT EXISTS identities (
        address TEXT PRIMARY KEY,
        bonded_amount TEXT NOT NULL,
        bond_start TIMESTAMPTZ
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attestations (
        id SERIAL PRIMARY KEY,
        subject_address TEXT NOT NULL
      )
    `)
    await pool.query(
      `INSERT INTO identities (address, bonded_amount, bond_start)
       VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE SET bonded_amount = excluded.bonded_amount, bond_start = excluded.bond_start`,
      ['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '1000000000000000000', '2024-01-01T00:00:00.000Z'],
    )

    app = express()
    app.use(express.json())
    app.use(requestIdMiddleware)
    app.use(securityHeadersWithOverride)
    app.use(
      '/api',
      createRateLimitMiddleware({
        enabled: true,
        windowSec: 60,
        maxFree: 100,
        maxPro: 100,
        maxEnterprise: 100,
        failOpen: true,
      }),
    )

    app.get('/chaos/slow-db/:seconds', async (req, res, next) => {
      const seconds = Number(req.params.seconds)
      const client = await pool.connect()
      try {
        await client.query('SELECT pg_sleep($1)', [seconds])
        res.status(200).json({ success: true })
      } catch (error) {
        next(error)
      } finally {
        client.release()
      }
    })

    app.use('/api/trust', trustRouter)
    app.use(errorHandler)
  })

  afterAll(async () => {
    await pool.end().catch(() => {})
    await dockerComposeDown()
  })

  it('keeps trust scoring available after a Postgres restart', async () => {
    const address = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

    const baselineResponse = await request(app).get(`/api/trust/${address}`)
    expect(baselineResponse.status).toBe(200)
    expect(baselineResponse.body.address).toBe(address.toLowerCase())

    const slowRequest = request(app).get('/chaos/slow-db/10')
    await new Promise((resolve) => setTimeout(resolve, 1000))

    await dockerComposeRestart('test-db')
    await waitForDbConnection(dbUrl)

    const slowResponse = await slowRequest
    expect([200, 500, 502, 503, 504]).toContain(slowResponse.status)

    const recoveredResponse = await request(app).get(`/api/trust/${address}`)
    expect(recoveredResponse.status).toBe(200)
    expect(recoveredResponse.body.address).toBe(address.toLowerCase())
  })
})
