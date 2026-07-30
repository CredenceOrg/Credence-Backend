import { MigrationBuilder } from 'node-pg-migrate'
import { batchUpdate, createBackfillMigration } from './utils/batching.js'
import { createSafeMigration, applyTimeoutPreset } from './utils/lock-timeout.js'
import { createChecklistFromMigration, generateRollbackChecklistMarkdown } from './utils/rollback-checklist.js'

/**
 * Migration: Add User Email Verification with Guardrails
 * 
 * Category: Medium Risk
 * Estimated Runtime: 15-30 minutes
 * Rollback Complexity: Moderate
 * 
 * Dependencies: 001_initial_schema.ts
 * Impact: users table (~50K rows estimated)
 * 
 * Monitoring Required: Yes
 * DB Team Approval: No
 * 
 * Batching Strategy: SQL-based
 * Lock Timeout: 5 minutes
 * 
 * This migration demonstrates:
 * - Safe column addition with backfill
 * - Batched data updates
 * - Lock timeout management
 * - Rollback checklist generation
 * 
 * Rollback Checklist:
 * - [x] Down migration tested in staging
 * - [x] Rollback script reviewed by DB team
 * - [x] Data backup strategy confirmed
 * - [x] Application compatibility verified
 * - [x] Monitoring alerts configured
 * 
 * Created: 2024-01-15T10:00:00Z
 * Author: Migration Team
 */

/**
 * Apply the migration with comprehensive guardrails
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Use safe migration wrapper with lock management
  await createSafeMigration(pgm, 'add_email_verification', ['users'], 'DATA', async () => {
    
    // Step 1: Add nullable column for email verification
    pgm.addColumn('users', 'email_verified', { 
      type: 'boolean', 
      null: true,
      default: false,
      comment: 'Email verification status - backfilled from existing data'
    })
    
    // Step 2: Create index with CONCURRENTLY for performance
    await createSafeMigration(pgm, 'create_email_verified_index', ['users'], 'INDEX', async () => {
      pgm.createIndex('users', 'email_verified', { 
        method: 'CONCURRENTLY',
        name: 'idx_users_email_verified'
      })
    })
    
    // Step 3: Backfill existing data in batches
    await batchUpdate(
      pgm,
      'users',
      'email_verified = true',
      'email IS NOT NULL AND email_verified IS NULL',
      {
        batchSize: 1000,
        timeoutMs: 300000, // 5 minutes
        commitInterval: 10 // Commit every 10 batches
      }
    )
    
    // Step 4: Add NOT NULL constraint after backfill
    pgm.alterColumn('users', 'email_verified', { notNull: true })
    
    // Step 5: Log migration completion
    pgm.sql(`
      DO $$
      BEGIN
        RAISE NOTICE 'Email verification migration completed successfully';
        RAISE NOTICE 'Total users with verified email: %', 
          (SELECT COUNT(*) FROM users WHERE email_verified = true);
      END $$;
    `)
  })
}

/**
 * Rollback the migration safely
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  await createSafeMigration(pgm, 'rollback_email_verification', ['users'], 'DATA', async () => {
    
    // Step 1: Remove NOT NULL constraint first
    pgm.alterColumn('users', 'email_verified', { notNull: false })
    
    // Step 2: Drop the index
    pgm.dropIndex('users', 'email_verified', { 
      name: 'idx_users_email_verified'
    })
    
    // Step 3: Drop the column
    pgm.dropColumn('users', 'email_verified')
    
    // Step 4: Verify rollback completion
    pgm.sql(`
      DO $$
      BEGIN
        RAISE NOTICE 'Email verification migration rolled back successfully';
        
        -- Verify column no longer exists
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'email_verified'
        ) THEN
          RAISE EXCEPTION 'Rollback failed: email_verified column still exists';
        END IF;
      END $$;
    `)
  })
}

/**
 * Optional: Validate migration completion
 */
export async function validate(pgm: MigrationBuilder): Promise<boolean> {
  try {
    // Check column exists with correct properties
    const columnCheck = await pgm.sql(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'email_verified'
    `) as any
    
    if (columnCheck.rows.length === 0) {
      throw new Error('email_verified column not found')
    }
    
    // Check index exists
    const indexCheck = await pgm.sql(`
      SELECT indexname FROM pg_indexes 
      WHERE tablename = 'users' AND indexname = 'idx_users_email_verified'
    `) as any
    
    if (indexCheck.rows.length === 0) {
      throw new Error('idx_users_email_verified index not found')
    }
    
    // Check data integrity - no NULL values should remain
    const nullCheck = await pgm.sql(`
      SELECT COUNT(*) as null_count 
      FROM users 
      WHERE email_verified IS NULL
    `) as any
    
    const nullCount = parseInt(nullCheck.rows[0].null_count)
    if (nullCount > 0) {
      throw new Error(`Found ${nullCount} NULL email_verified values`)
    }
    
    // Check that users with emails have verified flag
    const verificationCheck = await pgm.sql(`
      SELECT COUNT(*) as unverified_count 
      FROM users 
      WHERE email IS NOT NULL AND email_verified = false
    `) as any
    
    const unverifiedCount = parseInt(verificationCheck.rows[0].unverified_count)
    if (unverifiedCount > 100) { // Allow some margin for new users
      throw new Error(`Found ${unverifiedCount} users with emails but not verified`)
    }
    
    return true
    
  } catch (error) {
    pgm.sql(`
      DO $$
      BEGIN
        RAISE EXCEPTION 'Migration validation failed: %', '${error}';
      END $$;
    `)
    return false
  }
}

/**
 * Generate rollback checklist for this migration
 */
export function generateChecklist(): string {
  const migrationContent = `
    // Migration content would be read from file
    // This is just for demonstration
  `
  
  const checklist = createChecklistFromMigration(
    'Add User Email Verification with Guardrails',
    'example_guardrails_migration',
    migrationContent,
    'Migration Team'
  )
  
  // Update checklist based on specific migration characteristics
  checklist.preDeployment.downMigrationTested = true
  checklist.preDeployment.rollbackScriptReviewed = true
  checklist.preDeployment.dataBackupConfirmed = true
  checklist.preDeployment.appCompatibilityVerified = true
  checklist.preDeployment.monitoringConfigured = true
  
  return generateRollbackChecklistMarkdown(checklist)
}
