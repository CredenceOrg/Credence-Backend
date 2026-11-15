import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'

vi.mock('../../middleware/metrics.js', () => ({
  recordWebhookDlqSize: vi.fn(),
}))

import { PostgresDlqStore } from './postgresDlqStore.js'
import type { DlqEntry, WebhookPayload } from './types.js'

function createPassthroughPool(pool: Pool, onQuery?: (sql: string, values?: unknown[]) => void): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'query') return (target as any)[prop]
      return (text: string, values?: unknown[]) => {
        onQuery?.(text, values)
        return (target as any).query(text, values)
      }
    },
  })
}

async function buildTestDb(
  onQuery?: (sql: string, values?: unknown[]) => void,
): Promise<{ db: IMemoryDb; pool: Pool; proxiedPool: Pool }> {
  const db = newDb()

  const adapter = db.adapters.createPg()
  const pool = new adapter.Pool() as unknown as Pool

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_dlq (
      id VARCHAR(255) PRIMARY KEY,
      webhook_id VARCHAR(255) NOT NULL,
      payload JSONB NOT NULL,
      failed_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL,
      last_status_code INTEGER,
      last_error TEXT,
      response_body_snippet TEXT,
      replayed_at TIMESTAMPTZ
    );
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_replay_audit (
      id VARCHAR(255) PRIMARY KEY,
      dlq_entry_id VARCHAR(255) NOT NULL,
      webhook_id VARCHAR(255) NOT NULL,
      actor_id VARCHAR(255) NOT NULL,
      actor_email VARCHAR(255) NOT NULL,
      tenant_id VARCHAR(255) NOT NULL,
      idempotency_key VARCHAR(255) NOT NULL,
      replayed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      success BOOLEAN NOT NULL,
      status_code INTEGER,
      error_message TEXT,
      ip_address VARCHAR(64),
      request_id VARCHAR(255),
      CONSTRAINT uq_webhook_replay_audit_idempotency UNIQUE (dlq_entry_id, idempotency_key)
    );
  `)

  const proxiedPool = createPassthroughPool(pool, onQuery)
  return { db, pool, proxiedPool }
}

describe('PostgresDlqStore', () => {
  let pool: Pool
  let store: PostgresDlqStore
  let recordedQueries: Array<{ sql: string; values?: unknown[] }> = []

  const mockPayload: WebhookPayload = {
    event: 'bond.created',
    timestamp: '2026-01-01T00:00:00.000Z',
    data: {
      address: 'GABC',
      bondedAmount: '100',
      bondStart: null,
      bondDuration: null,
      active: true,
    },
  }

  const mockEntry: DlqEntry = {
    id: 'entry_1',
    webhookId: 'wh_1',
    payload: mockPayload,
    failedAt: '2026-01-01T00:00:00.000Z',
    attempts: 3,
    lastStatusCode: 500,
    lastError: 'Internal Server Error',
    responseBodySnippet: 'Error',
  }

  beforeAll(async () => {
    const built = await buildTestDb((sql, values) => {
      recordedQueries.push({ sql, values })
    })
    pool = built.pool
    store = new PostgresDlqStore(built.proxiedPool)
  })

  afterEach(async () => {
    recordedQueries = []
    await pool.query('DELETE FROM webhook_replay_audit')
    await pool.query('DELETE FROM webhook_dlq')
  })

  it('stores and retrieves entries', async () => {
    await store.push(mockEntry)
    
    const retrieved = await store.get('entry_1')
    expect(retrieved).not.toBeNull()
    expect(retrieved?.webhookId).toBe('wh_1')
    expect(retrieved?.attempts).toBe(3)
    expect(retrieved?.lastStatusCode).toBe(500)
    expect(retrieved?.lastError).toBe('Internal Server Error')
    expect(retrieved?.responseBodySnippet).toBe('Error')
    expect(retrieved?.payload.event).toBe('bond.created')
    expect(retrieved?.replayedAt).toBeUndefined()
  })

  it('lists entries ordered by failed_at desc', async () => {
    const entry2: DlqEntry = {
      ...mockEntry,
      id: 'entry_2',
      failedAt: '2026-01-02T00:00:00.000Z',
    }

    await store.push(mockEntry)
    await store.push(entry2)

    const list = await store.list()
    expect(list).toHaveLength(2)
    // entry2 is newer, should be first
    expect(list[0].id).toBe('entry_2')
    expect(list[1].id).toBe('entry_1')
  })

  it('marks entry as replayed', async () => {
    await store.push(mockEntry)
    await store.markReplayed('entry_1', '2026-01-03T00:00:00.000Z')

    const updated = await store.get('entry_1')
    expect(updated?.replayedAt).toBe('2026-01-03T00:00:00.000Z')
  })

  it('returns null for unknown id', async () => {
    const retrieved = await store.get('non_existent')
    expect(retrieved).toBeNull()
  })

  it('handles metric update failure silently', async () => {
    // temporarily mock pool.query to throw
    const originalQuery = pool.query.bind(pool)
    let callCount = 0
    pool.query = async (...args: any[]) => {
      callCount++
      if (callCount === 2) {
        // First call is the INSERT, second call is the metrics SELECT
        throw new Error('Fake DB error')
      }
      return originalQuery(...args)
    }

    try {
      // should not throw
      await store.push({
        ...mockEntry,
        id: 'entry_metric_fail'
      })
    } finally {
      // restore
      pool.query = originalQuery
    }
    
    const retrieved = await store.get('entry_metric_fail')
    expect(retrieved).not.toBeNull()
  })

  it('returns only pending rows and applies SQL LIMIT when pendingOnly and limit are passed', async () => {
    for (let i = 1; i <= 3; i++) {
      await store.push({
        ...mockEntry,
        id: `replayed_${i}`,
        failedAt: `2026-01-0${i}T00:00:00.000Z`,
        replayedAt: `2026-01-1${i}T00:00:00.000Z`,
      })
    }

    await store.push({
      ...mockEntry,
      id: 'pending_older',
      failedAt: '2026-01-04T00:00:00.000Z',
    })
    await store.push({
      ...mockEntry,
      id: 'pending_newer',
      failedAt: '2026-01-05T00:00:00.000Z',
    })

    recordedQueries = []
    const pending = await store.list({ pendingOnly: true, limit: 10 })

    expect(pending.map((e) => e.id)).toEqual(['pending_newer', 'pending_older'])
    expect(recordedQueries).toHaveLength(1)
    expect(recordedQueries[0].sql).toMatch(/WHERE\s+replayed_at\s+IS\s+NULL/i)
    expect(recordedQueries[0].sql).toMatch(/LIMIT\s+\$1/i)
    expect(recordedQueries[0].values).toEqual([10])

    recordedQueries = []
    const unbounded = await store.list()
    expect(unbounded).toHaveLength(5)
    expect(recordedQueries[0].sql).not.toMatch(/LIMIT/i)
  })

  it('tracks durable replay attempts in webhook_replay_audit with idempotency deduplication', async () => {
    await store.push(mockEntry)
    expect(await store.replayAttempts('entry_1')).toBe(0)

    await store.recordReplayAttempt({
      dlqEntryId: 'entry_1',
      webhookId: 'wh_1',
      actorId: 'system:dlq-processor',
      actorEmail: 'system',
      tenantId: 'system',
      idempotencyKey: 'entry_1:attempt:1',
      success: false,
      statusCode: 503,
      errorMessage: 'Service Unavailable',
    })
    expect(await store.replayAttempts('entry_1')).toBe(1)

    // Duplicate idempotencyKey for the same dlqEntryId is ignored.
    await store.recordReplayAttempt({
      dlqEntryId: 'entry_1',
      webhookId: 'wh_1',
      actorId: 'system:dlq-processor',
      actorEmail: 'system',
      tenantId: 'system',
      idempotencyKey: 'entry_1:attempt:1',
      success: false,
      statusCode: 503,
    })
    expect(await store.replayAttempts('entry_1')).toBe(1)

    await store.recordReplayAttempt({
      dlqEntryId: 'entry_1',
      webhookId: 'wh_1',
      actorId: 'system:dlq-processor',
      actorEmail: 'system',
      tenantId: 'tenant_abc',
      idempotencyKey: 'entry_1:attempt:2',
      success: true,
      statusCode: 200,
    })
    expect(await store.replayAttempts('entry_1')).toBe(2)

    // Original DLQ entry remains untouched until markReplayed is called.
    const unchanged = await store.get('entry_1')
    expect(unchanged?.attempts).toBe(3)
    expect(unchanged?.replayedAt).toBeUndefined()
  })
})
