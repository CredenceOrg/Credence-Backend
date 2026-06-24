import { newDb } from 'pg-mem'
import type { IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import { OutboxRepository } from '../repository'
import { createOutboxSchema } from '../schema'

async function buildTestDb(): Promise<{ db: IMemoryDb; pool: Pool }> {
    const db = newDb()

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
            tracestate TEXT
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
            `INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload, status, retry_count, max_retries, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
            ['agg', '1', 't', JSON.stringify({ a: 1 }), 'processing', 4, 5]
        )
        const id = BigInt(insert.rows[0].id)

        const result = await repo.markFailed(pool, id, 'SOME_ERROR')
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
})
