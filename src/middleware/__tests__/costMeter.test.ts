import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import express, { type Express } from 'express'
import { type AddressInfo } from 'net'
import { newDb, type IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import client from 'prom-client'
import {
  createCostMeterMiddleware,
  resolveCostWeight,
  shouldEmitLowCreditAlert,
  type CostMeterConfig,
} from '../costMeter.js'
import { _resetStore } from '../../services/apiKeys.js'
import { creditsLowEventsTotal } from '../../observability/creditsMetrics.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function request(
  app: Express,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Could not get server address'))
        return
      }

      const url = `http://127.0.0.1:${addr.port}${path}`
      fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json', ...headers } })
        .then(async (res) => {
          const body = await res.json().catch(() => null)
          const responseHeaders: Record<string, string> = {}
          res.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value })
          server.close()
          resolve({ status: res.status, body, headers: responseHeaders })
        })
        .catch((err) => {
          server.close()
          reject(err)
        })
    })
  })
}

async function buildTestDb(): Promise<{ db: IMemoryDb; pool: Pool }> {
  const db = newDb()

  db.public.none(`
    CREATE TABLE org_credits (
      org_id UUID PRIMARY KEY,
      credits_remaining BIGINT NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      low_credit_threshold BIGINT,
      low_credit_alert_armed BOOLEAN NOT NULL DEFAULT true,
      last_top_up_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  db.public.none(`
    CREATE TABLE credit_transactions (
      id BIGSERIAL PRIMARY KEY,
      org_id UUID NOT NULL,
      transaction_type VARCHAR(20) NOT NULL,
      amount BIGINT NOT NULL,
      credits_remaining_before BIGINT NOT NULL,
      credits_remaining_after BIGINT NOT NULL,
      endpoint TEXT,
      cost_weight INTEGER,
      request_id TEXT,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  db.public.none(`
    CREATE TABLE event_outbox (
      id BIGSERIAL PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 5,
      trace_id TEXT,
      span_id TEXT,
      tracestate TEXT,
      correlation_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  return { db, pool }
}

async function getOutboxEvents(pool: Pool) {
  const { rows } = await pool.query(
    'SELECT event_type, payload, aggregate_id FROM event_outbox ORDER BY id',
  )
  return rows
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('shouldEmitLowCreditAlert', () => {
  it('returns true when crossing from above to at threshold', () => {
    expect(shouldEmitLowCreditAlert(101, 100, 100, true)).toBe(true)
  })

  it('returns true when crossing from above to below threshold', () => {
    expect(shouldEmitLowCreditAlert(101, 99, 100, true)).toBe(true)
  })

  it('returns false when already at or below threshold', () => {
    expect(shouldEmitLowCreditAlert(100, 99, 100, true)).toBe(false)
  })

  it('returns false when alert is disarmed', () => {
    expect(shouldEmitLowCreditAlert(101, 99, 100, false)).toBe(false)
  })

  it('returns false when staying above threshold', () => {
    expect(shouldEmitLowCreditAlert(200, 199, 100, true)).toBe(false)
  })
})

describe('resolveCostWeight', () => {
  const weights: CostMeterConfig['costWeights'] = {
    default: 1,
    '/bulk/verify': 10,
    '/reports': 5,
  }

  it('returns exact match weight', () => {
    expect(resolveCostWeight('/reports', weights)).toBe(5)
  })

  it('returns default for unknown path', () => {
    expect(resolveCostWeight('/unknown', weights)).toBe(1)
  })

  it('returns 0 for explicitly zero-weighted path', () => {
    expect(resolveCostWeight('/reports', { ...weights, '/reports': 0 })).toBe(0)
  })
})

describe('CostMeter Middleware (In-Memory)', () => {
  let app: Express
  let pool: Pool
  let config: CostMeterConfig
  let emitOutbox: ReturnType<typeof vi.fn>

  const TEST_ORG_ID = '00000000-0000-0000-0000-000000000001'
  const TEST_CREDITS = 100
  const LOW_THRESHOLD = 10

  beforeAll(async () => {
    const built = await buildTestDb()
    pool = built.pool
    _resetStore()
  })

  afterAll(() => {
    _resetStore()
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM event_outbox')
    await pool.query('DELETE FROM credit_transactions')
    await pool.query('DELETE FROM org_credits')
    _resetStore()
    creditsLowEventsTotal.reset()
    emitOutbox = vi.fn(async (_db, event) => {
      await pool.query(
        `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [event.aggregateType, event.aggregateId, event.eventType, JSON.stringify(event.payload)],
      )
      return BigInt(1)
    })

    config = {
      costWeights: { default: 1 },
      defaultMonthlyCredits: TEST_CREDITS,
      defaultLowCreditThreshold: LOW_THRESHOLD,
    }

    app = express()
    app.use(express.json())
  })

  function setOrgId(req: any, _res: any, next: any) {
    req.apiKeyRecord = { ownerId: TEST_ORG_ID, id: 'key-1', scopes: ['enterprise'], scope: 'full', tier: 'enterprise', hashedKey: '', prefix: '', createdAt: new Date(), lastUsedAt: null, active: true }
    next()
  }

  function mountCostMeter() {
    const costMeter = createCostMeterMiddleware(config, () => pool, { emitOutbox })
    app.use(setOrgId)
    app.use(costMeter)
  }

  // ── Basic flow ────────────────────────────────────────────────────────────

  it('deducts credits and sets X-Credits-Remaining header on success', async () => {
    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    const res = await request(app, '/test')

    expect(res.status).toBe(200)
    expect(res.headers['x-credits-remaining']).toBe(String(TEST_CREDITS - 1))
  })

  it('returns 402 when credits are insufficient', async () => {
    await pool.query(
      'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_alert_armed) VALUES ($1, $2, $3, true)',
      [TEST_ORG_ID, 0, 1],
    )

    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    const res = await request(app, '/test')

    expect(res.status).toBe(402)
    const body = res.body as any
    expect(body.error).toBe('InsufficientCredits')
    expect(body.creditsRequired).toBe(1)
    expect(body.creditsRemaining).toBe(0)
    expect(body.creditsDeficit).toBe(1)
  })

  // ── Free endpoints ────────────────────────────────────────────────────────

  it('skips deduction when cost weight is 0', async () => {
    config = { ...config, costWeights: { default: 0 } }

    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    const res = await request(app, '/test')

    expect(res.status).toBe(200)
    expect(res.headers['x-credits-remaining']).toBeUndefined()
  })

  // ── Unauthenticated ───────────────────────────────────────────────────────

  it('skips deduction when no org ID is found', async () => {
    const costMeter = createCostMeterMiddleware(config, () => pool, { emitOutbox })
    app.use(costMeter)
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    const res = await request(app, '/test')

    expect(res.status).toBe(200)
    expect(res.headers['x-credits-remaining']).toBeUndefined()
  })

  // ── New org initialization ─────────────────────────────────────────────────

  it('initializes credits for new org on first request', async () => {
    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    await request(app, '/test')

    const { rows } = await pool.query('SELECT credits_remaining FROM org_credits WHERE org_id = $1', [TEST_ORG_ID])
    expect(Number(rows[0].credits_remaining)).toBe(TEST_CREDITS - 1)
  })

  // ── Multiple deductions ────────────────────────────────────────────────────

  it('decrements credits across multiple requests', async () => {
    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    const r1 = await request(app, '/test')
    expect(r1.headers['x-credits-remaining']).toBe(String(TEST_CREDITS - 1))

    const r2 = await request(app, '/test')
    expect(r2.headers['x-credits-remaining']).toBe(String(TEST_CREDITS - 2))

    const r3 = await request(app, '/test')
    expect(r3.headers['x-credits-remaining']).toBe(String(TEST_CREDITS - 3))
  })

  // ── Refund on handler error ────────────────────────────────────────────────

  it('refunds credits when handler returns 5xx', async () => {
    mountCostMeter()
    app.get('/error', (_req, res) => { res.status(500).json({ error: 'fail' }) })

    await request(app, '/error')
    await new Promise(resolve => setTimeout(resolve, 50))

    const { rows } = await pool.query('SELECT credits_remaining FROM org_credits WHERE org_id = $1', [TEST_ORG_ID])
    expect(Number(rows[0].credits_remaining)).toBe(TEST_CREDITS)
  })

  it('does NOT refund credits when handler returns 4xx', async () => {
    mountCostMeter()
    app.get('/notfound', (_req, res) => { res.status(404).json({ error: 'not found' }) })

    await request(app, '/notfound')

    const { rows } = await pool.query('SELECT credits_remaining FROM org_credits WHERE org_id = $1', [TEST_ORG_ID])
    expect(Number(rows[0].credits_remaining)).toBe(TEST_CREDITS - 1)
  })

  it('refunds credits when handler calls next(err)', async () => {
    mountCostMeter()
    app.get('/error', (_req, _res, next) => { next(new Error('handler error')) })
    app.use((_err: any, _req: any, res: any, _next: any) => { res.status(500).json({ error: 'fail' }) })

    await request(app, '/error')
    await new Promise(resolve => setTimeout(resolve, 50))

    const { rows } = await pool.query('SELECT credits_remaining FROM org_credits WHERE org_id = $1', [TEST_ORG_ID])
    expect(Number(rows[0].credits_remaining)).toBe(TEST_CREDITS)
  })

  // ── Concurrent deducts ─────────────────────────────────────────────────────

  it('handles concurrent deducts with optimistic locking', async () => {
    await pool.query(
      'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_alert_armed) VALUES ($1, $2, $3, true)',
      [TEST_ORG_ID, 5, 1],
    )

    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    const httpServer = app.listen(0)
    const port = (httpServer.address() as AddressInfo).port
    const baseUrl = `http://127.0.0.1:${port}`

    const allResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        fetch(`${baseUrl}/test`).then(async (res) => ({
          status: res.status,
          creditsRemaining: Number(res.headers.get('x-credits-remaining') ?? -1),
        })),
      ),
    )

    httpServer.close()

    const successCount = allResults.filter(r => r.status === 200).length
    expect(successCount).toBeLessThanOrEqual(5)

    const { rows } = await pool.query('SELECT credits_remaining FROM org_credits WHERE org_id = $1', [TEST_ORG_ID])
    expect(Number(rows[0].credits_remaining)).toBeGreaterThanOrEqual(0)
  }, 10000)

  // ── Audit trail ────────────────────────────────────────────────────────────

  it('creates audit rows for deduct and refund', async () => {
    mountCostMeter()
    app.get('/error', (_req, res) => { res.status(500).json({ error: 'fail' }) })

    await request(app, '/error')
    await new Promise(resolve => setTimeout(resolve, 50))

    const { rows } = await pool.query(
      'SELECT transaction_type, amount FROM credit_transactions ORDER BY id',
    )
    expect(rows.length).toBe(2)
    expect(rows[0].transaction_type).toBe('deduct')
    expect(rows[1].transaction_type).toBe('refund')
  })

  // ── Low-credit webhook ─────────────────────────────────────────────────────

  it('emits credits.low once when crossing the default threshold', async () => {
    await pool.query(
      'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_alert_armed) VALUES ($1, $2, $3, true)',
      [TEST_ORG_ID, 11, 1],
    )

    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    await request(app, '/test')

    const outbox = await getOutboxEvents(pool)
    expect(outbox).toHaveLength(1)
    expect(outbox[0].event_type).toBe('credits.low')
    expect(outbox[0].payload).toMatchObject({
      orgId: TEST_ORG_ID,
      creditsRemaining: 10,
      threshold: LOW_THRESHOLD,
    })
    expect(emitOutbox).toHaveBeenCalledTimes(1)

    const metrics = await client.register.getSingleMetric('credits_low_events_total')
    expect(metrics?.get().values[0]?.value).toBe(1)
  })

  it('does not emit credits.low again while remaining below threshold', async () => {
    await pool.query(
      'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_alert_armed) VALUES ($1, $2, $3, false)',
      [TEST_ORG_ID, 10, 1],
    )

    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    await request(app, '/test')
    await request(app, '/test')

    const outbox = await getOutboxEvents(pool)
    expect(outbox).toHaveLength(0)
    expect(emitOutbox).not.toHaveBeenCalled()
  })

  it('emits only once across repeated deductions that stay below threshold after crossing', async () => {
    await pool.query(
      'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_alert_armed) VALUES ($1, $2, $3, true)',
      [TEST_ORG_ID, 12, 1],
    )

    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    await request(app, '/test')
    await request(app, '/test')
    await request(app, '/test')

    const outbox = await getOutboxEvents(pool)
    expect(outbox).toHaveLength(1)
    expect(outbox[0].payload.creditsRemaining).toBe(10)
  })

  it('uses per-org threshold override when configured', async () => {
    await pool.query(
      'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_threshold, low_credit_alert_armed) VALUES ($1, $2, $3, $4, true)',
      [TEST_ORG_ID, 6, 1, 5],
    )

    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    await request(app, '/test')

    const outbox = await getOutboxEvents(pool)
    expect(outbox).toHaveLength(1)
    expect(outbox[0].payload).toMatchObject({
      creditsRemaining: 5,
      threshold: 5,
    })
  })

  it('re-arms after refund lifts credits above threshold and emits again on re-crossing', async () => {
    await pool.query(
      'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_alert_armed) VALUES ($1, $2, $3, true)',
      [TEST_ORG_ID, 11, 1],
    )

    mountCostMeter()
    app.get('/error', (_req, res) => { res.status(500).json({ error: 'fail' }) })
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    await request(app, '/test')
    await request(app, '/error')
    await new Promise(resolve => setTimeout(resolve, 50))

    const armedRow = await pool.query(
      'SELECT low_credit_alert_armed FROM org_credits WHERE org_id = $1',
      [TEST_ORG_ID],
    )
    expect(armedRow.rows[0].low_credit_alert_armed).toBe(true)

    await request(app, '/test')

    const outbox = await getOutboxEvents(pool)
    expect(outbox).toHaveLength(2)
    expect(outbox.every((row) => row.event_type === 'credits.low')).toBe(true)
  })

  it('does not block deduction when outbox emission fails', async () => {
    emitOutbox = vi.fn(async () => {
      throw new Error('outbox unavailable')
    })

    await pool.query(
      'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_alert_armed) VALUES ($1, $2, $3, true)',
      [TEST_ORG_ID, 11, 1],
    )

    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    const res = await request(app, '/test')

    expect(res.status).toBe(200)
    expect(res.headers['x-credits-remaining']).toBe('10')

    const outbox = await getOutboxEvents(pool)
    expect(outbox).toHaveLength(0)
  })

  it('emits at most one credits.low event under concurrent threshold crossings', async () => {
    await pool.query(
      'INSERT INTO org_credits (org_id, credits_remaining, version, low_credit_alert_armed) VALUES ($1, $2, $3, true)',
      [TEST_ORG_ID, 15, 1],
    )

    mountCostMeter()
    app.get('/test', (_req, res) => { res.json({ ok: true }) })

    const httpServer = app.listen(0)
    const port = (httpServer.address() as AddressInfo).port
    const baseUrl = `http://127.0.0.1:${port}`

    await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${baseUrl}/test`).then((res) => res.status)),
    )

    httpServer.close()

    const outbox = await getOutboxEvents(pool)
    expect(outbox.length).toBeLessThanOrEqual(1)
  }, 10000)
})
