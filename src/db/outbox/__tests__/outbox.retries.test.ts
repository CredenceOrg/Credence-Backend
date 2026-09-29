import crypto from 'crypto'
import { newDb } from 'pg-mem'
import type { IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import { OutboxRepository } from '../repository'
import { createOutboxSchema } from '../schema'

async function buildTestDb(): Promise<{ db: IMemoryDb; pool: Pool }> {
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

    db.public.registerFunction({
        name: 'gen_random_uuid',
        returns: 'uuid',
        implementation: () => crypto.randomUUID(),
    } as Parameters<typeof db.public.registerFunction>[0])

    // pg-mem does not implement POWER by default; register a JS-backed implementation
    db.public.registerFunction({
        name: 'power',
        returns: 'numeric',
        implementation: (a: number, b: number) => Math.pow(Number(a), Number(b)),
    } as Parameters<typeof db.public.registerFunction>[0])

    const adapter = db.adapters.createPg()
    const pool = new adapter.Pool() as unknown as Pool

    // Create the outbox table directly (avoid DO $$ blocks which require plpgsql in pg-mem)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS event_outbox (
            id BIGSERIAL PRIMARY KEY,
            aggregate_type TEXT NOT NULL,
            aggregate_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload JSONB NOT NULL,
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
        );
    `)

    await pool.query(`CREATE INDEX IF NOT EXISTS event_outbox_status_created_idx ON event_outbox (status, created_at)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS event_outbox_aggregate_idx ON event_outbox (aggregate_type, aggregate_id, created_at DESC)`)

    return { db, pool }
}

describe('Outbox bounded retries and backoff', () => {
    let pool: Pool
    let repo: OutboxRepository

    beforeAll(async () => {
        const built = await buildTestDb()
        pool = built.pool
        repo = new OutboxRepository()
    })

    afterEach(async () => {
        await pool.query('DELETE FROM event_outbox')
    })

    it('transitions to dead_letter exactly at max retries', async () => {
        const insert = await pool.query(
                `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, retry_count, max_retries, consumer_id, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'consumer',NOW()) RETURNING id`,
            ['agg', '1', 't', JSON.stringify({ a: 1 }), 'processing', 4, 5]
        )
        const id = BigInt(insert.rows[0].id)

        const result = await repo.markFailed(pool, id, 'SOME_ERROR', 'consumer')
        expect(result.status).toBe('dead_letter')
        expect(result.retryCount).toBe(5)

        const check = await pool.query('SELECT status, retry_count, processed_at FROM event_outbox WHERE id = $1', [id.toString()])
        expect(check.rows[0].status).toBe('dead_letter')
        expect(Number(check.rows[0].retry_count)).toBe(5)
        expect(check.rows[0].processed_at).not.toBeNull()
    })

    it('claimEvents skips not-yet-due events (next_attempt_at) and only returns due ones', async () => {
        // due in future
        await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, created_at, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,NOW(), NOW() + '1 hour'::interval)`,
            ['agg', 'A', 't', JSON.stringify({}), 'pending']
        )

        // due now
        const due = await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id`,
            ['agg', 'B', 't', JSON.stringify({}), 'pending']
        )

        const consumerId = 'test-consumer'
        const events = await repo.claimEvents(pool, consumerId, 10, 60)
        expect(events.length).toBe(1)
        expect(events[0].id).toBe(BigInt(due.rows[0].id))
    })

    it('preserves ordering while skipping a backed-off older event', async () => {
        // t1 older but backed off
        const t1 = await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, created_at, next_attempt_at)
             VALUES ($1,$2,$3,$4,$5,NOW() - '10 seconds'::interval, NOW() + '1 hour'::interval) RETURNING id`,
            ['agg', 'X', 't', JSON.stringify({ seq: 1 }), 'pending']
        )

        // t2 newer and due
        const t2 = await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW() + '1 second') RETURNING id`,
            ['agg', 'X', 't', JSON.stringify({ seq: 2 }), 'pending']
        )

        // t3 newest and due
        const t3 = await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW() + '2 second') RETURNING id`,
            ['agg', 'X', 't', JSON.stringify({ seq: 3 }), 'pending']
        )

        const consumerId = 'test-consumer-2'
        const events = await repo.claimEvents(pool, consumerId, 10, 60)
        // Should skip t1 and return t2 then t3 preserving order
        expect(events.map(e => e.id)).toEqual([BigInt(t2.rows[0].id), BigInt(t3.rows[0].id)])
    })

    it('caps the backoff delay at 3600s even when 2^retryCount would be far larger', async () => {
        const insert = await pool.query(
              `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, retry_count, max_retries, consumer_id, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'consumer',NOW()) RETURNING id`,
            ['agg', 'cap2', 't', JSON.stringify({}), 'processing', 15, 20]
        )
        const id = BigInt(insert.rows[0].id)

        const before = Date.now()
        await repo.markFailed(pool, id, 'timeout', 'consumer')

        const check = await pool.query('SELECT next_attempt_at FROM event_outbox WHERE id = $1', [id.toString()])
        const nextAttemptAt = new Date(check.rows[0].next_attempt_at).getTime()
        const deltaSeconds = (nextAttemptAt - before) / 1000

        // Uncapped this would be 2^16 = 65536s (~18 hours); capped it must stay near 3600s.
        expect(deltaSeconds).toBeGreaterThan(3000)
        expect(deltaSeconds).toBeLessThanOrEqual(3600 + 5)
    })

    it('sanitizes the error message before persisting it (truncation + secret redaction)', async () => {
        const insert = await pool.query(
              `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, retry_count, max_retries, consumer_id, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'consumer',NOW()) RETURNING id`,
            ['agg', 'sanitize', 't', JSON.stringify({}), 'processing', 0, 5]
        )
        const id = BigInt(insert.rows[0].id)

        const seed = 'S' + 'A'.repeat(55)
        await repo.markFailed(pool, id, `webhook rejected signer ${seed}`, 'consumer')

        const check = await pool.query('SELECT error_message FROM event_outbox WHERE id = $1', [id.toString()])
        expect(check.rows[0].error_message).not.toContain(seed)
        expect(check.rows[0].error_message).toContain('[REDACTED]')
    })
})

describe('Outbox lifecycle transition invariants', () => {
    let pool: Pool
    let repo: OutboxRepository

    beforeEach(async () => {
        const built = await buildTestDb()
        pool = built.pool
        repo = new OutboxRepository()
    })

    afterEach(async () => {
        await pool.end()
    })

    it('allows each legal edge and rejects stale, repeated, skipped, and out-of-order edges', async () => {
        await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, max_retries)
             VALUES ('agg', 'legal', 't', '{}', 'pending', 2)`
        )
        const [claimed] = await repo.claimEvents(pool, 'owner-a', 1, 60)

        expect(await repo.trySetPublishIdempotencyKey(pool, claimed.id, 'key', 'owner-a')).toBe(true)
        await repo.markPublished(pool, claimed.id, 'owner-a')

        await expect(repo.markPublished(pool, claimed.id, 'owner-a')).rejects.toThrow('cannot transition')
        await expect(repo.markFailed(pool, claimed.id, 'late', 'owner-a')).rejects.toThrow('cannot transition')

        await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status)
             VALUES ('agg', 'stale', 't', '{}', 'processing')`
        )
        const stale = await pool.query<{ id: string }>(
            `SELECT id FROM event_outbox WHERE aggregate_id = 'stale'`
        )
        await expect(repo.markPublished(pool, BigInt(stale.rows[0].id), 'owner-a')).rejects.toThrow('cannot transition')

        await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status)
             VALUES ('agg', 'skipped', 't', '{}', 'pending')`
        )
        const skipped = await pool.query<{ id: string }>(
            `SELECT id FROM event_outbox WHERE aggregate_id = 'skipped'`
        )
        expect(await repo.trySetPublishIdempotencyKey(pool, BigInt(skipped.rows[0].id), 'key', 'owner-a')).toBe(false)
        await expect(repo.markFailed(pool, BigInt(skipped.rows[0].id), 'early', 'owner-a')).rejects.toThrow('cannot transition')

        await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status)
             VALUES ('agg', 'terminal', 't', '{}', 'dead_letter')`
        )
        const terminal = await pool.query<{ id: string }>(
            `SELECT id FROM event_outbox WHERE aggregate_id = 'terminal'`
        )
        await expect(repo.markFailed(pool, BigInt(terminal.rows[0].id), 'out of order', 'owner-a')).rejects.toThrow('cannot transition')
    })

    it('rejects a stale owner without changing the processing row', async () => {
        await pool.query(
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, consumer_id)
             VALUES ('agg', 'wrong-owner', 't', '{}', 'processing', 'owner-b')`
        )
        const row = await pool.query<{ id: string }>(
            `SELECT id FROM event_outbox WHERE aggregate_id = 'wrong-owner'`
        )

        await expect(repo.markFailed(pool, BigInt(row.rows[0].id), 'stale', 'owner-a')).rejects.toThrow('cannot transition')
        const unchanged = await pool.query<{ status: string; retry_count: number }>(
            `SELECT status, retry_count FROM event_outbox WHERE id = $1`,
            [row.rows[0].id]
        )
        expect(unchanged.rows[0]).toMatchObject({ status: 'processing', retry_count: 0 })
    })
})
