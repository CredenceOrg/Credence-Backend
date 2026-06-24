import type { Pool } from 'pg'

/**
 * Migration: Create audit_logs table for immutable audit trail.
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_id       TEXT        NOT NULL,
      actor_email    TEXT        NOT NULL,
      action         TEXT        NOT NULL,
      resource_type  TEXT        NOT NULL,
      resource_id    TEXT        NOT NULL,
      details_json   JSONB,
      status         TEXT        NOT NULL DEFAULT 'success',
      ip_address     TEXT,
      error_message  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred_at  ON audit_logs(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id     ON audit_logs(actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action       ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_id  ON audit_logs(resource_id);
  `)
}

/**
 * Rollback: Drop audit_logs table.
 */
export async function down(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS audit_logs;')
}
