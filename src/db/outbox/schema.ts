import type { Queryable } from '../repositories/queryable.js'

/**
 * Transactional outbox table for reliable domain event publishing.
 * Events are persisted in the same transaction as business state changes,
 * then published asynchronously with retry and deduplication.
 */
export const OUTBOX_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS event_outbox (
    id BIGSERIAL PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'published', 'failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    error_message TEXT
  )
` as const

export const OUTBOX_INDEXES = [
  'CREATE INDEX IF NOT EXISTS event_outbox_status_created_idx ON event_outbox (status, created_at) WHERE status IN (\'pending\', \'processing\')',
  'CREATE INDEX IF NOT EXISTS event_outbox_aggregate_idx ON event_outbox (aggregate_type, aggregate_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS event_outbox_processed_at_idx ON event_outbox (processed_at) WHERE status = \'published\'',
] as const

export async function createOutboxSchema(db: Queryable): Promise<void> {
  await db.query(OUTBOX_TABLE_SCHEMA)
  for (const index of OUTBOX_INDEXES) {
    await db.query(index)
  }
}

export async function dropOutboxSchema(db: Queryable): Promise<void> {
  await db.query('DROP TABLE IF EXISTS event_outbox')
}
