import { newDb } from 'pg-mem'
import { Pool } from 'pg'
import { OutboxPublisher } from './publisher'
import { OutboxRepository } from './repository'
import type { OutboxEvent } from './types'
import crypto from 'crypto'

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
    const eventsShard0Of2 = await repo.claimEvents(pool, 'c-0-2', 10, 60, 2, 0)
    const eventsShard1Of2 = await repo.claimEvents(pool, 'c-1-2', 10, 60, 2, 1)

    expect(eventsShard0Of2.length + eventsShard1Of2.length).toBe(10)

    // Reset claims back to pending
    await pool.query("UPDATE event_outbox SET status = 'pending', consumer_id = NULL, lease_expires_at = NULL")

    // Now claim using a 3-shard config
    const eventsShard0Of3 = await repo.claimEvents(pool, 'c-0-3', 10, 60, 3, 0)
    const eventsShard1Of3 = await repo.claimEvents(pool, 'c-1-3', 10, 60, 3, 1)
    const eventsShard2Of3 = await repo.claimEvents(pool, 'c-2-3', 10, 60, 3, 2)

    expect(eventsShard0Of3.length + eventsShard1Of3.length + eventsShard2Of3.length).toBe(10)

    // Ensure different membership
    const ids2_0 = eventsShard0Of2.map(e => e.id)
    const ids3_0 = eventsShard0Of3.map(e => e.id)
    expect(ids2_0.sort()).not.toEqual(ids3_0.sort())
  })

  it('handles publisher death by reclaiming expired leases', async () => {
    await pool.query(
      `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
       VALUES (1, 'aggregate', 'agg-1', 'bond.created', '{"val": 1}', 'pending')`
    )

    // Claim by consumer A (active lease)
    const [eventA] = await repo.claimEvents(pool, 'consumer-a', 10, 60, 2, 0)
    expect(eventA).toBeDefined()

    // Try to claim by consumer B (same shard, active lease) - should get 0 events
    const eventsBActive = await repo.claimEvents(pool, 'consumer-b', 10, 60, 2, 0)
    expect(eventsBActive.length).toBe(0)

    // Expire the lease manually
    await pool.query("UPDATE event_outbox SET lease_expires_at = NOW() - INTERVAL '1 second'")

    // Try to claim by consumer B again (same shard, expired lease) - should reclaim
    const [eventBReclaimed] = await repo.claimEvents(pool, 'consumer-b', 10, 60, 2, 0)
    expect(eventBReclaimed).toBeDefined()
    expect(eventBReclaimed.id).toBe(eventA.id)
    expect(eventBReclaimed.consumerId).toBe('consumer-b')
  })

  it('prevents hot shards by adequately distributing sequential IDs via md5 hashing', () => {
    const N = 4
    const shardCounts = new Array(N).fill(0)
    const totalEvents = 1000

    for (let id = 1; id <= totalEvents; id++) {
      const hash = crypto.createHash('md5').update(String(id)).digest('hex')
      const val = parseInt(hash.substring(0, 8), 16)
      const shard = val % N
      shardCounts[shard]++
    }

    const expectedMean = totalEvents / N
    const maxAllowedDeviation = expectedMean * 0.15 // 15% tolerance

    for (let s = 0; s < N; s++) {
      const deviation = Math.abs(shardCounts[s] - expectedMean)
      expect(deviation).toBeLessThan(maxAllowedDeviation)
    }
  })
})

describe('OutboxRepository publish idempotency (crash recovery)', () => {
  let pool: Pool
  let repo: OutboxRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    repo = new OutboxRepository()
  })

  afterEach(async () => {
    await pool.end()
  })

  it('trySetPublishIdempotencyKey returns true on first call and false on second', async () => {
    await pool.query(
      `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
       VALUES (1, 'bond', 'bond-1', 'bond.created', '{"val": 1}', 'pending')`
    )
    const [event] = await repo.claimEvents(pool, 'consumer-a', 10, 60)

    // First call succeeds
    const first = await repo.trySetPublishIdempotencyKey(pool, event.id, 'consumer-a:1')
    expect(first).toBe(true)

    // Second call (different consumer) fails
    const second = await repo.trySetPublishIdempotencyKey(pool, event.id, 'consumer-b:1')
    expect(second).toBe(false)

    // Verify key is set in DB
    const row = await pool.query('SELECT publish_idempotency_key FROM event_outbox WHERE id = $1', [event.id.toString()])
    expect(row.rows[0].publish_idempotency_key).toBe('consumer-a:1')
  })

  it('markPublished clears the publish idempotency key', async () => {
    await pool.query(
      `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
       VALUES (1, 'bond', 'bond-1', 'bond.created', '{"val": 1}', 'pending')`
    )
    const [event] = await repo.claimEvents(pool, 'consumer-1', 10, 60)

    // Set the key (simulating pre-publish state)
    await repo.trySetPublishIdempotencyKey(pool, event.id, 'consumer-1:1')

    // markPublished should clear the key
    await repo.markPublished(pool, event.id)

    const row = await pool.query('SELECT status, publish_idempotency_key FROM event_outbox WHERE id = $1', [event.id.toString()])
    expect(row.rows[0].status).toBe('published')
    expect(row.rows[0].publish_idempotency_key).toBeNull()
  })

  it('markFailed clears publish idempotency key so retry can publish again', async () => {
    await pool.query(
      `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
       VALUES (1, 'bond', 'bond-1', 'bond.created', '{"val": 1}', 'pending')`
    )
    const [event] = await repo.claimEvents(pool, 'consumer-1', 10, 60)

    // Set the key (simulating pre-publish state)
    await repo.trySetPublishIdempotencyKey(pool, event.id, 'consumer-1:1')

    // markFailed should clear the key and reset to pending
    const result = await repo.markFailed(pool, event.id, 'network error')
    expect(result.status).toBe('pending')

    const row = await pool.query('SELECT status, publish_idempotency_key, retry_count FROM event_outbox WHERE id = $1', [event.id.toString()])
    expect(row.rows[0].publish_idempotency_key).toBeNull()
    expect(row.rows[0].status).toBe('pending')
  })

  it('releaseClaims clears publish idempotency key on graceful shutdown', async () => {
    await pool.query(
      `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
       VALUES (1, 'bond', 'bond-1', 'bond.created', '{"val": 1}', 'pending')`
    )
    const [event] = await repo.claimEvents(pool, 'consumer-1', 10, 60)

    // Set the key (simulating pre-publish state)
    await repo.trySetPublishIdempotencyKey(pool, event.id, 'consumer-1:1')

    // releaseClaims should clear the key and reset status
    const released = await repo.releaseClaims(pool, 'consumer-1')
    expect(released).toBe(1)

    const row = await pool.query('SELECT status, publish_idempotency_key, consumer_id FROM event_outbox WHERE id = $1', [event.id.toString()])
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].publish_idempotency_key).toBeNull()
    expect(row.rows[0].consumer_id).toBeNull()
  })

  it('clearPublishIdempotencyKey removes the key', async () => {
    await pool.query(
      `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
       VALUES (1, 'bond', 'bond-1', 'bond.created', '{"val": 1}', 'pending')`
    )
    const [event] = await repo.claimEvents(pool, 'consumer-1', 10, 60)

    await repo.trySetPublishIdempotencyKey(pool, event.id, 'consumer-1:1')
    await repo.clearPublishIdempotencyKey(pool, event.id)

    const row = await pool.query('SELECT publish_idempotency_key FROM event_outbox WHERE id = $1', [event.id.toString()])
    expect(row.rows[0].publish_idempotency_key).toBeNull()
  })

  it('reclaimed event with idempotency key is mapped correctly to OutboxEvent', async () => {
    // This test verifies that when an event is reclaimed, its
    // publishIdempotencyKey is surfaced so the publisher can skip publish.
    await pool.query(
      `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
       VALUES (1, 'bond', 'bond-1', 'bond.created', '{"val": 1}', 'pending')`
    )

    // Claim and set key (simulating consumer A's pre-publish state)
    const [eventA] = await repo.claimEvents(pool, 'consumer-a', 10, 60)
    await repo.trySetPublishIdempotencyKey(pool, eventA.id, 'consumer-a:1')

    // Simulate consumer A crash: expire lease
    await pool.query("UPDATE event_outbox SET lease_expires_at = NOW() - INTERVAL '1 second'")

    // Consumer B reclaims
    const [eventB] = await repo.claimEvents(pool, 'consumer-b', 10, 60)
    expect(eventB).toBeDefined()
    expect(eventB.id).toBe(eventA.id)
    // Consumer B should see the idempotency key and skip publish
    expect(eventB.publishIdempotencyKey).toBe('consumer-a:1')
  })

  it('concurrent trySetPublishIdempotencyKey prevents duplicate emissions', async () => {
    // Simulate two consumers racing to publish the same event.
    // Only one should acquire the idempotency key.
    await pool.query(
      `INSERT INTO event_outbox (id, aggregate_type, aggregate_id, event_type, payload, status)
       VALUES (1, 'bond', 'bond-1', 'bond.created', '{"val": 1}', 'pending')`
    )
    const [event] = await repo.claimEvents(pool, 'consumer-a', 10, 60)

    // Consumer A acquires the key
    const aAcquired = await repo.trySetPublishIdempotencyKey(pool, event.id, 'consumer-a:1')
    expect(aAcquired).toBe(true)

    // Consumer B tries — fails
    const bAcquired = await repo.trySetPublishIdempotencyKey(pool, event.id, 'consumer-b:1')
    expect(bAcquired).toBe(false)

    // Only consumer A would call publish()
    // After publish, markPublished clears the key
    await repo.markPublished(pool, event.id)

    const row = await pool.query('SELECT status, publish_idempotency_key FROM event_outbox WHERE id = $1', [event.id.toString()])
    expect(row.rows[0].status).toBe('published')
    expect(row.rows[0].publish_idempotency_key).toBeNull()
  })
})

describe('OutboxRepository correlation id persistence', () => {
  it('persists correlation_id on create and returns it via claimEvents', async () => {
    const pool = await buildTestPool()
    const repo = new OutboxRepository()

    await repo.create(pool, {
      aggregateType: 'bond',
      aggregateId: 'bond-1',
      eventType: 'bond.created',
      payload: { address: '0xabc' },
      correlationId: 'corr-persisted-123',
    })

    const [claimed] = await repo.claimEvents(pool, 'consumer-a', 10, 60)
    expect(claimed.correlationId).toBe('corr-persisted-123')
  })

  it('leaves correlation_id null when the event was emitted with no active request context', async () => {
    const pool = await buildTestPool()
    const repo = new OutboxRepository()

    await repo.create(pool, {
      aggregateType: 'bond',
      aggregateId: 'bond-2',
      eventType: 'bond.created',
      payload: { address: '0xdef' },
    })

    const [claimed] = await repo.claimEvents(pool, 'consumer-a', 10, 60)
    expect(claimed.correlationId).toBeFalsy()
  })
})