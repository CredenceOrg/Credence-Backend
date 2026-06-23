/**
 * Migration Guardrails
 * 
 * Provides preflight checks and runtime safeguards for potentially
 * blocking database operations and long-running schema changes.
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

export interface MigrationIssue {
  type: 'blocking' | 'long-running' | 'unsafe' | 'warning'
  message: string
  suggestion: string
  line?: number
  migration?: string
}

export interface PreflightResult {
  passed: boolean
  issues: MigrationIssue[]
  warnings: MigrationIssue[]
}

/**
 * Patterns that indicate potentially blocking operations
 */
const BLOCKING_PATTERNS = [
  {
    pattern: /ADD\s+COLUMN.*NOT\s+NULL/i,
    type: 'blocking' as const,
    message: 'Adding NOT NULL column without default can block writes',
    suggestion: 'Add column as NULL, backfill data, then add NOT NULL constraint'
  },
  {
    pattern: /CREATE\s+UNIQUE\s+INDEX/i,
    type: 'blocking' as const,
    message: 'Creating unique index blocks writes to the table',
    suggestion: 'Use CREATE UNIQUE INDEX CONCURRENTLY or add index without unique constraint first'
  },
  {
    pattern: /ALTER\s+TABLE.*ADD\s+PRIMARY\s+KEY/i,
    type: 'blocking' as const,
    message: 'Adding primary key blocks writes',
    suggestion: 'Use ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY USING INDEX if possible'
  },
  {
    pattern: /ALTER\s+TABLE.*DROP\s+COLUMN/i,
    type: 'blocking' as const,
    message: 'Dropping columns blocks reads and may break applications',
    suggestion: 'Mark column as unused first, then drop in later migration'
  }
]

/**
 * Patterns that indicate long-running operations requiring batching
 */
const LONG_RUNNING_PATTERNS = [
  {
    pattern: /CREATE\s+INDEX.*CONCURRENTLY/i,
    type: 'long-running' as const,
    message: 'Index creation can take significant time on large tables',
    suggestion: 'Monitor progress and ensure adequate maintenance_work_mem'
  },
  {
    pattern: /UPDATE.*SET.*WHERE/i,
    type: 'long-running' as const,
    message: 'Large UPDATE operations can lock rows and cause replication lag',
    suggestion: 'Use batching for operations affecting >10,000 rows'
  },
  {
    pattern: /DELETE.*WHERE/i,
    type: 'long-running' as const,
    message: 'Large DELETE operations can lock rows and bloat transaction logs',
    suggestion: 'Use batching or soft delete approach'
  },
  {
    pattern: /INSERT.*SELECT.*FROM.*WHERE/i,
    type: 'long-running' as const,
    message: 'Large INSERT...SELECT operations can cause significant load',
    suggestion: 'Break into smaller batches or use COPY command'
  }
]

/**
 * Patterns that indicate unsafe operations
 */
const UNSAFE_PATTERNS = [
  {
    pattern: /DROP\s+TABLE/i,
    type: 'unsafe' as const,
    message: 'Dropping tables is destructive',
    suggestion: 'Ensure table is truly unused and backup data if needed'
  },
  {
    pattern: /DROP\s+DATABASE/i,
    type: 'unsafe' as const,
    message: 'Dropping database is extremely destructive',
    suggestion: 'This should never be in a migration script'
  },
  {
    pattern: /TRUNCATE\s+TABLE/i,
    type: 'unsafe' as const,
    message: 'TRUNCATE is destructive and cannot be rolled back',
    suggestion: 'Use DELETE with WHERE clause or ensure data is backed up'
  },
  {
    pattern: /UPDATE.*SET.*WHERE.*LIMIT\s+[0-9]{4,}/i,
    type: 'unsafe' as const,
    message: 'Large UPDATE without batching may cause locks',
    suggestion: 'Use batching utilities or LIMIT with smaller batch sizes'
  }
]

/**
 * Analyze a single migration file for potential issues
 */
export function analyzeMigration(filePath: string): PreflightResult {
  const issues: MigrationIssue[] = []
  const warnings: MigrationIssue[] = []

  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    // Check each pattern against the migration content
    const allPatterns: Array<{ pattern: RegExp; type: MigrationIssue['type']; message: string; suggestion: string }> = [...BLOCKING_PATTERNS, ...LONG_RUNNING_PATTERNS, ...UNSAFE_PATTERNS]

    lines.forEach((line, index) => {
      allPatterns.forEach(({ pattern, type, message, suggestion }) => {
        if (pattern.test(line)) {
          const issue: MigrationIssue = {
            type,
            message,
            suggestion,
            line: index + 1,
            migration: filePath
          }

          if (type === 'warning') {
            warnings.push(issue)
          } else {
            issues.push(issue)
          }
        }
      })
    })

    // Additional checks for migration structure
    checkMigrationStructure(content, filePath, issues, warnings)

  } catch (error) {
    issues.push({
      type: 'unsafe',
      message: `Failed to read migration file: ${error}`,
      suggestion: 'Ensure file exists and is readable',
      migration: filePath
    })
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings
  }
}

/**
 * Check migration structure for best practices
 */
function checkMigrationStructure(
  content: string,
  filePath: string,
  issues: MigrationIssue[],
  warnings: MigrationIssue[]
): void {
  // Check for missing down migration
  if (!content.includes('export async function down')) {
    warnings.push({
      type: 'warning',
      message: 'Migration missing down function',
      suggestion: 'Always provide a rollback strategy',
      migration: filePath
    })
  }

  // Check for missing documentation
  if (!content.includes('/**') || !content.includes('*/')) {
    warnings.push({
      type: 'warning',
      message: 'Migration missing documentation',
      suggestion: 'Add JSDoc comments explaining the migration purpose, risk level, and estimated runtime',
      migration: filePath
    })
  }

  // Check for hardcoded timeouts that might be too short
  const timeoutMatch = content.match(/timeout:\s*(\d+)/i)
  if (timeoutMatch && parseInt(timeoutMatch[1]) < 30000) {
    warnings.push({
      type: 'warning',
      message: 'Timeout might be too short for large operations',
      suggestion: 'Consider using longer timeouts for schema changes (30s+ for DDL, 5min+ for data)',
      migration: filePath
    })
  }

  // Check for batching requirements
  const largeUpdateMatch = content.match(/UPDATE.*SET.*WHERE/i)
  if (largeUpdateMatch && !content.includes('LIMIT') && !content.includes('batch')) {
    warnings.push({
      type: 'warning',
      message: 'Large UPDATE without batching detected',
      suggestion: 'Add LIMIT clause or use batching utilities for operations affecting >10,000 rows',
      migration: filePath
    })
  }

  // Check for lock timeout configuration
  if (!content.includes('statement_timeout') && content.includes('CONCURRENTLY')) {
    warnings.push({
      type: 'warning',
      message: 'Index creation without explicit timeout',
      suggestion: 'Set statement_timeout for CONCURRENTLY index operations',
      migration: filePath
    })
  }
}

/**
 * Analyze all migration files in a directory
 */
export function analyzeAllMigrations(migrationsDir: string): PreflightResult {
  const allIssues: MigrationIssue[] = []
  const allWarnings: MigrationIssue[] = []

  try {
    const files = readdirSync(migrationsDir)
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .sort() // Process in order

    files.forEach(file => {
      const filePath = join(migrationsDir, file)
      const result = analyzeMigration(filePath)
      allIssues.push(...result.issues)
      allWarnings.push(...result.warnings)
    })

  } catch (error) {
    allIssues.push({
      type: 'unsafe',
      message: `Failed to read migrations directory: ${error}`,
      suggestion: 'Ensure migrations directory exists and is readable'
    })
  }

  return {
    passed: allIssues.length === 0,
    issues: allIssues,
    warnings: allWarnings
  }
}

/**
 * Check if migration is safe for online schema change
 */
export function isOnlineSchemaChange(migrationContent: string): boolean {
  const blockingPatterns = BLOCKING_PATTERNS.map(p => p.pattern)
  const hasBlocking = blockingPatterns.some(pattern => pattern.test(migrationContent))
  return !hasBlocking
}

/**
 * Generate migration safety report
 */
export function generateSafetyReport(result: PreflightResult): string {
  let report = '# Migration Safety Report\n\n'

  if (result.passed) {
    report += '✅ All migrations passed safety checks\n\n'
  } else {
    report += '❌ Migration safety issues found\n\n'
  }

  if (result.issues.length > 0) {
    report += '## Issues\n\n'
    result.issues.forEach(issue => {
      report += `### ${issue.type.toUpperCase()}: ${issue.message}\n`
      report += `- **File**: ${issue.migration}\n`
      if (issue.line) report += `- **Line**: ${issue.line}\n`
      report += `- **Suggestion**: ${issue.suggestion}\n\n`
    })
  }

  if (result.warnings.length > 0) {
    report += '## Warnings\n\n'
    result.warnings.forEach(warning => {
      report += `### ${warning.message}\n`
      report += `- **File**: ${warning.migration}\n`
      if (warning.line) report += `- **Line**: ${warning.line}\n`
      report += `- **Suggestion**: ${warning.suggestion}\n\n`
    })
  }

  return report
}
