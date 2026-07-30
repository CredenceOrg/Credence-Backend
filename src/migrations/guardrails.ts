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
  /** Stable machine-readable code for CI gates and typed error handling. */
  code?: MigrationLintErrorCode
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
 * Typed error codes for migration lint failures.
 * Used by the CI gate so callers can branch without parsing free-form messages.
 *
 * Threat mitigated: a PR that introduces locking DDL (ADD COLUMN NOT NULL or
 * CREATE UNIQUE INDEX without CONCURRENTLY) can take production tables offline
 * under write load. Without a merge gate, that risk ships unnoticed.
 */
export type MigrationLintErrorCode =
  | 'ADD_COLUMN_NOT_NULL'
  | 'CREATE_UNIQUE_INDEX'
  | 'ADD_PRIMARY_KEY'
  | 'DROP_COLUMN'
  | 'READ_FAILURE'

export type MigrationLintResult =
  | { ok: true; issues: []; warnings: MigrationIssue[] }
  | {
      ok: false
      code: MigrationLintErrorCode
      message: string
      issues: MigrationIssue[]
      warnings: MigrationIssue[]
    }

/**
 * Patterns that indicate potentially blocking operations
 */
const BLOCKING_PATTERNS: Array<{
  pattern: RegExp
  type: 'blocking'
  code: MigrationLintErrorCode
  message: string
  suggestion: string
  /** When true for a line match, the pattern is treated as allowed (e.g. CONCURRENTLY). */
  allowIf?: RegExp
}> = [
  {
    pattern: /ADD\s+COLUMN.*NOT\s+NULL/i,
    type: 'blocking',
    code: 'ADD_COLUMN_NOT_NULL',
    message: 'Adding NOT NULL column without default can block writes',
    suggestion: 'Add column as NULL, backfill data, then add NOT NULL constraint',
  },
  {
    // Block non-concurrent unique indexes; CONCURRENTLY is the online-safe form.
    pattern: /CREATE\s+UNIQUE\s+INDEX(?!\s+CONCURRENTLY)/i,
    type: 'blocking',
    code: 'CREATE_UNIQUE_INDEX',
    message: 'Creating unique index blocks writes to the table',
    suggestion: 'Use CREATE UNIQUE INDEX CONCURRENTLY or add index without unique constraint first',
  },
  {
    pattern: /ALTER\s+TABLE.*ADD\s+PRIMARY\s+KEY/i,
    type: 'blocking',
    code: 'ADD_PRIMARY_KEY',
    message: 'Adding primary key blocks writes',
    suggestion: 'Use ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY USING INDEX if possible',
  },
  {
    pattern: /ALTER\s+TABLE.*DROP\s+COLUMN/i,
    type: 'blocking',
    code: 'DROP_COLUMN',
    message: 'Dropping columns blocks reads and may break applications',
    suggestion: 'Mark column as unused first, then drop in later migration',
  },
]

/** node-pg-migrate API forms that are equivalent to the SQL blocking patterns above. */
function collectPgmBlockingIssues(
  content: string,
  filePath: string,
): MigrationIssue[] {
  const issues: MigrationIssue[] = []

  // pgm.addColumn(..., { notNull: true | null: false })
  const addColumnCalls = Array.from(content.matchAll(/addColumn\s*\(([\s\S]*?)\)/gi))
  for (const match of addColumnCalls) {
    const call = match[0]
    if (/notNull\s*:\s*true|null\s*:\s*false/i.test(call)) {
      issues.push({
        type: 'blocking',
        code: 'ADD_COLUMN_NOT_NULL',
        message: 'pgm.addColumn with NOT NULL can block writes during rewrite',
        suggestion:
          'Add column as nullable, backfill, then set NOT NULL in a follow-up migration',
        migration: filePath,
      })
    }
  }

  // pgm.createIndex(..., { unique: true }) without concurrently: true
  const createIndexCalls = Array.from(content.matchAll(/createIndex\s*\(([\s\S]*?)\)/gi))
  for (const match of createIndexCalls) {
    const call = match[0]
    if (/unique\s*:\s*true/i.test(call) && !/concurrently\s*:\s*true/i.test(call)) {
      issues.push({
        type: 'blocking',
        code: 'CREATE_UNIQUE_INDEX',
        message:
          'pgm.createIndex with unique: true blocks writes unless created concurrently',
        suggestion:
          'Pass { unique: true, concurrently: true } or create a non-unique index first',
        migration: filePath,
      })
    }
  }

  return issues
}

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
 * Analyze migration source content (pure — used by tests and CI).
 */
export function analyzeMigrationContent(
  content: string,
  filePath = '<memory>',
): PreflightResult {
  const issues: MigrationIssue[] = []
  const warnings: MigrationIssue[] = []
  const lines = content.split('\n')

  const allPatterns: Array<{
    pattern: RegExp
    type: MigrationIssue['type']
    code?: MigrationLintErrorCode
    message: string
    suggestion: string
  }> = [...BLOCKING_PATTERNS, ...LONG_RUNNING_PATTERNS, ...UNSAFE_PATTERNS]

  lines.forEach((line, index) => {
    // Skip comment-only lines so pattern source / docs in tooling files don't self-hit.
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      return
    }

    allPatterns.forEach(({ pattern, type, code, message, suggestion }) => {
      if (pattern.test(line)) {
        const issue: MigrationIssue = {
          type,
          code,
          message,
          suggestion,
          line: index + 1,
          migration: filePath,
        }

        if (type === 'warning') {
          warnings.push(issue)
        } else {
          issues.push(issue)
        }
      }
    })
  })

  // Multi-line / API-form checks for the two CI-gated blocking patterns.
  for (const issue of collectPgmBlockingIssues(content, filePath)) {
    if (!issues.some((i) => i.code === issue.code)) {
      issues.push(issue)
    }
  }

  checkMigrationStructure(content, filePath, issues, warnings)

  return {
    passed: issues.length === 0,
    issues,
    warnings,
  }
}

/**
 * CI-focused gate: only the two patterns from issue #681.
 * Returns a typed discriminated union so callers can branch on the failure code.
 */
export function lintCiBlockingPatterns(
  content: string,
  filePath = '<memory>',
): MigrationLintResult {
  const result = analyzeMigrationContent(content, filePath)
  const ciIssues = result.issues.filter(
    (issue) =>
      issue.code === 'ADD_COLUMN_NOT_NULL' || issue.code === 'CREATE_UNIQUE_INDEX',
  )

  if (ciIssues.length === 0) {
    return { ok: true, issues: [], warnings: result.warnings }
  }

  const primary = ciIssues[0]
  return {
    ok: false,
    code: primary.code ?? 'ADD_COLUMN_NOT_NULL',
    message: `${primary.code}: ${primary.message}${
      primary.line ? ` (line ${primary.line})` : ''
    } in ${filePath}`,
    issues: ciIssues,
    warnings: result.warnings,
  }
}

/**
 * Analyze a single migration file for potential issues
 */
export function analyzeMigration(filePath: string): PreflightResult {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return analyzeMigrationContent(content, filePath)
  } catch (error) {
    return {
      passed: false,
      issues: [
        {
          type: 'unsafe',
          code: 'READ_FAILURE',
          message: `Failed to read migration file: ${error}`,
          suggestion: 'Ensure file exists and is readable',
          migration: filePath,
        },
      ],
      warnings: [],
    }
  }
}

/**
 * True for numbered migration files (e.g. 001_initial_schema.ts).
 * Excludes tooling, templates, and examples from directory scans.
 */
export function isNumberedMigrationFile(fileName: string): boolean {
  return /^\d+_.+\.ts$/.test(fileName) && !fileName.endsWith('.test.ts')
}

/**
 * Analyze all migration files in a directory
 */
export function analyzeAllMigrations(migrationsDir: string): PreflightResult {
  const allIssues: MigrationIssue[] = []
  const allWarnings: MigrationIssue[] = []

  try {
    const files = readdirSync(migrationsDir)
      .filter(isNumberedMigrationFile)
      .sort() // Process in order

    files.forEach((file) => {
      const filePath = join(migrationsDir, file)
      const result = analyzeMigration(filePath)
      allIssues.push(...result.issues)
      allWarnings.push(...result.warnings)
    })
  } catch (error) {
    allIssues.push({
      type: 'unsafe',
      code: 'READ_FAILURE',
      message: `Failed to read migrations directory: ${error}`,
      suggestion: 'Ensure migrations directory exists and is readable',
    })
  }

  return {
    passed: allIssues.length === 0,
    issues: allIssues,
    warnings: allWarnings,
  }
}

/**
 * Check migration structure for best practices
 */
function checkMigrationStructure(
  content: string,
  filePath: string,
  _issues: MigrationIssue[],
  warnings: MigrationIssue[],
): void {
  if (!content.includes('export async function down')) {
    warnings.push({
      type: 'warning',
      message: 'Migration missing down function',
      suggestion: 'Always provide a rollback strategy',
      migration: filePath,
    })
  }

  if (!content.includes('/**') || !content.includes('*/')) {
    warnings.push({
      type: 'warning',
      message: 'Migration missing documentation',
      suggestion:
        'Add JSDoc comments explaining the migration purpose, risk level, and estimated runtime',
      migration: filePath,
    })
  }

  const timeoutMatch = content.match(/timeout:\s*(\d+)/i)
  if (timeoutMatch && parseInt(timeoutMatch[1]) < 30000) {
    warnings.push({
      type: 'warning',
      message: 'Timeout might be too short for large operations',
      suggestion:
        'Consider using longer timeouts for schema changes (30s+ for DDL, 5min+ for data)',
      migration: filePath,
    })
  }

  const largeUpdateMatch = content.match(/UPDATE.*SET.*WHERE/i)
  if (largeUpdateMatch && !content.includes('LIMIT') && !content.includes('batch')) {
    warnings.push({
      type: 'warning',
      message: 'Large UPDATE without batching detected',
      suggestion:
        'Add LIMIT clause or use batching utilities for operations affecting >10,000 rows',
      migration: filePath,
    })
  }

  if (!content.includes('statement_timeout') && content.includes('CONCURRENTLY')) {
    warnings.push({
      type: 'warning',
      message: 'Index creation without explicit timeout',
      suggestion: 'Set statement_timeout for CONCURRENTLY index operations',
      migration: filePath,
    })
  }
}

/**
 * Check if migration is safe for online schema change
 */
export function isOnlineSchemaChange(migrationContent: string): boolean {
  const blockingPatterns = BLOCKING_PATTERNS.map((p) => p.pattern)
  const hasBlocking = blockingPatterns.some((pattern) => pattern.test(migrationContent))
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
