import { newDb } from 'pg-mem'
import { Pool } from 'pg'
import { OutboxPublisher } from './publisher'
import { OutboxRepository } from './repository'
import type { OutboxEvent } from './types'
import crypto from 'crypto'
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest'

vi.mock('../pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pool.js')>()
  const mockPool = {
    query: vi.vn().mockResolved({ rows: [] }),
    connect: vi.vn(),
    end: vi.vn(),
    on: vi.vn(),
  }
  return {
    ...actual,
    pool: mockPool as any,
  }
})

async function buildTestPool(): Promise<Pool> {
  const db = newDb()

  // Register % operator
  db.public.registerOperator({
    operator: '%',
    left: db.public.getType('integer'),
    right: db.public.getType('integer'),
    returns: db.public.getType('integer'),
    implementation: (a: number, b: number) => a % b
  })

  // Register md5 function
  db.public.registerFunction({
    name: 'md5',
    args: [db.public.getType('text')],
    returns: db.public.getType('text'),
    implementation: (str: string) => {
      if (str === null || str === undefined) return null
      return crypto.createHash('md5').update(str).digest('hex')
    }
  })

  // Register substr function
  db.public.registerFunction({
    name: 'substr',
    args: [db.public.getType('text'), db.public.getType('integer'), db.public.getType('integer')],
    returns: db.public.getType('text'),
    implementation: (str: string, start: number, length: number) => {
      if (str === null || str === undefined) return null
      return str.substring(start - 1, start - 1 + length)
    }
  })

  // Register hash_md5_id_to_int function
  db.public.registerFunction({
    name: 'hash_md5_id_to_int',
    args: [db.public.getType('integer')],
    returns: db.public.getType('integer'),
    implementation: (id: number) => {
      const hash = crypto.createHash('md5').update(String(id)).digest('hex')
      const sub = hash.substring(0, 8)
      return parseInt(sub, 16)
    }
  })

  // Intercept query and rewrite cast syntax to use the registered function
  let interceptor: any
  const subscribe = () => {
    interceptor = db.public.interceptQueries(query => {
      if (query.includes("('x'||substr(md5(id::text),1,8))::bit(32)::int")) {
        const rewritten = query.replace(
          "('x'||substr(md5(id::text),1,8))::bit(32)::int",
          "hash_md5_id_to_int(id)"
        )
        interceptor.unsubscribe()
        try {
          const res = db.public.query(rewritten)
          return res.rows
        } finally {
          subscribe()
        }
      }
      return null
    })
  }
  subscribe()

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
      tracestate TEXT,
      shard_count INTEGER,
      shard_id INTEGER,
      correlation_id TEXT,
      publish_idempotency_key TEXT
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
    correlationId: null,
    publishIdempotencyKey: null,
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

  it('treats empty payload as poison pill', () => {
    const result = detect(baseEvent({ rawPayload: '' }))
    expect(result?.reason).toBe('malformed_json')
  })

  it('accepts payload exactly at the max size boundary', () => {
    const payload = JSON.stringify({ id: 'bond-1' })
    const result = detect(baseEvent({ rawPayload: payload }), Buffer.byteLength(payload))
    expect(result).toBeNull()
  })

  it('rejects payload one byte over the max size boundary', () => {
    const payload = JSON.stringify({ id: 'bond-1' })
    const result = detect(baseEvent({ rawPayload: payload }), Buffer.byteLength(payload) - 1)
    expect(result?.reason).toBe('oversized_payload')
  })

  it('treats undefined rawPayload as not oversized', () => {
    const result = detect(baseEvent({ rawPayload: undefined }), 0)
    expect(result).toBeNull()
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

  it('rejects reinjection of an already reinjected quarantine row', async () => {
    const quarantine = await pool.query(
      `INSERT INTO outbox_quarantine (
        original_event_id, aggregate_type, aggregate_id, event_type, payload,
        reason, error_message, retry_count, max_retries, reinjected_at, reinjected_by
      )
      VALUES (11, 'bond', 'bond-1', 'bond.created', '{bad-jsony', 'malformed_json', 'bad', 0, 5, NOW(), 'operator')
      RETURNING id`
    )

    const newId = await repo.reinjectQuarantined(
      pool,
      BigInt(quarantine.rows[0].id),
      { id: 'bond-1' },
      'operator'
    )

    expect(newId).toBeNull()
  })

  it('returns null when reinjecting a non-existent quarantine row', async () => {
    const newId = await repo.reinjectQuarantined(pool, BigInt(99999), { id: 'bond-1' }, 'operator')
    expect(newId).toBeNull()
  })
})

describe('OutboxPublisher lease-aware sharding', () => {
  let pool: Pool
  let repo: OutboxRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    repo = new OutboxRepository()
  })

  afterEach(async () => {
    await pool.end()
  })

  it('validates config parameters in constructor', () => {
    const mockPub = { publish: async () => undefined }

    expect(() => new OutboxPublisher(mockPub, { shardCount: 2 })).toThrow('Both shardCount and shardId must be provided if either is set')
    expect(() => new OutboxPublisher(mockPub, { shardId: 1 })).toThrow('Both shardCount and shardId must be provided if either is set')
    expect(() => new OutboxPublisher(mockPub, { shardCount: -1, shardId: 0 })).toThrow('shardCount must be a positive integer')
    expect(() => new OutboxPublisher(mockPub, { shardCount: 2, shardId: -1 })).toThrow('shardId must be a non-negative integer less than shardCount')
    expect(() => new OutboxPublisher(mockPub, { shardCount: 2, shardId: 2 })).toThrow('shardId must be a non-negative integer less than shardCount')

    const valid = new OutboxPublisher(mockPub, { shardCount: 2, shardId: 1 })
    expect(valid).toBeDefined()
  })

  it('claims only events matching its shard using hash-modulo', async () => {
    // Insert 10 events
    for (let i = 1; i <= 10; i++) {
      await pool.query(
        `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
         VALUES ($1, 'aggregate', 'agg-1', 'bond.created', '{"val": 1}', 'pending')`,
        [i]
      )
    }

    const mockPub = { publish: async () => undefined }

    // Start publisher on shard 0 of 2
    const pub0 = new OutboxPublisher(mockPub, {
      shardCount: 2,
      shardId: 0,
      batchSize: 10,
    })

    // Start publisher on shard 1 of 2
    const pub1 = new OutboxPublisher(mockPub, {
      shardCount: 2,
      shardId: 1,
      batchSize: 10,
    })

    const events0 = await (repo as any).claimEvents(pool, 'consumer-0', 10, 60, 2, 0)
    const events1 = await (repo as any).claimEvents(pool, 'consumer-1', 10, 60, 2, 1)

    expect(events0.length + events1.length).toBe(10)
    expect(events0.length).toBeGreaterThan(0)
    expect(events1.length).toBeGreaterThan(0)

    // Ensure all claimed events have the correct assigned shard fields in db
    const rows = await pool.query('SELECT id, shard_count, shard_id, consumer_id FROM event_outbox')
    for (const r of rows.rows) {
      if (r.consumer_id === 'consumer-0') {
        expect(r.shard_count).toBe(2)
        expect(r.shard_id).toBe(0)
      } else {
        expect(r.shard_count).toBe(2)
        expect(r.shard_id).toBe(1)
      }
    }
  })

  it('supports dynamic shard count changes', async () => {
    // Insert 10 events
    for (let i = 1; i <= 10; i++) {
      await pool.query(
        `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
         VALUES ($1, 'aggregate', 'agg-1', 'bond.created', '{"val": 1}', 'pending')`,
         [i]
      )
    }

    // Claim on a 2-shard config first
    const eventsShard0of2 = await repo.claimEvents(pool, 'c-0-2', 10, 60, 2, 0)
    const eventsShard1of2 = await repo.claimEvents(pool, 'c-1-2', 10, 60, 2, 1)

    expect(eventsShard0of2.length + eventsShard1of2.length).toBe(10)

    // Reset claims back to pending
    await pool.query(`UPDATE event_outbox SET status = 'pending', consumer_id = NULL, lease_expires_at = NULL WHERE status = 'processing'`)

    // Claim on a 3-shard config
    const e0 = await repo.claimEvents(pool, 'c-0-3', 10, 60, 3, 0)
    const e1 = await repo.claimEvents(pool, 'c-1-3', 10, 60, 3, 1)
    const e2 = await repo.claimEvents(pool, 'c-2-3', 10, 60, 3, 2)

    expect(e0.length + e1.length + e2.length).toBe(10)
  })

  it('releases claims when stopped so other consumers can pick them up', async () => {
    await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status)
       VALUES ('bond', 'bond-1', 'bond.created', '{"id":"bond-1"}', 'pending')`
    )

    const events = await repo.claimEvents(pool, 'consumer-1', 10, 60)
    expect(events.length).toBe(1)

    await repo.releaseClaims(pool, 'consumer-1')

    const row = await pool.query('SELECT status, consumer_id, consumer_id FROM event_outbox WHERE id = $1', [events[0].id.toString()])
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].consumer_id).toBeNull()
  })

  it('renews leases for claimed events', async () => {
    await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status)
       VALUES ('bond', 'bond-1', 'bond.created', '{"id":"bond-1"}', 'pending')`
    )

    const events = await repo.claimEvents(pool, 'consumer-1', 10, 60)
    expect(events.length).toBe(1)

    const renewed = await repo.renewLease(pool, 'consumer-1', 60)
    expect(renewed).toBe(1)
  })

  it('returns 0 when renewing leases for a consumer with no claims', async () => {
    const renewed = await repo.renewLease(pool, 'no-such-consumer', 60)
    expect(renewed).toBe(0)
  })
})

describe('OutboxPublisher publish idempotency', () => {
  let pool: Pool
  let repo: OutboxRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    repo = new OutboxRepository()
  })

  afterEach(async () => {
    await pool.end()
  })

  it('trySetPublishIdempotencyKey returns true on first call and false on duplicate', async () => {
    const insert = await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, consumer_id)
       VALUES ('bond', 'bond-1', 'bond.created', '{"id":"bond-1"}', 'processing', 'consumer-1')
       RETURNING id`
    )
    const id = BigInt(insert.rows[0].id)

    const first = await repo.trySetPublishIdempotencyKey(pool, id, 'k-1', 'consumer-1')
    expect(first).toBe(true)

    const second = await repo.trySetPublishIdempotencyKey(pool, id, 'k-2', 'consumer-2')
    expect(second).toBe(false)

    const row = await pool.query('SELECT publish_idempotency_key FROM event_outbox WHERE id = $1', [id.toString()])
    expect(row.rows[0].publish_idempotency_key).toBe('k-1')
  })

  it('trySetPublishIdempotencyKey returns false for a non-existent event', async () => {
    const result = await repo.trySetPublishIdempotencyKey(pool, BigInt(99999), 'k-1', 'consumer-1')
    expect(result).toBe(false)
  })

  it('skips publish when an event already has a publish idempotency key', async () => {
    const insert = await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, consumer_id, publish_idempotency_key)
       VALUES ('bond', 'bond-1', 'bond.created', '{"id":"bond-1"}', 'processing', 'consumer-1', 'existing-key')
       RETURNING id`
    )
    const id = BigInt(insert.rows[0].id)

    const publish = vi.vn().mockResolved(undefined)
    const publisher = new OutboxPublisher({ publish })

    const event = baseEvent({ id, publishIdempotencyKey: 'existing-key' })
    await (publisher as any).processEvent(event)

    expect(publish).not.toHaveBeenCalled()

    const row = await pool.query('SELECT status FROM event_outbox WHERE id = $1', [id.toString()])
    expect(row.rows[0].status).toBe('published')
  })

  it('skips publish when the idempotency key was already acquired by another consumer', async () => {
    const insert = await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, consumer_id, publish_idempotency_key)
       VALUES ('bond', 'bond-1', 'bond.created', '{"id":"bond-1"}', 'processing', 'consumer-1', 'k-1')
       RETURNING id`
    )
    const id = BigInt(insert.rows[0].id)

    const publish = vi.vn().mockResolved(undefined)
    const publisher = new OutboxPublisher({ publish }, { consumerId: 'consumer-2' })

    // Event has no publishIdempotencyKey on the object, but the database row already has one.
    const event = baseEvent({ id, publishIdempotencyKey: null })
    await (publisher as any).processEvent(event)

    expect(publish).not.toHaveBeenCalled()
  })
})

describe('OutboxPublisher retry and dead-letter behavior', () => {
  let pool: Pool
  let repo: OutboxRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    repo = new OutboxRepository()
  })

  afterEach(async () => {
    await pool.end()
  })

  it('marks an event as failed and increments retry count on publish failure', async () => {
    const insert = await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, consumer_id, retry_count, max_retries)
       VALUES ('bond', 'bond-1', 'bond.created', '{"id":"bond-1"}', 'processing', 'consumer-1', 0, 5)
       RETURNING id`
    )
    const id = BigInt(insert.rows[0].id)

    const publish = vi.vn().mockRejected(new Error('boom'))
    const publisher = new OutboxPublisher({ publish })

    const event = baseEvent({ id, retryCount: 0, maxRetries: 5 })
    await (publisher as any).processEvent(event)

    const row = await pool.query('SELECT status, retry_count, error_message FROM event_outbox WHERE id = $1', [id.toString()])
    expect(row.rows[0].status).toBe('failed')
    expect(Number(row.rows[0].retry_count)).toBe(1)
    expect(row.rows[0].error_message).toContain('boom')
  })

  it('moves an event to dead letter after exhausting retries', async () => {
    const insert = await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, consumer_id, retry_count, max_retries)
       VALUES ('bond', 'bond-1', 'bond.created', '{"id":"bond-1"}', 'processing', 'consumer-1', 5, 5)
       RETURNING id`
    )
    const id = BigInt(insert.rows[0].id)

    const publish = vi.vn().mockRejected(new Error('boom'))
    const publisher = new OutboxPublisher({ publish })

    const event = baseEvent({ id, retryCount: 5, maxRetries: 5 })
    await (publisher as any).processEvent(event)

    const row = await pool.query('SELECT status, retry_count FROM event_outbox WHERE id = $1', [id.toString()])
    expect(row.rows[0].status).toBe('dead_letter')
    expect(Number(row.rows[0].retry_count)).toBe(5)
  })

  it('marks an event as published on successful publish', async () => {
    const insert = await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, consumer_id)
       VALUES ('bond', 'bond-1', 'bond.created', '{"id":"bond-1"}', 'processing', 'consumer-1')
       RETURNING id`
    )
    const id = BigInt(insert.rows[0].id)

    const publish = vi.vn().mockResolved(undefined)
    const publisher = new OutboxPublisher({ publish })

    const event = baseEvent({ id })
    await (publisher as any).processEvent(event)

    expect(publish).toHaveBeenCalled(1)

    const row = await pool.query('SELECT status, retry_count FROM event_outbox WHERE id = $1', [id.toString()])
    expect(row.rows[0].status).toBe('published')
    expect(Number(row.rows[0].retry_count)).toBe(0)
  })

  it('quarantines a poison-pill event without invoking the publisher', async () => {
    const insert = await pool.query(
      `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, consumer_id)
       VALUES ('bond', 'bond-1', 'bond.created', '{bad-json', 'processing', 'consumer-1')
       RETURNING id`
    )
    const id = BigInt(insert.rows[0].id)

    const publish = vi.vn().mockResolved(undefined)
    const publisher = new OutboxPublisher({ publish })

    const event = baseEvent({ id, rawPayload: '{bad-json', payloadParseError: 'Unexpected token' })
    await (publisher as any).processEvent(event)

    expect(publish).not.toHaveBeenCalled()

    const outbox = await pool.query('SELECT COUNT(*)::int AS count FROM event_outbox')
    const quarantine = await pool.query('SELECT reason FROM outbox_quarantine')
    expect(outbox.rows[0].count).toBe(0)
    expect(quarantine.rows[0].reason).toBe('malformed_json')
  })
})

describe('OutboxPublisher lifecycle guards', () => {
  it('start is idempotent and stop clears timers', async () => {
    const pool = await buildTestPool()
    try {
      const publish = vi.vn().mockResolved(undefined)
      const publisher = new OutboxPublisher({ publish }, {
        pollIntervalMs: 100000,
        cleanupIntervalMs: 100000,
        metricsIntervalMs: 100000,
        heartbeatIntervalMs: 100000,
      })

      await publisher.start()
      await publisher.start()
      expect((publisher as any).running).toBe(true)

      await publisher.stop()
      expect((publisher as any).running).toBe(false)
      expect((publisher as any).pollTimer).toBeNull()
      expect((publisher as any).cleanupTimer).toBeNull()
      expect((publisher as any).heartbeatTimer).toBeNull()
      expect((publisher as any).metricsTimer).toBeNull()

      // Stop again is a no-op
      await publisher.stop()
    } finally {
      await pool.end()
    }
  })

  it('processBatch is a no-op when not running', async () => {
    const publish = vi.vn().mockResolved(undefined)
    const publisher = new OutboxPublisher({ publish })
    await (publisher as any).processBatch()
    expect(publish).not.toHaveBeenCalled()
  })

  it('renewLease is a no-op when not running', async () => {
    const publish = vi.vn().mockResolved(undefined)
    const publisher = new OutboxPublisher({ publish })
    await (publisher as any).renewLease()
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('OutboxPublisher grouping and ordering', () => {
  it('groups events by aggregate key', () => {
    const publisher = new OutboxPublisher({ publish: async () => undefined })
    const groups = (publisher as any).groupByAggregate([
      baseEvent({ id: 1n, aggregateType: 'bond', aggregateId: 'a' }),
      baseEvent({ id: 2n, aggregateType: 'bond', aggregateId: 'a' }),
      baseEvent({ id: 3n, aggregateType: 'bond', aggregateId: 'b' }),
    ])

    expect(groups.size).toBe(2)
    expect(groups.get('bond:a')?.length).toBe(2)
    expect(groups.get('bond:b')?.length).toBe(1)
  })

  it('processes events for an aggregate sequentially in order', async () => {
    const order: number[] = []
    const publish = vi.vn().mockImplementation(async (event: OutboxEvent) => {
      order.push(Number(event.id))
    })
    const publisher = new OutboxPublisher({ publish })

    // Bypass the DB layer by stubbing the repository methods used by processEvent.
    const repo = (publisher as any).repository
    repo.trySetPublishIdempotencyKey = vi.fn().mockResolved(true)
    repo.markPublished = vi.fn().mockResolved(undefined)

    await (publisher as any).processAggregateEvents('bond:a', [
      baseEvent({ id: 1n }),
      baseEvent({ id: 2n }),
      baseEvent({ id: 3n }),
    ])

    expect(order).toEqual([1, 2, 3])
  })
})
