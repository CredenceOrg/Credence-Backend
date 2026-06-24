import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: Add version column to identities table for optimistic locking
 *
 * Description: Adds a version column to the identities table to support
 * optimistic locking for profile updates, preventing lost updates when
 * multiple clients update profiles concurrently.
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add version column with default value of 1 for existing rows
  pgm.addColumn('identities', {
    version: {
      type: 'integer',
      notNull: true,
      default: 1,
    },
  })

  // Add constraint to ensure version is always positive
  pgm.addConstraint('identities', 'identities_version_positive', {
    check: 'version > 0',
  })

  // Add index on version for faster optimistic locking queries
  pgm.createIndex('identities', 'version')
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Remove index first
  pgm.dropIndex('identities', 'version')

  // Remove constraint
  pgm.dropConstraint('identities', 'identities_version_positive')

  // Remove column
  pgm.dropColumn('identities', 'version')
}
