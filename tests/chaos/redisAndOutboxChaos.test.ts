import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { Pool } from 'pg'
import trustRouter from '../../src/routes/trust.js'
import { createBondRouter } from '../../src/routes/bond.js'
import { BondService, BondStore } from '../../src/services/bond/index.js'
import { createOutboxAdminRouter } from '../../src/routes/admin/outbox.js'
import { createRateLimitMiddleware } from '../../src/middleware/rateLimit.js'
import { requestIdMiddleware } from '../../src/middleware/requestId.js'
import { securityHeadersWithOverride } from '../../src/middleware/securityHeaders.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { createOutboxSchema } from '../../src/db/outbox/schema.js'
import {
  dockerComposeUp,
  dockerComposeDown,
  dockerComposeStop,
  waitForDbConnection,
  waitForRedis,
  waitForUrl,
} from './chaosHelpers.js'

vi.setTimeout(120000)

describe('Redis stall and outbox chaos', () => {
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

    await createOutboxSchema(pool)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS outbox_quarantine (
        id BIGSERIAL PRIMARY KEY,
        original_event_id BIGINT NOT NULL UNIQUE,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        reason TEXT NOT NULL,
        error_message TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 5,
        quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reinjected_at TIMESTAMPTZ,
        reinjected_by TEXT
      )
    `)

    await pool.query(`DELETE FROM identities`)
    await pool.query(`DELETE FROM attestations`)
    await pool.query(`DELETE FROM event_outbox`)
    await pool.query(`DELETE FROM outbox_quarantine`)

    await pool.query(
      `INSERT INTO identities (address, bonded_amount, bond_start)
       VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE SET bonded_amount = excluded.bonded_amount, bond_start = excluded.bond_start`,
      ['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '1000000000000000000', '2024-01-01T00:00:00.000Z'],
    )

    await pool.query(
      `INSERT INTO outbox_quarantine (original_event_id, aggregate_type, aggregate_id, event_type, payload, reason, error_message, retry_count, max_retries)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ['1', 'bond', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'BondRecalculated', JSON.stringify({ original: true }), 'malformed_json', 'Stubbed for chaos test', 0, 5],
    )

    const bondStore = new BondStore()
    bondStore.set({
      address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      bondedAmount: '1000000000000000000',
      bondStart: '2024-01-01T00:00:00.000Z',
      bondDuration: 31536000,
      active: true,
      slashedAmount: '0',
    })

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

    app.use('/api/trust', trustRouter)
    app.use('/api/bond', createBondRouter(new BondService(bondStore)))
    app.use('/v1/admin/outbox', createOutboxAdminRouter())
    app.use(errorHandler)
  })

  afterAll(async () => {
    await pool.end().catch(() => {})
    await dockerComposeDown()
  })

  it('serves trust and bond requests while Redis is stalled and reinjects quarantined outbox events', async () => {
    const address = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

    const trustBefore = await request(app).get(`/api/trust/${address}`)
    expect(trustBefore.status).toBe(200)

    const bondBefore = await request(app).get(`/api/bond/${address}`)
    expect(bondBefore.status).toBe(200)

    await dockerComposeStop('test-redis')
    await new Promise((resolve) => setTimeout(resolve, 2000))

    const trustAfter = await request(app).get(`/api/trust/${address}`)
    expect(trustAfter.status).toBe(200)
    expect(trustAfter.body.address).toBe(address.toLowerCase())

    const bondAfter = await request(app).get(`/api/bond/${address}`)
    expect(bondAfter.status).toBe(200)
    expect(bondAfter.body.address).toBe(address.toLowerCase())

    const reinjectResponse = await request(app)
      .post('/v1/admin/outbox/quarantine/1/reinject')
      .set('X-API-Key', 'test-outbox-reinject-key')
      .send({ payload: { retry: true } })

    expect(reinjectResponse.status).toBe(201)
    expect(reinjectResponse.body.success).toBe(true)
    expect(reinjectResponse.body.data.quarantineId).toBe('1')

    const eventRow = await pool.query(`SELECT status, payload FROM event_outbox ORDER BY id DESC LIMIT 1`)
    expect(eventRow.rows.length).toBe(1)
    expect(eventRow.rows[0].status).toBe('pending')
    expect(eventRow.rows[0].payload).toEqual(expect.objectContaining({ retry: true }))
  })
})
