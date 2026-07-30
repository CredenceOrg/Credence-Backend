/**
 * Migration Rollback Checklist Utilities
 * 
 * Provides comprehensive rollback validation and checklist management
 * for database migrations.
 */

import { MigrationBuilder } from 'node-pg-migrate'

export interface RollbackChecklist {
  migrationName: string
  migrationId: string
  createdAt: string
  author: string
  
  // Pre-deployment checks
  preDeployment: {
    downMigrationTested: boolean
    rollbackScriptReviewed: boolean
    dataBackupConfirmed: boolean
    appCompatibilityVerified: boolean
    monitoringConfigured: boolean
  }
  
  // Deployment checks
  deployment: {
    performanceMonitored: boolean
    lockActivityWatched: boolean
    replicationLagChecked: boolean
    errorRatesTracked: boolean
  }
  
  // Post-deployment checks
  postDeployment: {
    migrationMarkedComplete: boolean
    monitoringContinued: boolean
    rollbackWindowDocumented: boolean
    successCriteriaMet: boolean
  }
  
  // Risk assessment
  riskLevel: 'low' | 'medium' | 'high'
  rollbackComplexity: 'simple' | 'moderate' | 'complex'
  dataLossRisk: 'none' | 'minimal' | 'significant'
  
  // Dependencies
  dependencies: string[]
  dependentMigrations: string[]
}

export interface RollbackValidation {
  isValid: boolean
  errors: string[]
  warnings: string[]
  recommendations: string[]
}

/**
 * Create a new rollback checklist
 */
export function createRollbackChecklist(
  migrationName: string,
  migrationId: string,
  author: string,
  riskLevel: 'low' | 'medium' | 'high' = 'medium'
): RollbackChecklist {
  return {
    migrationName,
    migrationId,
    createdAt: new Date().toISOString(),
    author,
    
    preDeployment: {
      downMigrationTested: false,
      rollbackScriptReviewed: false,
      dataBackupConfirmed: false,
      appCompatibilityVerified: false,
      monitoringConfigured: false
    },
    
    deployment: {
      performanceMonitored: false,
      lockActivityWatched: false,
      replicationLagChecked: false,
      errorRatesTracked: false
    },
    
    postDeployment: {
      migrationMarkedComplete: false,
      monitoringContinued: false,
      rollbackWindowDocumented: false,
      successCriteriaMet: false
    },
    
    riskLevel,
    rollbackComplexity: riskLevel === 'low' ? 'simple' : riskLevel === 'high' ? 'complex' : 'moderate',
    dataLossRisk: 'none',
    dependencies: [],
    dependentMigrations: []
  }
}

/**
 * Validate rollback checklist completeness
 */
export function validateRollbackChecklist(checklist: RollbackChecklist): RollbackValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const recommendations: string[] = []
  
  // Check pre-deployment requirements
  const preDeploymentComplete = Object.values(checklist.preDeployment).every(Boolean)
  if (!preDeploymentComplete) {
    const incomplete = Object.entries(checklist.preDeployment)
      .filter(([_, complete]) => !complete)
      .map(([key]) => key)
    
    errors.push(`Pre-deployment checklist incomplete: ${incomplete.join(', ')}`)
  }
  
  // High-risk migrations require additional checks
  if (checklist.riskLevel === 'high') {
    if (!checklist.preDeployment.dataBackupConfirmed) {
      errors.push('Data backup confirmation required for high-risk migrations')
    }
    if (!checklist.preDeployment.rollbackScriptReviewed) {
      errors.push('Rollback script review required for high-risk migrations')
    }
  }
  
  // Check for rollback complexity warnings
  if (checklist.rollbackComplexity === 'complex') {
    warnings.push('Complex rollback detected - ensure comprehensive testing')
    recommendations.push('Consider creating a rollback simulation script')
  }
  
  // Check data loss risk
  if (checklist.dataLossRisk === 'significant') {
    warnings.push('Significant data loss risk - ensure backup verification')
    recommendations.push('Create data verification script before rollback')
  }
  
  // Check dependencies
  if (checklist.dependencies.length > 0) {
    warnings.push(`Migration has ${checklist.dependencies.length} dependencies - verify rollback order`)
  }
  
  if (checklist.dependentMigrations.length > 0) {
    warnings.push(`Migration has ${checklist.dependentMigrations.length} dependent migrations - may affect rollback`)
  }
  
  const isValid = errors.length === 0
  
  return {
    isValid,
    errors,
    warnings,
    recommendations
  }
}

/**
 * Generate rollback checklist markdown
 */
export function generateRollbackChecklistMarkdown(checklist: RollbackChecklist): string {
  const validation = validateRollbackChecklist(checklist)
  
  let markdown = `# Rollback Checklist - ${checklist.migrationName}\n\n`
  markdown += `**Migration ID:** ${checklist.migrationId}\n`
  markdown += `**Author:** ${checklist.author}\n`
  markdown += `**Created:** ${checklist.createdAt}\n`
  markdown += `**Risk Level:** ${checklist.riskLevel.toUpperCase()}\n`
  markdown += `**Rollback Complexity:** ${checklist.rollbackComplexity.toUpperCase()}\n`
  markdown += `**Data Loss Risk:** ${checklist.dataLossRisk.toUpperCase()}\n\n`
  
  // Validation status
  if (validation.isValid) {
    markdown += `✅ **Checklist Valid**\n\n`
  } else {
    markdown += `❌ **Checklist Invalid** - ${validation.errors.length} errors\n\n`
  }
  
  // Pre-deployment checklist
  markdown += `## Pre-Deployment Checklist\n\n`
  Object.entries(checklist.preDeployment).forEach(([key, value]) => {
    const status = value ? '✅' : '❌'
    const label = formatLabel(key)
    markdown += `- ${status} **${label}**\n`
  })
  markdown += `\n`
  
  // Deployment checklist
  markdown += `## Deployment Checklist\n\n`
  Object.entries(checklist.deployment).forEach(([key, value]) => {
    const status = value ? '✅' : '❌'
    const label = formatLabel(key)
    markdown += `- ${status} **${label}**\n`
  })
  markdown += `\n`
  
  // Post-deployment checklist
  markdown += `## Post-Deployment Checklist\n\n`
  Object.entries(checklist.postDeployment).forEach(([key, value]) => {
    const status = value ? '✅' : '❌'
    const label = formatLabel(key)
    markdown += `- ${status} **${label}**\n`
  })
  markdown += `\n`
  
  // Dependencies
  if (checklist.dependencies.length > 0) {
    markdown += `## Dependencies\n\n`
    checklist.dependencies.forEach(dep => {
      markdown += `- ${dep}\n`
    })
    markdown += `\n`
  }
  
  // Dependent migrations
  if (checklist.dependentMigrations.length > 0) {
    markdown += `## Dependent Migrations\n\n`
    checklist.dependentMigrations.forEach(dep => {
      markdown += `- ${dep}\n`
    })
    markdown += `\n`
  }
  
  // Validation results
  if (validation.errors.length > 0) {
    markdown += `## Errors\n\n`
    validation.errors.forEach(error => {
      markdown += `- ❌ ${error}\n`
    })
    markdown += `\n`
  }
  
  if (validation.warnings.length > 0) {
    markdown += `## Warnings\n\n`
    validation.warnings.forEach(warning => {
      markdown += `- ⚠️ ${warning}\n`
    })
    markdown += `\n`
  }
  
  if (validation.recommendations.length > 0) {
    markdown += `## Recommendations\n\n`
    validation.recommendations.forEach(rec => {
      markdown += `- 💡 ${rec}\n`
    })
    markdown += `\n`
  }
  
  return markdown
}

/**
 * Format checklist labels for display
 */
function formatLabel(key: string): string {
  const labels: Record<string, string> = {
    downMigrationTested: 'Down migration tested in staging',
    rollbackScriptReviewed: 'Rollback script reviewed by DB team',
    dataBackupConfirmed: 'Data backup strategy confirmed',
    appCompatibilityVerified: 'Application compatibility verified',
    monitoringConfigured: 'Monitoring alerts configured',
    performanceMonitored: 'Database performance monitored',
    lockActivityWatched: 'Lock activity watched',
    replicationLagChecked: 'Replication lag checked',
    errorRatesTracked: 'Application error rates tracked',
    migrationMarkedComplete: 'Migration marked as complete',
    monitoringContinued: 'Monitoring continued for 24 hours',
    rollbackWindowDocumented: 'Rollback window documented',
    successCriteriaMet: 'Success criteria met'
  }
  
  return labels[key] || key
}

/**
 * Analyze migration for rollback complexity
 */
export function analyzeRollbackComplexity(migrationContent: string): {
  complexity: 'simple' | 'moderate' | 'complex'
  riskLevel: 'low' | 'medium' | 'high'
  dataLossRisk: 'none' | 'minimal' | 'significant'
  issues: string[]
} {
  const issues: string[] = []
  let complexity: 'simple' | 'moderate' | 'complex' = 'simple'
  let riskLevel: 'low' | 'medium' | 'high' = 'low'
  let dataLossRisk: 'none' | 'minimal' | 'significant' = 'none'
  
  // Check for destructive operations
  if (/DROP\s+TABLE/i.test(migrationContent)) {
    complexity = 'complex'
    riskLevel = 'high'
    dataLossRisk = 'significant'
    issues.push('Contains DROP TABLE - complex rollback with data loss risk')
  }
  
  if (/DROP\s+COLUMN/i.test(migrationContent)) {
    complexity = 'moderate'
    riskLevel = 'medium'
    dataLossRisk = 'minimal'
    issues.push('Contains DROP COLUMN - moderate rollback complexity')
  }
  
  // Check for data modifications
  if (/UPDATE.*SET.*WHERE/i.test(migrationContent)) {
    complexity = 'moderate'
    riskLevel = 'medium'
    dataLossRisk = 'minimal'
    issues.push('Contains data updates - requires careful rollback planning')
  }
  
  if (/DELETE.*WHERE/i.test(migrationContent)) {
    complexity = 'moderate'
    riskLevel = 'medium'
    dataLossRisk = 'minimal'
    issues.push('Contains data deletion - requires backup verification')
  }
  
  // Check for index creation
  if (/CREATE\s+INDEX.*CONCURRENTLY/i.test(migrationContent)) {
    complexity = 'moderate'
    riskLevel = 'medium'
    dataLossRisk = 'none'
    issues.push('Contains index creation - moderate rollback time')
  }
  
  // Check for constraint additions
  if (/ADD\s+CONSTRAINT/i.test(migrationContent)) {
    complexity = 'moderate'
    riskLevel = 'medium'
    dataLossRisk = 'none'
    issues.push('Contains constraint addition - moderate rollback complexity')
  }
  
  // Check for missing down function
  if (!/export\s+async\s+function\s+down/i.test(migrationContent)) {
    complexity = 'complex'
    riskLevel = 'high'
    dataLossRisk = 'significant'
    issues.push('Missing down function - cannot rollback safely')
  }
  
  // Check for complex logic
  if (/DO\s+\$\$/i.test(migrationContent)) {
    complexity = 'complex'
    riskLevel = 'medium'
    issues.push('Contains complex PL/pgSQL logic - complex rollback')
  }
  
  return {
    complexity,
    riskLevel,
    dataLossRisk,
    issues
  }
}

/**
 * Create rollback checklist from migration analysis
 */
export function createChecklistFromMigration(
  migrationName: string,
  migrationId: string,
  migrationContent: string,
  author: string
): RollbackChecklist {
  const analysis = analyzeRollbackComplexity(migrationContent)
  
  const checklist = createRollbackChecklist(
    migrationName,
    migrationId,
    author,
    analysis.riskLevel
  )
  
  checklist.rollbackComplexity = analysis.complexity
  checklist.dataLossRisk = analysis.dataLossRisk
  
  return checklist
}

/**
 * Store rollback checklist in database
 */
export function storeRollbackChecklist(
  pgm: MigrationBuilder,
  checklist: RollbackChecklist
): void {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS migration_rollbacks (
      id SERIAL PRIMARY KEY,
      migration_name VARCHAR(255) NOT NULL,
      migration_id VARCHAR(255) NOT NULL,
      checklist JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    
    INSERT INTO migration_rollbacks (migration_name, migration_id, checklist)
    VALUES ('${checklist.migrationName}', '${checklist.migrationId}', '${JSON.stringify(checklist)}')
    ON CONFLICT (migration_id) 
    DO UPDATE SET 
      checklist = EXCLUDED.checklist,
      updated_at = NOW();
  `)
}

/**
 * Retrieve rollback checklist from database
 */
export function getRollbackChecklist(
  pgm: MigrationBuilder,
  migrationId: string
): Promise<RollbackChecklist | null> {
  return pgm.sql(`
    SELECT checklist FROM migration_rollbacks 
    WHERE migration_id = '${migrationId}'
    ORDER BY updated_at DESC
    LIMIT 1
  `) as Promise<RollbackChecklist | null>
}

/**
 * Update checklist item
 */
export function updateChecklistItem(
  pgm: MigrationBuilder,
  migrationId: string,
  section: 'preDeployment' | 'deployment' | 'postDeployment',
  item: string,
  value: boolean
): void {
  pgm.sql(`
    UPDATE migration_rollbacks 
    SET checklist = jsonb_set(
      checklist,
      '{${section},${item}}',
      '${value}'::jsonb,
      true
    ),
    updated_at = NOW()
    WHERE migration_id = '${migrationId}';
  `)
}

/**
 * Generate rollback verification script
 */
export function generateRollbackVerification(
  pgm: MigrationBuilder,
  checklist: RollbackChecklist
): void {
  const verificationScript = `
-- Rollback Verification Script for ${checklist.migrationName}
-- Generated: ${new Date().toISOString()}

-- Step 1: Verify migration status
SELECT 
  version,
  name,
  run_on
FROM schema_migrations 
WHERE name = '${checklist.migrationId}';

-- Step 2: Check for data consistency
DO $$
DECLARE
    error_count INTEGER := 0;
BEGIN
    -- Add specific data consistency checks here
    -- This is a template - customize based on your migration
    
    -- Example: Check for orphaned records
    -- SELECT COUNT(*) INTO error_count FROM child_table WHERE parent_id NOT IN (SELECT id FROM parent_table);
    
    IF error_count > 0 THEN
        RAISE EXCEPTION 'Data consistency check failed: % errors found', error_count;
    ELSE
        RAISE NOTICE 'Data consistency check passed';
    END IF;
END $$;

-- Step 3: Verify application compatibility
-- This would typically involve application-level checks
RAISE NOTICE 'Application compatibility verification required';

-- Step 4: Check database performance metrics
SELECT 
  datname,
  numbackends,
  xact_commit,
  xact_rollback,
  blks_read,
  blks_hit,
  tup_returned,
  tup_fetched,
  tup_inserted,
  tup_updated,
  tup_deleted
FROM pg_stat_database 
WHERE datname = current_database();

-- Step 5: Verify no blocking locks
SELECT 
  pg_locks.pid,
  pg_class.relname,
  pg_locks.mode,
  pg_locks.granted
FROM pg_locks
JOIN pg_class ON pg_locks.relation = pg_class.oid
WHERE pg_locks.datname = current_database()
AND NOT pg_locks.granted;

RAISE NOTICE 'Rollback verification completed for ${checklist.migrationName}';
`

  pgm.sql(verificationScript)
}
