import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: [Migration Name]
 * 
 * Description: [Add detailed description of what this migration does]
 * 
 * Impact: [Describe the impact on the database and application]
 * Rollback: [Describe how to rollback this migration]
 * 
 * Safety Notes:
 * - This migration follows online schema change patterns
 * - No blocking operations are used
 * - Rollback strategy has been tested
 * 
 * Created: [Current Timestamp]
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  // TODO: Implement migration logic
  // 
  // SAFETY REMINDERS:
  // - Use CONCURRENTLY for index creation on large tables
  // - Add columns as NULL, backfill, then add NOT NULL constraint
  // - Avoid blocking operations during peak hours
  // - Test rollback procedure
  // 
  // Example safe patterns:
  // pgm.addColumn('table_name', 'new_column', { type: 'text', null: true })
  // pgm.createIndex('table_name', 'column_name', { method: 'CONCURRENTLY' })
  
  // Online schema change pattern example:
  // 1. Add column as nullable
  pgm.addColumn('target_table', 'new_column', { 
    type: 'text', 
    null: true,
    comment: 'Added for migration - will be made NOT NULL in next migration'
  })
  
  // 2. Create index concurrently (if needed)
  // pgm.createIndex('target_table', 'new_column', { 
  //   method: 'CONCURRENTLY',
  //   name: 'idx_target_table_new_column'
  // })
  
  // 3. Note: Backfill data in separate step/application code
  // 4. Add NOT NULL constraint in follow-up migration after backfill
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // TODO: Implement rollback logic
  // This should be the exact reverse of the up migration
  // 
  // Example:
  // pgm.dropIndex('target_table', 'new_column', { name: 'idx_target_table_new_column' })
  // pgm.dropColumn('target_table', 'new_column')
  
  // Rollback for the example above:
  pgm.dropColumn('target_table', 'new_column')
}
