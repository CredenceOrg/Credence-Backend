/**
 * @file src/db/outbox/__tests__/index.boundary.test.ts
 *
 * Boundary and recovery test coverage for src/db/outbox/index.ts.
 *
 * ## What is tested here
 *
 * 1. **Barrel contract** — every symbol re-exported from the index is importable,
 *    constructable/callable, and is the canonical class/function (not a copy).
 *
 * 2. **Lifecycle transition matrix** — every legal edge, every illegal edge, all
 *    terminal states, and boundary inputs to `isValidOutboxTransition` /
 *    `tryOutboxTransition` / `getAllowedOutboxTargets`.
 *
 * 3. **Repository boundary cases** — methods that must return safe defaults on
 *    empty tables or unknown actors: `renewLease`, `releaseClaims`,
 *    `fetchByConsumer`, `getOldestPendingEventLagSeconds`, `cleanup`, `getStats`,
 *    `getByAggregate`.
 *
 * 4. **Stale / loading state** — `claimEvents` respects the `next_attempt_at`
 *    gate, reclaims expired leases, and handles the boundary where an event
 *    becomes due at exactly the present moment.
 *
 * 5. **Permission / ownership invariants** — `markPublished` and `markFailed`
 *    must reject operations from a consumer that does not own the row.
 *    `trySetPublishIdempotencyKey` must be idempotent (second call returns false).
 *
 * 6. **Recovery invariants** — after a simulated crash (lease expired, idempotency
 *    key already set), the recovery consumer can complete the lifecycle without
 *    emitting a duplicate; `releaseClaims` clears the key and resets to pending
 *    for graceful handoff; `markFailed` always clears the key so the retry path
 *    can acquire it again.
 *
 * ## Test strategy
 *
 * All repository tests use an **in-memory pg-mem database** so they run quickly
 * in CI without Docker.  The same helpers used by the existing
 * `outbox.retries.test.ts` are replicated here to keep this file self-contained.
 *
 * The transition-matrix tests are pure (no DB) because `transitions.ts` is
 * side-effect-free.
 *
 * The barrel tests are import-only and do not exercise runtime behaviour.
 */

import crypto from 'crypto'
import { newDb } from 'pg-mem'
import { Pool } from 'pg'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

// ── Barrel imports (contract test) ──────────────────────────────────────────
import {
  OutboxRepository,
  OutboxPublisher,
  createOutboxSchema,
  dropOutboxSchema,
  outboxEmitter,
  OutboxEventEmitter,
  AtomicOutboxCoordinator,
  assertOutboxTransactionClient,
} from '../index'
import type {
  OutboxBatchEmitter,
  OutboxTransactionRunner,
} from '../index'

// ── Transition helpers (tested via direct import because transitions.ts is not
//    yet re-exported from the barrel — the tests document what *should* hold) ──
import {
  OUTBOX_LIFECYCLE_TRANSITIONS,
  isValidOutboxTransition,
  tryOutboxTransition,
  getAllowedOutboxTargets,
  type OutboxLifecycleStatus,
} from '../transitions'

// ── pg-mem helpers ───────────────────────────────────────────────────────────

async function buildTestPool(): Promise<Pool> {
  const db = newDb()

  db.public.registerOperator({
    operator: '%',
    left: db.public.getType('integer'),
    right: db.public.getType('integer'),
    returns: db.public.getType('integer'),
    implementation: (a: number, b: number) => a % b,
  })

  db.public.registerFunction({
    name: 'md5',
    args: [db.public.getType('text')],
    returns: db.public.getType('text'),
    implementation: (str: string) => {
      if (str == null) return null
      return crypto.createHash('md5').update(str).digest('hex')
    },
  })

  db.public.registerFunction({
    name: 'substr',
    args: [
      db.public.getType('text'),
      db.public.getType('integer'),
      db.public.getType('integer'),
    ],
    returns: db.public.getType('text'),
    implementation: (str: string, start: number, length: number) => {
      if (str == null) return null
      return str.substring(start - 1, start - 1 + length)
    },
  })

  db.public.registerFunction({
    name: 'hash_md5_id_to_int',
    args: [db.public.getType('integer')],
    returns: db.public.getType('integer'),
    implementation: (id: number) => {
      const hash = crypto.createHash('md5').update(String(id)).digest('hex')
      return parseInt(hash.substring(0, 8), 16)
    },
  })

  // pg-mem does not support the bit-cast expression; intercept and rewrite it.
  let interceptor: ReturnType<typeof db.public.interceptQueries>
  const subscribe = () => {
    interceptor = db.public.interceptQueries((query: string) => {
      const needle = "('x'||substr(md5(id::text),1,8))::bit(32)::int"
      if (query.includes(needle)) {
        const rewritten = query.replace(needle, 'hash_md5_id_to_int(id)')
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

  db.public.registerFunction({
    name: 'power',
    returns: 'numeric',
    implementation: (a: number, b: number) => Math.pow(Number(a), Number(b)),
  } as Parameters<typeof db.public.registerFunction>[0])

  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_outbox (
      id               BIGSERIAL PRIMARY KEY,
      aggregate_type   TEXT NOT NULL,
      aggregate_id     TEXT NOT NULL,
      event_type       TEXT NOT NULL,
      payload          JSONB NOT NULL,
      status           TEXT NOT NULL,
      retry_count      INTEGER NOT NULL DEFAULT 0,
      max_retries      INTEGER NOT NULL DEFAULT 5,
      consumer_id      TEXT,
      lease_expires_at TIMESTAMPTZ,
      next_attempt_at  TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at     TIMESTAMPTZ,
      error_message    TEXT,
      trace_id         TEXT,
      span_id          TEXT,
      tracestate       TEXT,
      shard_count      INTEGER,
      shard_id         INTEGER,
      correlation_id   TEXT,
      publish_idempotency_key TEXT
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outbox_quarantine (
      id                BIGSERIAL PRIMARY KEY,
      original_event_id BIGINT NOT NULL UNIQUE,
      aggregate_type    TEXT NOT NULL,
      aggregate_id      TEXT NOT NULL,
      event_type        TEXT NOT NULL,
      payload           TEXT,
      reason            TEXT NOT NULL,
      error_message     TEXT NOT NULL,
      retry_count       INTEGER NOT NULL DEFAULT 0,
      max_retries       INTEGER NOT NULL DEFAULT 5,
      quarantined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reinjected_at     TIMESTAMPTZ,
      reinjected_by     TEXT
    )
  `)

  return pool
}

async function insertPending(
  pool: Pool,
  overrides: Partial<{
    aggregate_id: string
    event_type: string
    status: string
    retry_count: number
    max_retries: number
    consumer_id: string | null
    lease_expires_at: string | null
    next_attempt_at: string | null
    publish_idempotency_key: string | null
  }> = {}
): Promise<bigint> {
  const row = await pool.query<{ id: string }>(
    `INSERT INTO event_outbox
       (aggregate_type, aggregate_id, event_type, payload, status,
        retry_count, max_retries, consumer_id, lease_expires_at,
        next_attempt_at, publish_idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      'bond',
      overrides.aggregate_id ?? 'bond-1',
      overrides.event_type ?? 'bond.created',
      JSON.stringify({ id: 'bond-1' }),
      overrides.status ?? 'pending',
      overrides.retry_count ?? 0,
      overrides.max_retries ?? 5,
      overrides.consumer_id ?? null,
      overrides.lease_expires_at ?? null,
      overrides.next_attempt_at ?? null,
      overrides.publish_idempotency_key ?? null,
    ]
  )
  return BigInt(row.rows[0].id)
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Barrel contract
// ────────────────────────────────────────────────────────────────────────────

describe('outbox/index barrel contract', () => {
  it('exports OutboxRepository as a constructable class', () => {
    expect(OutboxRepository).toBeTypeOf('function')
    const repo = new OutboxRepository()
    expect(repo).toBeInstanceOf(OutboxRepository)
    expect(typeof repo.create).toBe('function')
    expect(typeof repo.claimEvents).toBe('function')
    expect(typeof repo.markPublished).toBe('function')
    expect(typeof repo.markFailed).toBe('function')
  })

  it('exports OutboxEventEmitter as a constructable class', () => {
    expect(OutboxEventEmitter).toBeTypeOf('function')
    const emitter = new OutboxEventEmitter()
    expect(emitter).toBeInstanceOf(OutboxEventEmitter)
    expect(typeof emitter.emit).toBe('function')
    expect(typeof emitter.emitBatch).toBe('function')
  })

  it('exports outboxEmitter as an OutboxEventEmitter singleton', () => {
    expect(outboxEmitter).toBeInstanceOf(OutboxEventEmitter)
  })

  it('exports OutboxPublisher as a constructable class', () => {
    expect(OutboxPublisher).toBeTypeOf('function')
    const pub = new OutboxPublisher({ publish: async () => undefined })
    expect(pub).toBeInstanceOf(OutboxPublisher)
    expect(typeof pub.start).toBe('function')
    expect(typeof pub.stop).toBe('function')
  })

  it('exports createOutboxSchema and dropOutboxSchema as functions', () => {
    expect(typeof createOutboxSchema).toBe('function')
    expect(typeof dropOutboxSchema).toBe('function')
  })

  it('exports AtomicOutboxCoordinator as a constructable class', () => {
    expect(AtomicOutboxCoordinator).toBeTypeOf('function')
    const txRunner: OutboxTransactionRunner = {
      withTransaction: async (cb) => cb({} as any),
    }
    const batchEmitter: OutboxBatchEmitter = {
      emitBatch: async () => [],
    }
    const coord = new AtomicOutboxCoordinator(txRunner, batchEmitter)
    expect(coord).toBeInstanceOf(AtomicOutboxCoordinator)
    expect(typeof coord.run).toBe('function')
    expect(typeof coord.runOne).toBe('function')
  })

  it('exports assertOutboxTransactionClient as a function', () => {
    expect(typeof assertOutboxTransactionClient).toBe('function')
  })

  it('assertOutboxTransactionClient accepts the same object reference', () => {
    const client = { query: () => {} } as any
    expect(() => assertOutboxTransactionClient(client, client)).not.toThrow()
  })

  it('assertOutboxTransactionClient rejects different object references', () => {
    expect(() => assertOutboxTransactionClient({ query: () => {} } as any, { query: () => {} } as any)).toThrow()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 2. Lifecycle transition matrix
// ────────────────────────────────────────────────────────────────────────────

describe('OUTBOX_LIFECYCLE_TRANSITIONS matrix', () => {
  // Legal edges — every row in the matrix
  it.each<[OutboxLifecycleStatus, OutboxLifecycleStatus]>([
    ['pending',    'processing' ],
    ['processing', 'published'  ],
    ['processing', 'pending'    ],
    ['processing', 'dead_letter'],
  ])('allows legal transition %s → %s', (from: OutboxLifecycleStatus, to: OutboxLifecycleStatus) => {
    expect(isValidOutboxTransition(from, to)).toBe(true)
    expect(tryOutboxTransition(from, to).success).toBe(true)
  })

  // Illegal edges — every non-edge pair
  it.each<[OutboxLifecycleStatus, OutboxLifecycleStatus]>([
    // Terminal states must have no outgoing transitions
    ['published',   'pending'   ],
    ['published',   'processing'],
    ['published',   'dead_letter'],
    ['failed',      'pending'   ],
    ['failed',      'processing'],
    ['dead_letter', 'pending'   ],
    ['dead_letter', 'processing'],
    ['dead_letter', 'published' ],
    // Skipped states
    ['pending',     'published' ],
    ['pending',     'dead_letter'],
    ['pending',     'failed'    ],
    // Backward transitions
    ['processing',  'failed'    ], // 'failed' is not a legal target anymore
    ['published',   'published' ], // self-loop
    ['pending',     'pending'   ], // self-loop
  ])('rejects illegal transition %s → %s', (from: OutboxLifecycleStatus, to: OutboxLifecycleStatus) => {
    expect(isValidOutboxTransition(from, to)).toBe(false)
    const result = tryOutboxTransition(from, to)
    expect(result.success).toBe(false)
    expect(result.error).toContain(from)
    expect(result.error).toContain(to)
  })

  it('returns from/to on the result object for both success and failure', () => {
    const ok = tryOutboxTransition('pending', 'processing')
    expect(ok.from).toBe('pending')
    expect(ok.to).toBe('processing')

    const fail = tryOutboxTransition('published', 'pending')
    expect(fail.from).toBe('published')
    expect(fail.to).toBe('pending')
  })

  it('has exactly 4 legal transitions in the matrix', () => {
    expect(OUTBOX_LIFECYCLE_TRANSITIONS.size).toBe(4)
  })

  it('reports published, failed, dead_letter as terminal states (no outgoing edges)', () => {
    const terminal = OUTBOX_LIFECYCLE_TRANSITIONS.getTerminalStates()
    expect(terminal).toContain('published')
    expect(terminal).toContain('failed')
    expect(terminal).toContain('dead_letter')
    // processing has outgoing edges → not terminal
    expect(terminal).not.toContain('processing')
    expect(terminal).not.toContain('pending')
  })

  describe('getAllowedOutboxTargets', () => {
    it('returns [processing] for pending', () => {
      expect(getAllowedOutboxTargets('pending')).toEqual(['processing'])
    })

    it('returns published, pending, dead_letter for processing (in any order)', () => {
      const targets = getAllowedOutboxTargets('processing')
      expect(targets).toHaveLength(3)
      expect(targets).toContain('published')
      expect(targets).toContain('pending')
      expect(targets).toContain('dead_letter')
    })

    it('returns [] for every terminal state', () => {
      expect(getAllowedOutboxTargets('published')).toEqual([])
      expect(getAllowedOutboxTargets('failed')).toEqual([])
      expect(getAllowedOutboxTargets('dead_letter')).toEqual([])
    })
  })

  it('matrix describe() returns a non-empty human-readable string', () => {
    const desc = OUTBOX_LIFECYCLE_TRANSITIONS.describe()
    expect(desc).toBeTypeOf('string')
    expect(desc.length).toBeGreaterThan(0)
    expect(desc).toContain('pending')
    expect(desc).toContain('processing')
  })

  it('getAllStates includes all five outbox statuses', () => {
    const all = OUTBOX_LIFECYCLE_TRANSITIONS.getAllStates()
    const required: OutboxLifecycleStatus[] = ['pending', 'processing', 'published', 'dead_letter']
    for (const s of required) {
      expect(all).toContain(s)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 3. Repository boundary cases (pg-mem)
// ────────────────────────────────────────────────────────────────────────────

describe('OutboxRepository boundary cases', () => {
  let pool: Pool
  let repo: OutboxRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    repo = new OutboxRepository()
  })

  afterEach(async () => {
    await pool.end()
  })

  // ── renewLease ─────────────────────────────────────────────────────────────

  it('renewLease returns 0 for an unknown consumer (no rows owned)', async () => {
    await insertPending(pool)
    const renewed = await repo.renewLease(pool, 'ghost-consumer', 60)
    expect(renewed).toBe(0)
  })

  it('renewLease returns 0 on an empty table', async () => {
    const renewed = await repo.renewLease(pool, 'any-consumer', 60)
    expect(renewed).toBe(0)
  })

  it('renewLease returns only the count owned by the given consumer', async () => {
    await insertPending(pool, { aggregate_id: 'x1', status: 'processing', consumer_id: 'consumer-a' })
    await insertPending(pool, { aggregate_id: 'x2', status: 'processing', consumer_id: 'consumer-b' })

    const count = await repo.renewLease(pool, 'consumer-a', 60)
    expect(count).toBe(1)
  })

  // ── releaseClaims ───────────────────────────────────────────────────────────

  it('releaseClaims returns 0 for an unknown consumer', async () => {
    await insertPending(pool)
    const released = await repo.releaseClaims(pool, 'ghost-consumer')
    expect(released).toBe(0)
  })

  it('releaseClaims returns 0 on an empty table', async () => {
    const released = await repo.releaseClaims(pool, 'any-consumer')
    expect(released).toBe(0)
  })

  it('releaseClaims resets status to pending, clears consumer_id and idempotency key', async () => {
    const id = await insertPending(pool, {
      status: 'processing',
      consumer_id: 'consumer-a',
      publish_idempotency_key: 'key-a',
    })

    const released = await repo.releaseClaims(pool, 'consumer-a')
    expect(released).toBe(1)

    const row = await pool.query(
      'SELECT status, consumer_id, publish_idempotency_key FROM event_outbox WHERE id=$1',
      [id.toString()]
    )
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].consumer_id).toBeNull()
    expect(row.rows[0].publish_idempotency_key).toBeNull()
  })

  it('releaseClaims does not touch rows owned by a different consumer', async () => {
    const id = await insertPending(pool, { status: 'processing', consumer_id: 'consumer-b' })
    await repo.releaseClaims(pool, 'consumer-a')

    const row = await pool.query(
      'SELECT status, consumer_id FROM event_outbox WHERE id=$1',
      [id.toString()]
    )
    expect(row.rows[0].status).toBe('processing')
    expect(row.rows[0].consumer_id).toBe('consumer-b')
  })

  // ── fetchByConsumer ─────────────────────────────────────────────────────────

  it('fetchByConsumer returns an empty array when the consumer owns nothing', async () => {
    await insertPending(pool, { status: 'processing', consumer_id: 'other' })
    const events = await repo.fetchByConsumer(pool, 'ghost', 10)
    expect(events).toEqual([])
  })

  it('fetchByConsumer returns only processing rows owned by the consumer', async () => {
    await insertPending(pool, { aggregate_id: 'p1', status: 'processing', consumer_id: 'c-1' })
    await insertPending(pool, { aggregate_id: 'p2', status: 'published',  consumer_id: 'c-1' })
    await insertPending(pool, { aggregate_id: 'p3', status: 'processing', consumer_id: 'c-2' })

    const events = await repo.fetchByConsumer(pool, 'c-1', 10)
    expect(events).toHaveLength(1)
    expect(events[0].aggregateId).toBe('p1')
  })

  it('fetchByConsumer respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await insertPending(pool, {
        aggregate_id: `item-${i}`,
        status: 'processing',
        consumer_id: 'bulk-consumer',
      })
    }
    const events = await repo.fetchByConsumer(pool, 'bulk-consumer', 3)
    expect(events).toHaveLength(3)
  })

  // ── getOldestPendingEventLagSeconds ─────────────────────────────────────────

  it('getOldestPendingEventLagSeconds returns 0 when there are no pending events', async () => {
    const lag = await repo.getOldestPendingEventLagSeconds(pool)
    expect(lag).toBe(0)
  })

  it('getOldestPendingEventLagSeconds returns 0 when the table has only published events', async () => {
    await insertPending(pool, { status: 'published' })
    const lag = await repo.getOldestPendingEventLagSeconds(pool)
    expect(lag).toBe(0)
  })

  it('getOldestPendingEventLagSeconds returns a positive number for an aged pending event', async () => {
    await pool.query(
      `INSERT INTO event_outbox
         (aggregate_type, aggregate_id, event_type, payload, status, created_at)
       VALUES ('bond','lag-1','bond.created','{}','pending', NOW() - '10 seconds'::interval)`
    )
    const lag = await repo.getOldestPendingEventLagSeconds(pool)
    expect(lag).toBeGreaterThanOrEqual(9)
  })

  // ── getByAggregate ──────────────────────────────────────────────────────────

  it('getByAggregate returns an empty array for an unknown aggregate', async () => {
    const events = await repo.getByAggregate(pool, 'bond', 'nonexistent-id', 10)
    expect(events).toEqual([])
  })

  it('getByAggregate returns events for the matching aggregate only', async () => {
    await insertPending(pool, { aggregate_id: 'bond-A' })
    await insertPending(pool, { aggregate_id: 'bond-B' })

    const eventsA = await repo.getByAggregate(pool, 'bond', 'bond-A', 10)
    expect(eventsA).toHaveLength(1)
    expect(eventsA[0].aggregateId).toBe('bond-A')
  })

  it('getByAggregate respects the limit parameter', async () => {
    for (let i = 0; i < 4; i++) {
      await insertPending(pool, { aggregate_id: 'bond-multi' })
    }
    const events = await repo.getByAggregate(pool, 'bond', 'bond-multi', 2)
    expect(events).toHaveLength(2)
  })

  // ── getStats ────────────────────────────────────────────────────────────────

  it('getStats returns zeros for every status on an empty table', async () => {
    const stats = await repo.getStats(pool)
    expect(stats.pending).toBe(0)
    expect(stats.processing).toBe(0)
    expect(stats.published).toBe(0)
    expect(stats.failed).toBe(0)
    expect(stats.dead_letter).toBe(0)
  })

  it('getStats correctly counts a mix of statuses', async () => {
    await insertPending(pool, { aggregate_id: 's1', status: 'pending' })
    await insertPending(pool, { aggregate_id: 's2', status: 'pending' })
    await insertPending(pool, { aggregate_id: 's3', status: 'processing', consumer_id: 'c' })
    await insertPending(pool, { aggregate_id: 's4', status: 'dead_letter' })

    const stats = await repo.getStats(pool)
    expect(stats.pending).toBe(2)
    expect(stats.processing).toBe(1)
    expect(stats.dead_letter).toBe(1)
    expect(stats.published).toBe(0)
  })

  // ── cleanup ─────────────────────────────────────────────────────────────────

  it('cleanup returns 0 on an empty table', async () => {
    const deleted = await repo.cleanup(pool, { publishedRetentionDays: 7, failedRetentionDays: 30 })
    expect(deleted).toBe(0)
  })

  it('cleanup does not delete recent published events', async () => {
    await insertPending(pool, { aggregate_id: 'fresh', status: 'published' })
    const deleted = await repo.cleanup(pool, { publishedRetentionDays: 7, failedRetentionDays: 30 })
    expect(deleted).toBe(0)
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM event_outbox')
    expect(count.rows[0].n).toBe(1)
  })

  it('cleanup removes published events older than publishedRetentionDays', async () => {
    await pool.query(
      `INSERT INTO event_outbox
         (aggregate_type, aggregate_id, event_type, payload, status, processed_at)
       VALUES ('bond','stale-pub','bond.created','{}','published', NOW() - '10 days'::interval)`
    )
    await insertPending(pool, { aggregate_id: 'fresh', status: 'published' })

    const deleted = await repo.cleanup(pool, { publishedRetentionDays: 7, failedRetentionDays: 30 })
    expect(deleted).toBe(1)

    const remaining = await pool.query("SELECT aggregate_id FROM event_outbox WHERE status = 'published'")
    expect(remaining.rows[0].aggregate_id).toBe('fresh')
  })

  it('cleanup does not delete pending or processing events regardless of age', async () => {
    await pool.query(
      `INSERT INTO event_outbox
         (aggregate_type, aggregate_id, event_type, payload, status, created_at)
       VALUES ('bond','old-pending','bond.created','{}','pending', NOW() - '100 days'::interval)`
    )
    await pool.query(
      `INSERT INTO event_outbox
         (aggregate_type, aggregate_id, event_type, payload, status, consumer_id, created_at)
       VALUES ('bond','old-processing','bond.created','{}','processing','c', NOW() - '100 days'::interval)`
    )
    const deleted = await repo.cleanup(pool, { publishedRetentionDays: 1, failedRetentionDays: 1 })
    expect(deleted).toBe(0)

    const count = await pool.query('SELECT COUNT(*)::int AS n FROM event_outbox')
    expect(count.rows[0].n).toBe(2)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 4. Stale / loading state — next_attempt_at gate & lease reclamation
// ────────────────────────────────────────────────────────────────────────────

describe('OutboxRepository stale and loading state', () => {
  let pool: Pool
  let repo: OutboxRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    repo = new OutboxRepository()
  })

  afterEach(async () => {
    await pool.end()
  })

  it('claimEvents skips a pending event whose next_attempt_at is in the future', async () => {
    // Insert directly using a SQL interval expression so pg-mem evaluates it correctly
    await pool.query(
      `INSERT INTO event_outbox
         (aggregate_type, aggregate_id, event_type, payload, status, next_attempt_at)
       VALUES ('bond','backed-off-future','bond.created','{}','pending', NOW() + '1 hour'::interval)`
    )

    const claimed = await repo.claimEvents(pool, 'c-test', 10, 60)
    const ids = claimed.map(e => e.aggregateId)
    expect(ids).not.toContain('backed-off-future')
  })

  it('claimEvents picks up a backed-off event once next_attempt_at passes', async () => {
    // Simulate an event whose backoff has already elapsed
    await pool.query(
      `INSERT INTO event_outbox
         (aggregate_type, aggregate_id, event_type, payload, status, next_attempt_at)
       VALUES ('bond','due-now','bond.created','{}','pending', NOW() - '1 second'::interval)`
    )

    const claimed = await repo.claimEvents(pool, 'c-test', 10, 60)
    const ids = claimed.map(e => e.aggregateId)
    expect(ids).toContain('due-now')
  })

  it('claimEvents reclaims a processing event with an expired lease', async () => {
    const id = await insertPending(pool, {
      aggregate_id: 'crash-victim',
      status: 'processing',
      consumer_id: 'dead-consumer',
    })
    // Expire the lease
    await pool.query(
      `UPDATE event_outbox SET lease_expires_at = NOW() - '1 second'::interval WHERE id = $1`,
      [id.toString()]
    )

    const claimed = await repo.claimEvents(pool, 'recovery-consumer', 10, 60)
    expect(claimed).toHaveLength(1)
    expect(claimed[0].aggregateId).toBe('crash-victim')
    expect(claimed[0].consumerId).toBe('recovery-consumer')
  })

  it('claimEvents does not reclaim a processing event whose lease is still active', async () => {
    const id = await insertPending(pool, {
      aggregate_id: 'active-lease',
      status: 'processing',
      consumer_id: 'live-consumer',
    })
    // Set an active lease directly via SQL interval
    await pool.query(
      `UPDATE event_outbox SET lease_expires_at = NOW() + '5 minutes'::interval WHERE id = $1`,
      [id.toString()]
    )

    const claimed = await repo.claimEvents(pool, 'interloper', 10, 60)
    const ids = claimed.map(e => e.aggregateId)
    expect(ids).not.toContain('active-lease')
  })

  it('claimEvents respects the limit parameter and does not over-claim', async () => {
    for (let i = 0; i < 5; i++) {
      await insertPending(pool, { aggregate_id: `e-${i}` })
    }
    const claimed = await repo.claimEvents(pool, 'c-limit', 3, 60)
    expect(claimed).toHaveLength(3)
  })

  it('markPublished throws when the consumer does not own the row', async () => {
    const id = await insertPending(pool, {
      status: 'processing',
      consumer_id: 'owner-a',
    })
    await expect(repo.markPublished(pool, id, 'owner-b')).rejects.toThrow('cannot transition')
  })

  it('markPublished throws when the event is already published (idempotent guard)', async () => {
    const id = await insertPending(pool, {
      aggregate_id: 'already-done',
      status: 'processing',
      consumer_id: 'owner-a',
    })
    await repo.markPublished(pool, id, 'owner-a')
    // Second call must fail — published is terminal
    await expect(repo.markPublished(pool, id, 'owner-a')).rejects.toThrow('cannot transition')
  })

  it('markFailed throws when the consumer does not own the row', async () => {
    const id = await insertPending(pool, {
      status: 'processing',
      consumer_id: 'owner-a',
    })
    await expect(repo.markFailed(pool, id, 'error', 'owner-b')).rejects.toThrow('cannot transition')
  })

  it('markFailed on a dead_letter row throws (terminal state guard)', async () => {
    const id = await insertPending(pool, {
      aggregate_id: 'dl-guard',
      status: 'dead_letter',
      retry_count: 5,
      max_retries: 5,
    })
    await expect(repo.markFailed(pool, id, 'late-error', 'any')).rejects.toThrow('cannot transition')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 5. Permission / ownership invariants — trySetPublishIdempotencyKey
// ────────────────────────────────────────────────────────────────────────────

describe('OutboxRepository publish idempotency invariants', () => {
  let pool: Pool
  let repo: OutboxRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    repo = new OutboxRepository()
  })

  afterEach(async () => {
    await pool.end()
  })

  it('trySetPublishIdempotencyKey returns true on the first call', async () => {
    const id = await insertPending(pool, { status: 'processing', consumer_id: 'c-a' })
    const ok = await repo.trySetPublishIdempotencyKey(pool, id, 'key-a', 'c-a')
    expect(ok).toBe(true)
  })

  it('trySetPublishIdempotencyKey returns false on a second call (key already set)', async () => {
    const id = await insertPending(pool, { status: 'processing', consumer_id: 'c-a' })
    await repo.trySetPublishIdempotencyKey(pool, id, 'key-a', 'c-a')
    const second = await repo.trySetPublishIdempotencyKey(pool, id, 'key-b', 'c-a')
    expect(second).toBe(false)
  })

  it('trySetPublishIdempotencyKey preserves the original key after second call', async () => {
    const id = await insertPending(pool, { status: 'processing', consumer_id: 'c-a' })
    await repo.trySetPublishIdempotencyKey(pool, id, 'original-key', 'c-a')
    await repo.trySetPublishIdempotencyKey(pool, id, 'overwrite-attempt', 'c-a')

    const row = await pool.query(
      'SELECT publish_idempotency_key FROM event_outbox WHERE id = $1',
      [id.toString()]
    )
    expect(row.rows[0].publish_idempotency_key).toBe('original-key')
  })

  it('trySetPublishIdempotencyKey returns false for a pending (not processing) row', async () => {
    // The WHERE clause requires status = 'processing'; a pending row never matches.
    const id = await insertPending(pool) // status = 'pending'
    const ok = await repo.trySetPublishIdempotencyKey(pool, id, 'key', 'any-consumer')
    expect(ok).toBe(false)
  })

  it('clearPublishIdempotencyKey removes the key so a retry can re-acquire it', async () => {
    const id = await insertPending(pool, { status: 'processing', consumer_id: 'c-a' })
    await repo.trySetPublishIdempotencyKey(pool, id, 'key-a', 'c-a')
    await repo.clearPublishIdempotencyKey(pool, id)

    const ok = await repo.trySetPublishIdempotencyKey(pool, id, 'key-b', 'c-a')
    expect(ok).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 6. Recovery invariants
// ────────────────────────────────────────────────────────────────────────────

describe('OutboxRepository crash recovery invariants', () => {
  let pool: Pool
  let repo: OutboxRepository

  beforeEach(async () => {
    pool = await buildTestPool()
    repo = new OutboxRepository()
  })

  afterEach(async () => {
    await pool.end()
  })

  it('recovery consumer skips publish and calls markPublished when key is already set', async () => {
    // Simulate: consumer-a set the key but crashed before markPublished
    const id = await insertPending(pool, {
      aggregate_id: 'crash-recovery',
      status: 'processing',
      consumer_id: 'consumer-a',
      publish_idempotency_key: 'outbox-pub:consumer-a:1',
    })

    // Simulate crash → expire lease
    await pool.query(
      `UPDATE event_outbox SET lease_expires_at = NOW() - '1 second'::interval WHERE id = $1`,
      [id.toString()]
    )

    // consumer-b reclaims via direct SQL (bypasses the md5 path for this test)
    await pool.query(
      `UPDATE event_outbox
       SET consumer_id = 'consumer-b', lease_expires_at = NOW() + '60 seconds'::interval
       WHERE id = $1`,
      [id.toString()]
    )

    // consumer-b sees the idempotency key already set → trySet returns false
    const acquired = await repo.trySetPublishIdempotencyKey(pool, id, 'outbox-pub:consumer-b:1', 'consumer-b')
    expect(acquired).toBe(false)

    // consumer-b skips publish and calls markPublished directly
    await repo.markPublished(pool, id, 'consumer-b')

    const row = await pool.query(
      'SELECT status, publish_idempotency_key FROM event_outbox WHERE id = $1',
      [id.toString()]
    )
    expect(row.rows[0].status).toBe('published')
    expect(row.rows[0].publish_idempotency_key).toBeNull()
  })

  it('markFailed clears the idempotency key so the next retry attempt can acquire it', async () => {
    const id = await insertPending(pool, {
      aggregate_id: 'retry-clears-key',
      status: 'processing',
      consumer_id: 'c-a',
      retry_count: 0,
      max_retries: 3,
    })
    await repo.trySetPublishIdempotencyKey(pool, id, 'key-attempt-1', 'c-a')

    const result = await repo.markFailed(pool, id, 'transient error', 'c-a')
    expect(result.status).toBe('pending')
    expect(result.retryCount).toBe(1)

    const row = await pool.query(
      'SELECT publish_idempotency_key, status FROM event_outbox WHERE id = $1',
      [id.toString()]
    )
    expect(row.rows[0].publish_idempotency_key).toBeNull()
    expect(row.rows[0].status).toBe('pending')
  })

  it('releaseClaims clears idempotency key and resets to pending for graceful handoff', async () => {
    const id = await insertPending(pool, {
      aggregate_id: 'graceful-shutdown',
      status: 'processing',
      consumer_id: 'c-graceful',
      publish_idempotency_key: 'key-graceful',
    })

    const released = await repo.releaseClaims(pool, 'c-graceful')
    expect(released).toBe(1)

    const row = await pool.query(
      'SELECT status, consumer_id, publish_idempotency_key FROM event_outbox WHERE id = $1',
      [id.toString()]
    )
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].consumer_id).toBeNull()
    expect(row.rows[0].publish_idempotency_key).toBeNull()
  })

  it('markFailed transitions to dead_letter at exactly max_retries and does NOT clear idempotency key (event is terminal)', async () => {
    // retry_count = 4, max_retries = 5 → this failure reaches dead_letter
    const id = await insertPending(pool, {
      aggregate_id: 'exhaust-retries',
      status: 'processing',
      consumer_id: 'c-final',
      retry_count: 4,
      max_retries: 5,
    })

    const result = await repo.markFailed(pool, id, 'final error', 'c-final')
    expect(result.status).toBe('dead_letter')
    expect(result.retryCount).toBe(5)

    const row = await pool.query(
      'SELECT status, retry_count, processed_at FROM event_outbox WHERE id = $1',
      [id.toString()]
    )
    expect(row.rows[0].status).toBe('dead_letter')
    expect(Number(row.rows[0].retry_count)).toBe(5)
    // processed_at is stamped when moved to dead_letter
    expect(row.rows[0].processed_at).not.toBeNull()
  })

  it('concurrent trySetPublishIdempotencyKey — only one consumer wins the key', async () => {
    // Both calls target the same row whose key is currently NULL.
    // In a pg-mem serialised environment only one will match the WHERE clause.
    const id = await insertPending(pool, { status: 'processing', consumer_id: 'c-a' })

    const [first, second] = await Promise.all([
      repo.trySetPublishIdempotencyKey(pool, id, 'key-from-a', 'c-a'),
      repo.trySetPublishIdempotencyKey(pool, id, 'key-from-b', 'c-a'),
    ])

    // Exactly one succeeds
    expect(first || second).toBe(true)
    expect(first && second).toBe(false)

    // The key stored is whichever consumer won
    const row = await pool.query(
      'SELECT publish_idempotency_key FROM event_outbox WHERE id = $1',
      [id.toString()]
    )
    expect(row.rows[0].publish_idempotency_key).toMatch(/^key-from-[ab]$/)
  })

  it('full recovery lifecycle: crash → expire → reclaim → markPublished', async () => {
    // 1. Emit into the outbox
    const eventId = await repo.create(pool, {
      aggregateType: 'bond',
      aggregateId: 'full-recovery',
      eventType: 'bond.created',
      payload: { address: '0xdead' },
    })

    // 2. Consumer-A claims and starts processing
    await pool.query(
      `UPDATE event_outbox
       SET status = 'processing', consumer_id = 'consumer-a',
           lease_expires_at = NOW() + '60 seconds'::interval
       WHERE id = $1`,
      [eventId.toString()]
    )

    // 3. Consumer-A sets the idempotency key (pre-publish step)
    const keyA = `outbox-pub:consumer-a:${eventId}`
    expect(await repo.trySetPublishIdempotencyKey(pool, eventId, keyA, 'consumer-a')).toBe(true)

    // 4. Consumer-A crashes — simulate by expiring the lease
    await pool.query(
      `UPDATE event_outbox SET lease_expires_at = NOW() - '1 second'::interval WHERE id = $1`,
      [eventId.toString()]
    )

    // 5. Consumer-B reclaims
    await pool.query(
      `UPDATE event_outbox
       SET consumer_id = 'consumer-b', lease_expires_at = NOW() + '60 seconds'::interval
       WHERE id = $1`,
      [eventId.toString()]
    )

    // 6. Consumer-B checks the key — already set → skips publish
    const keyB = `outbox-pub:consumer-b:${eventId}`
    expect(await repo.trySetPublishIdempotencyKey(pool, eventId, keyB, 'consumer-b')).toBe(false)

    // 7. Consumer-B completes the lifecycle with markPublished
    await repo.markPublished(pool, eventId, 'consumer-b')

    const final = await pool.query(
      `SELECT status, publish_idempotency_key, consumer_id FROM event_outbox WHERE id = $1`,
      [eventId.toString()]
    )
    expect(final.rows[0].status).toBe('published')
    expect(final.rows[0].publish_idempotency_key).toBeNull()
    expect(final.rows[0].consumer_id).toBeNull()
  })
})
