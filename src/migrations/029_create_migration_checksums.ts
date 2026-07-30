import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: 029_create_migration_checksums
 *
 * Stores SHA-256 checksums of applied migration files so startup validation
 * can detect silent drift when migration sources are modified post-deployment.
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('migration_checksums', {
    name: {
      type: 'varchar(255)',
      primaryKey: true,
      notNull: true,
      comment: 'Migration name as recorded in pgmigrations (filename without extension)',
    },
    checksum: {
      type: 'varchar(64)',
      notNull: true,
      comment: 'SHA-256 hex digest of the migration source file at apply time',
    },
    recorded_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
      comment: 'When this checksum was last recorded',
    },
  })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('migration_checksums')
}
