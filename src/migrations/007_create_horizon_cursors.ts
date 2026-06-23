import type { Pool } from 'pg'

/**
 * Migration: Create horizon_cursors table for durable Horizon stream checkpointing.
 * 
 * This table stores the last successfully processed paging_token for each Horizon
 * event stream (bond_creation, bond_withdrawal, attestation), enabling gap-free
 * resume after process restart, crash, or redeploy.
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS horizon_cursors (
      stream_name       TEXT        PRIMARY KEY,
      paging_token      TEXT        NOT NULL,
      last_checkpoint   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Index for monitoring cursor lag and checkpoint freshness
    CREATE INDEX IF NOT EXISTS idx_horizon_cursors_last_checkpoint 
      ON horizon_cursors(last_checkpoint DESC);

    -- Add comment for documentation
    COMMENT ON TABLE horizon_cursors IS 
      'Durable checkpoint storage for Horizon event stream cursors';
    COMMENT ON COLUMN horizon_cursors.stream_name IS 
      'Unique identifier for the stream (e.g., bond_creation, bond_withdrawal, attestation)';
    COMMENT ON COLUMN horizon_cursors.paging_token IS 
      'Last successfully processed Horizon paging_token for this stream';
    COMMENT ON COLUMN horizon_cursors.last_checkpoint IS 
      'Timestamp when this cursor was last updated';
  `)
}

/**
 * Rollback: Drop horizon_cursors table.
 */
export async function down(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS horizon_cursors;')
}
