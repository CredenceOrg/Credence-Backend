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
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'published', 'failed', 'dead_letter')),
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
` as const

export const OUTBOX_INDEXES = [
  'CREATE INDEX IF NOT EXISTS event_outbox_status_created_idx ON event_outbox (status, created_at) WHERE status IN (\'pending\', \'processing\')',
  'CREATE INDEX IF NOT EXISTS event_outbox_aggregate_idx ON event_outbox (aggregate_type, aggregate_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS event_outbox_processed_at_idx ON event_outbox (processed_at) WHERE status = \'published\'',
  'CREATE INDEX IF NOT EXISTS event_outbox_consumer_idx ON event_outbox (consumer_id, status) WHERE consumer_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS event_outbox_lease_expires_idx ON event_outbox (lease_expires_at) WHERE status = \'processing\'',
  'CREATE INDEX IF NOT EXISTS event_outbox_next_attempt_idx ON event_outbox (next_attempt_at) WHERE status = \'pending\'',
] as const

export async function createOutboxSchema(db: Queryable): Promise<void> {
  // Create table if it doesn't exist (includes all columns)
  await db.query(OUTBOX_TABLE_SCHEMA)

  // For existing tables, add new columns if missing (backward compatibility)
  await db.query(`
    DO $$ 
    DECLARE
      c record;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                     WHERE table_name = 'event_outbox' AND column_name = 'consumer_id') THEN
        ALTER TABLE event_outbox ADD COLUMN consumer_id TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                     WHERE table_name = 'event_outbox' AND column_name = 'lease_expires_at') THEN
        ALTER TABLE event_outbox ADD COLUMN lease_expires_at TIMESTAMPTZ;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                     WHERE table_name = 'event_outbox' AND column_name = 'next_attempt_at') THEN
        ALTER TABLE event_outbox ADD COLUMN next_attempt_at TIMESTAMPTZ;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                     WHERE table_name = 'event_outbox' AND column_name = 'trace_id') THEN
        ALTER TABLE event_outbox ADD COLUMN trace_id TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                     WHERE table_name = 'event_outbox' AND column_name = 'span_id') THEN
        ALTER TABLE event_outbox ADD COLUMN span_id TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                     WHERE table_name = 'event_outbox' AND column_name = 'tracestate') THEN
        ALTER TABLE event_outbox ADD COLUMN tracestate TEXT;
      END IF;

      -- Ensure the status CHECK constraint allows the new 'dead_letter' value.
      FOR c IN SELECT conname FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname = 'event_outbox' AND con.contype = 'c' LOOP
        BEGIN
          EXECUTE format('ALTER TABLE event_outbox DROP CONSTRAINT %I', c.conname);
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END LOOP;

      BEGIN
        EXECUTE 'ALTER TABLE event_outbox ADD CONSTRAINT event_outbox_status_check CHECK (status IN (''pending'', ''processing'', ''published'', ''failed'', ''dead_letter''))';
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END $$;
  `)

  // Create indexes
  for (const index of OUTBOX_INDEXES) {
    await db.query(index)
  }
}

export async function dropOutboxSchema(db: Queryable): Promise<void> {
  await db.query('DROP TABLE IF EXISTS event_outbox')
}
