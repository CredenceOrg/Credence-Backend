import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: __MIGRATION_NAME__
 * 
 * Category: [Safe/Medium/High Risk]
 * Estimated Runtime: [X minutes/hours]
 * Rollback Complexity: [Low/Medium/High]
 * 
 * Dependencies: [List any prerequisite migrations]
 * Impact: [Tables affected, rows estimated]
 * 
 * Monitoring Required: [Yes/No]
 * DB Team Approval: [Yes/No]
 * 
 * Batching Strategy: [None/Application-level/SQL-based]
 * Lock Timeout: [30s/5min/30min]
 * 
 * Guidelines for this migration:
 * - Use CONCURRENTLY for indexes on tables >100K rows
 * - Batch operations affecting >10K rows
 * - Set appropriate timeouts for each operation type
 * - Test rollback in staging before production
 * - Monitor database performance during execution
 * 
 * Rollback Checklist:
 * - [ ] Down migration tested in staging
 * - [ ] Data backup strategy confirmed
 * - [ ] Application compatibility verified
 * - [ ] Monitoring alerts configured
 * - [ ] Emergency procedures documented
 * 
 * Created: __TIMESTAMP__
 * Author: __AUTHOR__
 */

/**
 * Apply the migration
 * 
 * This function is called when running `npm run migrate`.
 * It should create tables, add columns, indexes, etc.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Set appropriate timeouts for this migration
  pgm.sql('SET LOCAL statement_timeout = 300000') // 5 minutes for data operations
  pgm.sql('SET LOCAL lock_timeout = 30000')     // 30 seconds for lock acquisition
  
  // TODO: Add your up migration here
  // 
  // Examples with guardrails:
  //
  // 1. Safe column addition:
  // pgm.addColumn('users', 'email_verified', { 
  //   type: 'boolean', 
  //   null: true,
  //   default: false,
  //   comment: 'Email verification status - will be backfilled in batches'
  // })
  //
  // 2. Safe index creation:
  // pgm.sql('SET LOCAL statement_timeout = 1800000') // 30 minutes for large index
  // pgm.createIndex('large_table', 'column_name', { 
  //   method: 'CONCURRENTLY',
  //   name: 'idx_large_table_column_concurrent'
  // })
  //
  // 3. Batched update (for >10K rows):
  // pgm.sql(`
  //   DO $$
  //   DECLARE
  //       batch_size INT := 1000;
  //       processed INT := 0;
  //       total INT;
  //   BEGIN
  //       SELECT COUNT(*) INTO total FROM users WHERE email IS NOT NULL AND email_verified IS NULL;
  //       
  //       WHILE processed < total LOOP
  //           UPDATE users 
  //           SET email_verified = true 
  //           WHERE id IN (
  //               SELECT id FROM users 
  //               WHERE email IS NOT NULL AND email_verified IS NULL 
  //               LIMIT batch_size
  //           );
  //           
  //           processed := processed + batch_size;
  //           COMMIT; -- Commit every batch to avoid long transactions
  //       END LOOP;
  //   END $$;
  // `)
  //
  // 4. Complex data migration:
  // pgm.sql(`
  //   -- Create temporary table for migration
  //   CREATE TABLE temp_user_migration AS 
  //   SELECT id, email, created_at FROM users WHERE email IS NOT NULL;
  //   
  //   -- Add index for faster processing
  //   CREATE INDEX temp_user_migration_idx ON temp_user_migration(id);
  //   
  //   -- Process in batches
  //   INSERT INTO user_profiles (user_id, email, created_at)
  //   SELECT id, email, created_at FROM temp_user_migration
  //   ON CONFLICT (user_id) DO NOTHING;
  //   
  //   -- Cleanup
  //   DROP TABLE temp_user_migration;
  // `)
  //
  // See: https://salsita.github.io/node-pg-migrate/#/migrations
}

/**
 * Rollback the migration
 * 
 * This function is called when running `npm run migrate:down`.
 * It should reverse all changes made by up().
 * 
 * Rollback Requirements:
 * - Must be tested in staging
 * - Should handle partial completion scenarios
 * - Must not leave the database in inconsistent state
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  // Set appropriate timeouts for rollback
  pgm.sql('SET LOCAL statement_timeout = 300000') // 5 minutes for rollback
  pgm.sql('SET LOCAL lock_timeout = 30000')     // 30 seconds for lock acquisition
  
  // TODO: Add your down migration here (reverse of up)
  //
  // Examples:
  //
  // 1. Safe column removal:
  // pgm.dropColumn('users', 'email_verified')
  //
  // 2. Safe index removal:
  // pgm.dropIndex('large_table', 'column_name', { 
  //   name: 'idx_large_table_column_concurrent'
  // })
  //
  // 3. Data rollback (may need careful consideration):
  // pgm.sql(`
  //   UPDATE users 
  //   SET email_verified = NULL 
  //   WHERE email_verified = true 
  //   AND updated_at > '2024-01-01'::timestamp
  // `)
  //
  // 4. Complex rollback with validation:
  // pgm.sql(`
  //   -- Verify data integrity before rollback
  //   DO $$
  //   BEGIN
  //       IF EXISTS (SELECT 1 FROM user_profiles WHERE user_id NOT IN (SELECT id FROM users)) THEN
  //           RAISE EXCEPTION 'Cannot rollback: orphaned user_profiles detected';
  //       END IF;
  //   END $$;
  //   
  //   -- Perform rollback
  //   TRUNCATE user_profiles;
  // `)
  //
  // IMPORTANT: Always test rollback in staging before production deployment!
}

/**
 * Optional: Migration validation function
 * 
 * This can be used to verify the migration completed successfully
 * and data is in expected state.
 */
export async function validate(pgm: MigrationBuilder): Promise<boolean> {
  // TODO: Add validation logic
  //
  // Examples:
  //
  // 1. Verify column exists and has correct properties:
  // const result = pgm.sql(`
  //   SELECT column_name, data_type, is_nullable 
  //   FROM information_schema.columns 
  //   WHERE table_name = 'users' AND column_name = 'email_verified'
  // `)
  // return result.rows.length > 0
  //
  // 2. Verify data integrity:
  // const result = pgm.sql(`
  //   SELECT COUNT(*) as count 
  //   FROM users 
  //   WHERE email IS NOT NULL AND email_verified IS NULL
  // `)
  // return parseInt(result.rows[0].count) === 0
  //
  // 3. Verify index exists:
  // const result = pgm.sql(`
  //   SELECT indexname FROM pg_indexes 
  //   WHERE tablename = 'large_table' AND indexname = 'idx_large_table_column_concurrent'
  // `)
  // return result.rows.length > 0
  
  return true
}
