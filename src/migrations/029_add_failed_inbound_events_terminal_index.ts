import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: Add partial index for failed_inbound_events terminal-state sweep
 *
 * Description:
 *   `FailedInboundEventsSweeper` (src/jobs/failedInboundEventsSweeper.ts) runs
 *   hourly and, on every run, calls `countTerminalEvents` /
 *   `deleteTerminalEvents` (src/db/repositories/failedInboundEventsRepository.ts),
 *   both of which filter:
 *
 *     WHERE status IN ('replayed', 'skipped') AND created_at < $1
 *
 *   The only existing index on this column (`pgm.createIndex('failed_inbound_events',
 *   'status')` from migration 004) is a plain single-column index on a
 *   3-value status enum, which Postgres' planner typically skips in favor of
 *   a sequential scan since each value matches a large fraction of rows.
 *   Migration 006 already added a partial index for the transient
 *   `status = 'failed'` backlog; this migration adds the matching index for
 *   the terminal side of that same query so the retention sweep gets an
 *   Index Scan instead of a Seq Scan as the table grows.
 *
 *   Note: unlike the 006 indexes, `'replayed'`/`'skipped'` are terminal
 *   states rather than a small transient minority, so this index will track
 *   the bulk of the table (bounded by the sweeper's own retention window)
 *   rather than staying tiny — it is still worth it because the (status,
 *   created_at) shape lets the planner satisfy both predicates from the
 *   index directly instead of a full scan.
 *
 * ── Query plan verification ──────────────────────────────────────────────────
 * Run against a populated staging DB before/after applying this migration:
 *
 *   EXPLAIN (ANALYZE, BUFFERS)
 *   SELECT COUNT(*) FROM failed_inbound_events
 *   WHERE status IN ('replayed', 'skipped') AND created_at < NOW() - INTERVAL '30 days';
 *
 * Before: Seq Scan on failed_inbound_events (filter on status, created_at)
 * After:
 *   Aggregate
 *     -> Index Only Scan using idx_failed_inbound_events_terminal_created on failed_inbound_events
 *          Index Cond: (created_at < $1)
 *          Filter: (status = ANY ('{replayed,skipped}'::text[]))
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Impact:   Index is created with CONCURRENTLY so it does not block writes
 *           during creation. IF NOT EXISTS keeps the migration idempotent.
 * Rollback: DROP INDEX CONCURRENTLY IF EXISTS.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_failed_inbound_events_terminal_created " +
      "ON failed_inbound_events (created_at) WHERE status IN ('replayed', 'skipped');"
  )
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP INDEX CONCURRENTLY IF EXISTS idx_failed_inbound_events_terminal_created;')
}
