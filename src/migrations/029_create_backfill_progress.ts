import type { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: Create backfill_progress table for durable backfill checkpoints.
 *
 * Purpose: Persist progress markers so long-running backfill jobs can resume
 *          from the last committed cursor after a crash or process restart.
 * Risk Level: Low (new table only; no locks on existing hot tables)
 * Estimated Runtime: < 1s
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS backfill_progress (
      job_name        TEXT        PRIMARY KEY,
      cursor_value    TEXT        NOT NULL DEFAULT '',
      rows_processed  BIGINT      NOT NULL DEFAULT 0
                                CHECK (rows_processed >= 0),
      total_rows      BIGINT      CHECK (total_rows IS NULL OR total_rows >= 0),
      status          TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      last_error      TEXT,
      metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_backfill_progress_status
      ON backfill_progress (status);

    CREATE INDEX IF NOT EXISTS idx_backfill_progress_updated_at
      ON backfill_progress (updated_at DESC);

    COMMENT ON TABLE backfill_progress IS
      'Durable progress markers for resumable long-running backfill jobs';
    COMMENT ON COLUMN backfill_progress.job_name IS
      'Stable unique identifier for the backfill job (e.g. tenant_id_backfill)';
    COMMENT ON COLUMN backfill_progress.cursor_value IS
      'Opaque last-committed watermark/cursor used to resume after restart';
    COMMENT ON COLUMN backfill_progress.rows_processed IS
      'Cumulative rows successfully processed and checkpointed';
    COMMENT ON COLUMN backfill_progress.total_rows IS
      'Optional estimated total rows for progress reporting';
    COMMENT ON COLUMN backfill_progress.status IS
      'Lifecycle status: pending | running | completed | failed';
  `)
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS backfill_progress;`)
}
