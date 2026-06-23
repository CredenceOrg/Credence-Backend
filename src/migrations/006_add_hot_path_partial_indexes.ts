import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: Add partial indexes for hot-path queries
 *
 * Description:
 *   Adds four partial B-tree indexes that target queries which filter by a
 *   small subset of column values (status / state filters). Partial indexes
 *   keep the index size proportional to the matching rows rather than the
 *   whole table, which keeps lookups for transient or rare states cheap as
 *   the underlying tables grow.
 *
 *   Targets:
 *     - failed_inbound_events  — admin replay list filters by status='failed'
 *     - audit_logs             — admin troubleshooting filters by status='failure'
 *     - report_jobs            — worker polls for status IN ('queued','running')
 *     - settlements            — reconciliation looks up status='pending' per bond
 *
 *   See the PR description (#251) for EXPLAIN ANALYZE verification notes.
 *
 * Impact:   Indexes are created with CONCURRENTLY so they do not block writes
 *           during creation. IF NOT EXISTS keeps the migration idempotent.
 * Rollback: DROP INDEX CONCURRENTLY IF EXISTS for each index.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // failed_inbound_events: admin UI lists events with status='failed' for replay.
  // Most rows transition to 'replayed' / 'skipped', so the partial index stays small.
  pgm.sql(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_failed_inbound_events_status_failed_created " +
      "ON failed_inbound_events (created_at DESC) WHERE status = 'failed';"
  )

  // audit_logs: admin troubleshooting filters by status='failure', ordered by occurred_at DESC.
  // Failures are expected to be a small fraction of total audit events.
  pgm.sql(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_status_failure_time " +
      "ON audit_logs (occurred_at DESC) WHERE status = 'failure';"
  )

  // report_jobs: workers poll for jobs in 'queued' or 'running' state.
  // Completed/failed jobs accumulate over time; the partial index avoids scanning them.
  pgm.sql(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_report_jobs_status_active_created " +
      "ON report_jobs (created_at) WHERE status IN ('queued', 'running');"
  )

  // settlements: reconciliation jobs lookup unsettled rows per bond.
  // 'pending' is a transient state; most rows end up 'settled' or 'failed'.
  pgm.sql(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_settlements_status_pending_bond " +
      "ON settlements (bond_id, settled_at DESC) WHERE status = 'pending';"
  )
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_settlements_status_pending_bond;')
  pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_report_jobs_status_active_created;')
  pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_audit_logs_status_failure_time;')
  pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_failed_inbound_events_status_failed_created;')
}
