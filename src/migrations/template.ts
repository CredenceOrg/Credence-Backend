import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: __MIGRATION_NAME__
 * 
 * Description: [Add your description here]
 * 
 * Guidelines:
 * - Always wrap migrations in transactions when possible (automatic by default)
 * - Keep migrations idempotent (safe to run multiple times)
 * - Test both up() and down() before committing
 * - Use pgm.sql() for raw SQL when needed
 * - Use pgm helper methods for common operations (createTable, addColumn, etc.)
 * 
 * For long-running operations:
 * - Use batching utilities from utils/batching.ts
 * - Set appropriate timeouts with utils/lock-timeout.ts
 * - Create rollback checklist with utils/rollback-checklist.ts
 * - Use guardrails-template.ts for complex migrations
 * 
 * Created: __TIMESTAMP__
 */

/**
 * Apply the migration
 * 
 * This function is called when running `npm run migrate`.
 * It should create tables, add columns, indexes, etc.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // TODO: Add your up migration here
  // 
  // Examples:
  //
  // 1. Create a table:
  // pgm.createTable('users', {
  //   id: 'id',  // shorthand for serial primary key
  //   email: { type: 'varchar(255)', notNull: true, unique: true },
  //   name: { type: 'varchar(255)', notNull: true },
  //   created_at: { 
  //     type: 'timestamp', 
  //     notNull: true, 
  //     default: pgm.func('current_timestamp') 
  //   },
  // })
  //
  // 2. Add a column (safe pattern):
  // pgm.addColumn('users', 'email_verified', { 
  //   type: 'boolean', 
  //   null: true,
  //   default: false,
  //   comment: 'Email verification status'
  // })
  //
  // 3. Create an index (safe for large tables):
  // pgm.createIndex('users', 'email', { 
  //   method: 'CONCURRENTLY',
  //   name: 'idx_users_email_concurrent'
  // })
  //
  // 4. Batched update (for >10K rows):
  // import { batchUpdate } from './utils/batching'
  // await batchUpdate(pgm, 'users', 'status = \'active\'', 'status = \'pending\'', {
  //   batchSize: 1000,
  //   timeoutMs: 300000
  // })
  //
  // 5. With lock safety:
  // import { createSafeMigration, applyTimeoutPreset } from './utils/lock-timeout'
  // await createSafeMigration(pgm, 'add_email_index', ['users'], 'INDEX', async () => {
  //   pgm.createIndex('users', 'email', { method: 'CONCURRENTLY' })
  // })
  //
  // 6. Run raw SQL:
  // pgm.sql(`INSERT INTO settings (key, value) VALUES ('version', '1.0.0')`)
  //
  // See: https://salsita.github.io/node-pg-migrate/#/migrations
  // See: docs/MIGRATION_GUARDRAILS.md for comprehensive guidelines
}

/**
 * Rollback the migration
 * 
 * This function is called when running `npm run migrate:down`.
 * It should reverse all changes made by up().
 * 
 * Rollback Requirements:
 * - Must be tested in staging environment
 * - Should handle partial completion scenarios
 * - Must not leave database in inconsistent state
 * - Use rollback checklist utilities for complex migrations
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  // TODO: Add your down migration here (reverse of up)
  //
  // Examples:
  //
  // 1. Drop a table:
  // pgm.dropTable('users')
  //
  // 2. Remove a column:
  // pgm.dropColumn('users', 'age')
  //
  // 3. Drop an index:
  // pgm.dropIndex('users', 'email', { name: 'idx_users_email_concurrent' })
  //
  // 4. Reverse raw SQL:
  // pgm.sql(`DELETE FROM settings WHERE key = 'version'`)
  //
  // 5. Complex rollback with validation:
  // import { generateRollbackVerification } from './utils/rollback-checklist'
  // pgm.sql('BEGIN')
  // try {
  //   pgm.dropColumn('users', 'email_verified')
  //   generateRollbackVerification(pgm, checklist)
  //   pgm.sql('COMMIT')
  // } catch (error) {
  //   pgm.sql('ROLLBACK')
  //   throw error
  // }
  //
  // IMPORTANT: Always test rollback in staging before production!
}
