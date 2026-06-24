import { newDb } from 'pg-mem'
import { Pool } from 'pg'
import { OutboxPublisher } from './publisher'
import { OutboxRepository } from './repository'
import type { OutboxEvent } from './types'

async function buildTestPool(): Promise<Pool> {
  const db = newDb()
  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  await pool.query(`
    CREATE TABLE event_outbox (
      id BIGSERIAL PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 5,
      consumer_id TEXT,
      lease_expires_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      error_message TEXT,
      trace_id TEXT,
      span_id TEXT,
      tracestate TEXT
    )
  `)

  await pool.query(`
    CREATE TABLE outbox_quarantine (
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

  return pool
}

function baseEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 1n,
    aggregateType: 'bond',
    aggregateId: 'bond-1',
    eventType: 'bond.created',
    payload: { id: 'bond-1' },
    rawPayload: JSON.stringify({ id: 'bond-1' }),
    status: 'processing',
    retryCount: 0,
    maxRetries: 5,
    consumerId: 'consumer',
    leaseExpiresAt: new Date(),
    createdAt: new Date(),
    processedAt: null,
    errorMessage: null,
    traceId: null,
    spanId: null,
    tracestate: null,
    ...overrides,
  }
}

function detect(event: OutboxEvent, maxPayloadBytes = 1024) {
  const publisher = new OutboxPublisher(
    { publish: async () => undefined },
    { maxPayloadBytes }
  )
  return (publisher as any).detectPoisonPill(event)
}

describe('OutboxPublisher poison-pill detection', () => {
  it('detects malformed JSON before publish attempts', () => {
    const result = detect(baseEvent({ payloadParseError: 'Unexpected token' }))
    expect(result).toEqual({ reason: 'malformed_json', message: 'Unexpected token' })
  })

  it('detects oversized payloads before retrying', () => {
    const result = detect(
      baseEvent({
        rawPayload: JSON.stringify({ body: 'x'.repeat(64) }),
      }),
      16
    )

    expect(result?.reason).toBe('oversized_payload')
  })

  it('detects unknown event types as poison pills', () => {
    const result = detect(baseEvent({ eventType: 'not.registered' }))
    expect(result?.reason).toBe('unknown_event_type')
  })

  it('detects schema-invalid queue payloads', () => {
    const result = detect(
      baseEvent({
        eventType: 'bond.creation',
        payload: { type: 'create_bond', amount: -1 },
        rawPayload: JSON.stringify({ type: 'create_bond', amount: -1 }),
      })
    )

    expect(result?.reason).toBe('schema_invalid')
    expect(result?.message).toContain('id')
  })

  it('allows structurally valid known webhook events', () => {
    expect(detect(baseEvent())).toBeNull()
  })
})

describe('OutboxRepository quarantine handling', () => {
  let pool: Pool
  let repo: OutboxRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    repo = new OutboxRepository()
  })

  afterEach(async () => {
    await pool.end()
  })

  it('moves malformed rows to quarantine without incrementing retry_count', async () => {
    const insert = await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, retry_count, max_retries)
       VALUES ($1, $2, $3, $4, 'pending', 0, 5)
       RETURNING id`,
      ['bond', 'bond-1', 'bond.created', '{bad-json']
    )

    const [event] = await repo.claimEvents(pool, 'consumer-1', 10, 60)
    expect(event.id).toBe(BigInt(insert.rows[0].id))
    expect(event.payloadParseError).toBeTruthy()

    await repo.quarantine(pool, event, 'malformed_json', event.payloadParseError!)

    const outbox = await pool.query('SELECT COUNT(*)::int AS count FROM event_outbox')
    const quarantine = await pool.query('SELECT reason, retry_count, payload FROM outbox_quarantine')

    expect(outbox.rows[0].count).toBe(0)
    expect(quarantine.rows[0].reason).toBe('malformed_json')
    expect(Number(quarantine.rows[0].retry_count)).toBe(0)
    expect(quarantine.rows[0].payload).toBe('{bad-json')
  })

  it('reinserts a fixed quarantined event and marks the quarantine row', async () => {
    const quarantine = await pool.query(
      `INSERT INTO outbox_quarantine (
        original_event_id, aggregate_type, aggregate_id, event_type, payload,
        reason, error_message, retry_count, max_retries
      )
      VALUES (10, 'bond', 'bond-1', 'bond.created', '{bad-json', 'malformed_json', 'bad', 0, 5)
      RETURNING id`
    )

    const newId = await repo.reinjectQuarantined(
      pool,
      BigInt(quarantine.rows[0].id),
      { id: 'bond-1' },
      'operator'
    )

    expect(newId).not.toBeNull()

    const outbox = await pool.query('SELECT payload, status, retry_count FROM event_outbox WHERE id = $1', [
      newId!.toString(),
    ])
    const marked = await pool.query('SELECT reinjected_by, reinjected_at FROM outbox_quarantine WHERE id = $1', [
      quarantine.rows[0].id,
    ])

    expect(JSON.parse(outbox.rows[0].payload)).toEqual({ id: 'bond-1' })
    expect(outbox.rows[0].status).toBe('pending')
    expect(Number(outbox.rows[0].retry_count)).toBe(0)
    expect(marked.rows[0].reinjected_by).toBe('operator')
    expect(marked.rows[0].reinjected_at).not.toBeNull()
  })
})
