import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { IMemoryDb } from 'pg-mem'
import { Pool } from 'pg'
import { PostgresDlqStore } from './postgresDlqStore.js'
import type { DlqEntry, WebhookPayload } from './types.js'

function createPassthroughPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'query') return (target as any)[prop]
      return (text: string, values?: unknown[]) => {
        return (target as any).query(text, values)
      }
    },
  })
}

async function buildTestDb(): Promise<{ db: IMemoryDb; pool: Pool; proxiedPool: Pool }> {
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

  const proxiedPool = createPassthroughPool(pool)
  return { db, pool, proxiedPool }
}

describe('PostgresDlqStore', () => {
  let pool: Pool
  let store: PostgresDlqStore

  const mockPayload: WebhookPayload = {
    event: 'bond.created',
    timestamp: '2026-01-01T00:00:00.000Z',
    data: { address: 'GABC' },
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
    const built = await buildTestDb()
    pool = built.pool
    store = new PostgresDlqStore(built.proxiedPool)
  })

  afterEach(async () => {
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
})
