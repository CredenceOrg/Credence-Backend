import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: Create settlement_reconciliation_findings table
 * 
 * Purpose: Stores settlement reconciliation mismatches between internal and on-chain state.
 * Risk Level: Low (creates a new table with indexes; does not block existing tables or write paths)
 * Estimated Runtime: < 1s
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('settlement_reconciliation_findings', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    settlement_id: {
      type: 'uuid',
      notNull: true,
      references: 'settlements(id)',
      onDelete: 'CASCADE',
    },
    finding_type: {
      type: 'varchar(64)',
      notNull: true,
    },
    details: {
      type: 'jsonb',
      notNull: true,
      default: "'{}'::jsonb",
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  })

  // Add composite unique constraint to prevent duplicate active findings of the same type for a settlement
  pgm.addConstraint('settlement_reconciliation_findings', 'settlement_findings_unique', {
    unique: ['settlement_id', 'finding_type']
  })

  // Indexes for fast diagnosis/auditing queries
  pgm.createIndex('settlement_reconciliation_findings', 'settlement_id')
  pgm.createIndex('settlement_reconciliation_findings', [{ name: 'created_at', sort: 'DESC' }])
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('settlement_reconciliation_findings')
}
