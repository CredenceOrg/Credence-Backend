import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: Create settlement_reconciliation_runs table and link findings
 *
 * Purpose: Stores per-run summaries for the settlement reconciler so the admin
 *          API can surface the latest reconciliation result without re-deriving
 *          it from raw findings.
 * Risk Level: Low (creates a new table; adds a nullable FK column to an
 *             existing table — no exclusive lock on the findings table)
 * Estimated Runtime: < 1s
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('settlement_reconciliation_runs', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    checked: {
      type: 'integer',
      notNull: true,
    },
    discrepancies: {
      type: 'integer',
      notNull: true,
    },
    errors: {
      type: 'integer',
      notNull: true,
    },
    run_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  })

  // Fast lookup for "latest run" queries
  pgm.createIndex('settlement_reconciliation_runs', [{ name: 'run_at', sort: 'DESC' }])

  // Add run_id FK to existing findings table (nullable for backward-compat)
  pgm.addColumn('settlement_reconciliation_findings', {
    run_id: {
      type: 'uuid',
      references: 'settlement_reconciliation_runs(id)',
      onDelete: 'SET NULL',
    },
  })

  pgm.createIndex('settlement_reconciliation_findings', 'run_id')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('settlement_reconciliation_findings', 'run_id')
  pgm.dropTable('settlement_reconciliation_runs')
}
