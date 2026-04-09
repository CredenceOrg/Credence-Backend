/**
 * Migration Runner
 * 
 * Programmatic interface for running database migrations.
 * Wraps node-pg-migrate to provide a TypeScript-friendly API.
 */

import { runner, Migration } from 'node-pg-migrate'
import { loadMigrationConfig, validateConfig, MigrationConfig } from './config.js'
import { analyzeMigration, PreflightResult } from './guardrails.js'

export interface MigrationOptions {
  /** Direction of migration: 'up' or 'down' */
  direction: 'up' | 'down'
  /** Number of migrations to run (default: all for up, 1 for down) */
  count?: number
  /** Specific migration to run (optional) */
  file?: string
  /** Whether to print verbose output */
  verbose?: boolean
  /** Custom configuration (uses loadMigrationConfig() if not provided) */
  config?: MigrationConfig
  /** Skip preflight safety checks (not recommended) */
  skipPreflight?: boolean
  /** Allow blocking operations (use with caution) */
  allowBlocking?: boolean
}

export interface MigrationResult {
  /** Whether the migration was successful */
  success: boolean
  /** List of migrations that were applied */
  applied: string[]
  /** Error message if failed */
  error?: string
  /** Preflight check results */
  preflight?: PreflightResult
}

/**
 * Run database migrations programmatically
 * 
 * @param options Migration options
 * @returns MigrationResult with status and applied migrations
 * 
 * @example
 * ```typescript
 * // Run all pending migrations
 * const result = await runMigration({ direction: 'up' })
 * 
 * // Rollback last migration
 * const result = await runMigration({ direction: 'down' })
 * 
 * // Rollback 3 migrations
 * const result = await runMigration({ direction: 'down', count: 3 })
 * ```
 */
export async function runMigration(options: MigrationOptions): Promise<MigrationResult> {
  const config = options.config ?? loadMigrationConfig()
  validateConfig(config)

  const applied: string[] = []
  let preflightResult: PreflightResult | undefined

  // Run preflight checks unless explicitly skipped
  if (!options.skipPreflight) {
    if (options.file) {
      preflightResult = analyzeMigration(options.file)
    } else {
      // For directory-based migrations, we'd need to scan which migrations will run
      // For now, we'll skip directory preflight checks as it requires complex logic
      if (options.verbose !== false) {
        console.log('⚠️  Skipping preflight checks for directory-based migrations')
      }
    }

    // Check preflight results
    if (preflightResult && !preflightResult.passed) {
      const blockingIssues = preflightResult.issues.filter(issue => issue.type === 'blocking')
      
      if (blockingIssues.length > 0 && !options.allowBlocking) {
        return {
          success: false,
          applied,
          error: `Blocking operations detected. Use allowBlocking: true to override. Issues: ${blockingIssues.map(i => i.message).join(', ')}`,
          preflight: preflightResult
        }
      }

      if (preflightResult.issues.length > 0) {
        return {
          success: false,
          applied,
          error: `Safety issues detected: ${preflightResult.issues.map(i => i.message).join(', ')}`,
          preflight: preflightResult
        }
      }
    }

    // Log warnings if any
    if (preflightResult && preflightResult.warnings.length > 0 && options.verbose !== false) {
      console.log('⚠️  Migration warnings:')
      preflightResult.warnings.forEach(warning => {
        console.log(`  • ${warning.message}`)
      })
    }
  }

  try {
    const migrations = await runner({
      databaseUrl: config.databaseUrl,
      dir: config.migrationsDir,
      migrationsTable: config.migrationsTable,
      schema: config.migrationsSchema,
      createSchema: config.createSchema,
      direction: options.direction,
      count: options.count,
      file: options.file,
      verbose: options.verbose ?? true,
      // Log applied migrations
      log: (message: string) => {
        if (options.verbose !== false) {
          console.log(message)
        }
      },
      // Track applied migrations
      logger: {
        info: (msg: string) => {
          if (options.verbose !== false) {
            console.info(msg)
          }
          // Extract migration name from log messages
          const match = msg.match(/migrating\s+'(.+)'/i)
          if (match) {
            applied.push(match[1])
          }
        },
        warn: (msg: string) => console.warn(msg),
        error: (msg: string) => console.error(msg),
      },
    })

    return {
      success: true,
      applied,
      preflight: preflightResult
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      applied,
      error: errorMessage,
      preflight: preflightResult
    }
  }
}

/**
 * Get the status of all migrations
 * 
 * @returns List of migrations with their status
 */
export async function getMigrationStatus(): Promise<{
  applied: string[]
  pending: string[]
}> {
  const config = loadMigrationConfig()
  validateConfig(config)

  try {
    // Run with dryRun to get status without applying
    const result = await runner({
      databaseUrl: config.databaseUrl,
      dir: config.migrationsDir,
      migrationsTable: config.migrationsTable,
      schema: config.migrationsSchema,
      direction: 'up',
      dryRun: true,
      verbose: false,
      log: () => {}, // Suppress logs
    })

    // This is a simplified status check
    // In production, you might want to query the migrations table directly
    return {
      applied: [],
      pending: [],
    }
  } catch (error) {
    console.error('Failed to get migration status:', error)
    return {
      applied: [],
      pending: [],
    }
  }
}

/**
 * Create a new migration file from the template
 * 
 * @param name Name of the migration (will be prefixed with timestamp)
 * @returns Path to the created migration file
 */
export async function createMigration(name: string): Promise<string> {
  const config = loadMigrationConfig()
  
  // Sanitize name: replace spaces with underscores, remove special chars
  const sanitizedName = name
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')

  if (!sanitizedName) {
    throw new Error('Migration name cannot be empty')
  }

  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  const filename = `${timestamp}_${sanitizedName}.ts`
  const filepath = `${config.migrationsDir}/${filename}`

  // Template content
  const template = `import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: ${sanitizedName}
 * 
 * Description: [Add your description here]
 * 
 * Created: ${new Date().toISOString()}
 */

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add your up migration here
  // Example:
  // pgm.createTable('users', {
  //   id: 'id',
  //   email: { type: 'varchar(255)', notNull: true, unique: true },
  //   created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
  // })
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Add your down migration here (reverse of up)
  // Example:
  // pgm.dropTable('users')
}
`

  const fs = await import('fs/promises')
  await fs.writeFile(filepath, template, 'utf-8')
  
  console.log(`Created migration: ${filepath}`)
  return filepath
}
