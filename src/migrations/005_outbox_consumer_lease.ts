import type { Queryable } from '../db/repositories/queryable.js'

/**
 * Add consumer tracking and lease columns to event_outbox for crash-safe processing.
 */
export async function up(db: Queryable): Promise<void> {
  // Add new columns (IF NOT EXISTS for backward compatibility)
  await db.query(`
    ALTER TABLE event_outbox
    ADD COLUMN IF NOT EXISTS consumer_id TEXT
  `)
  await db.query(`
    ALTER TABLE event_outbox
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
  `)

  // Create supporting indexes
  await db.query(`
    CREATE INDEX IF NOT EXISTS event_outbox_consumer_idx
    ON event_outbox (consumer_id, status)
    WHERE consumer_id IS NOT NULL
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS event_outbox_lease_expires_idx
    ON event_outbox (lease_expires_at)
    WHERE status = 'processing'
  `)
}

/**
 * Rollback: drop new indexes and columns.
 */
export async function down(db: Queryable): Promise<void> {
  await db.query('DROP INDEX IF EXISTS event_outbox_consumer_idx')
  await db.query('DROP INDEX IF EXISTS event_outbox_lease_expires_idx')
  await db.query('ALTER TABLE event_outbox DROP COLUMN IF EXISTS consumer_id')
  await db.query('ALTER TABLE event_outbox DROP COLUMN IF EXISTS lease_expires_at')
}
