#!/usr/bin/env node

/**
 * Migration Linter CLI
 * 
 * Command-line tool for checking migration safety before execution.
 * Can be used as a pre-commit hook or CI/CD gate.
 */

import { Command } from 'commander'
import { analyzeAllMigrations, analyzeMigration, generateSafetyReport, PreflightResult } from './guardrails.js'
import { loadMigrationConfig } from './config.js'
import { readFileSync, existsSync } from 'fs'
import { exit } from 'process'

const program = new Command()

program
  .name('migration-linter')
  .description('Lint database migrations for safety and best practices')
  .version('1.0.0')

program
  .command('check')
  .description('Check all migrations in the configured directory')
  .option('-f, --file <path>', 'Check specific migration file')
  .option('-d, --dir <path>', 'Migration directory (overrides config)')
  .option('--strict', 'Treat warnings as errors')
  .option('--json', 'Output results as JSON')
  .action(async (options) => {
    try {
      let result: PreflightResult

      if (options.file) {
        if (!existsSync(options.file)) {
          console.error(`❌ Migration file not found: ${options.file}`)
          exit(1)
        }
        result = analyzeMigration(options.file)
      } else {
        const config = loadMigrationConfig()
        const migrationsDir = options.dir || config.migrationsDir
        result = analyzeAllMigrations(migrationsDir)
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        const report = generateSafetyReport(result)
        console.log(report)
      }

      // Exit with error code if issues found (or warnings in strict mode)
      const hasIssues = result.issues.length > 0
      const hasWarnings = result.warnings.length > 0
      const shouldFail = hasIssues || (options.strict && hasWarnings)

      if (shouldFail) {
        console.log('\n❌ Migration safety checks failed')
        exit(1)
      } else {
        console.log('\n✅ Migration safety checks passed')
        exit(0)
      }

    } catch (error) {
      console.error(`❌ Error running migration linter: ${error}`)
      exit(1)
    }
  })

program
  .command('pre-flight')
  .description('Run pre-flight checks before migration execution')
  .option('-f, --file <path>', 'Migration file to check')
  .option('--allow-blocking', 'Allow blocking operations (use with caution)')
  .action(async (options) => {
    try {
      if (!options.file) {
        console.error('❌ Migration file is required for pre-flight checks')
        exit(1)
      }

      const result = analyzeMigration(options.file)
      
      // Check for blocking operations specifically
      const blockingIssues = result.issues.filter(issue => issue.type === 'blocking')
      
      if (blockingIssues.length > 0 && !options.allowBlocking) {
        console.log('🚫 BLOCKING OPERATIONS DETECTED:')
        blockingIssues.forEach(issue => {
          console.log(`  • ${issue.message}`)
          console.log(`    Suggestion: ${issue.suggestion}`)
        })
        console.log('\nUse --allow-blocking to override (not recommended for production)')
        exit(1)
      }

      if (result.issues.length > 0) {
        console.log('⚠️  SAFETY ISSUES FOUND:')
        result.issues.forEach(issue => {
          console.log(`  • ${issue.message}`)
          console.log(`    Suggestion: ${issue.suggestion}`)
        })
        exit(1)
      }

      console.log('✅ Pre-flight checks passed')
      exit(0)

    } catch (error) {
      console.error(`❌ Error running pre-flight checks: ${error}`)
      exit(1)
    }
  })

program
  .command('template')
  .description('Generate a safe migration template')
  .argument('<name>', 'Migration name')
  .option('--online', 'Generate online schema change template')
  .action(async (name, options) => {
    try {
      const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
      const filename = `${timestamp}_${name.toLowerCase().replace(/\s+/g, '_')}.ts`
      
      let template = `import { MigrationBuilder } from 'node-pg-migrate'

/**
 * Migration: ${name}
 * 
 * Description: [Add detailed description of what this migration does]
 * 
 * Impact: [Describe the impact on the database and application]
 * Rollback: [Describe how to rollback this migration]
 * 
 * Created: ${new Date().toISOString()}
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
`

      if (options.online) {
        template += `
  // Online schema change pattern:
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
`
      }

      template += `
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // TODO: Implement rollback logic
  // This should be the exact reverse of the up migration
  // 
  // Example:
  // pgm.dropIndex('table_name', 'column_name', { ifExists: true })
  // pgm.dropColumn('table_name', 'new_column')
}
`

      const fs = await import('fs/promises')
      const config = loadMigrationConfig()
      const filepath = `${config.migrationsDir}/${filename}`
      
      await fs.writeFile(filepath, template, 'utf-8')
      console.log(`✅ Created migration template: ${filepath}`)
      console.log('📝 Please update the description and implement the migration logic')
      
    } catch (error) {
      console.error(`❌ Error creating migration template: ${error}`)
      exit(1)
    }
  })

// Parse command line arguments
program.parse()

// Export for testing
export { program }
