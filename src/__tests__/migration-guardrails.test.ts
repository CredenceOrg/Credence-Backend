import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { 
  analyzeMigration, 
  analyzeAllMigrations, 
  isOnlineSchemaChange,
  generateSafetyReport 
} from '../migrations/guardrails.js'

describe('Migration Guardrails', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `migration-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('analyzeMigration', () => {
    it('should detect blocking ADD COLUMN NOT NULL operations', () => {
      const migrationContent = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', notNull: true })
        }
      `
      
      const migrationFile = join(tempDir, '001_add_email.ts')
      writeFileSync(migrationFile, migrationContent)
      
      const result = analyzeMigration(migrationFile)
      
      expect(result.passed).toBe(false)
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0].type).toBe('blocking')
      expect(result.issues[0].message).toContain('Adding NOT NULL column without default')
      expect(result.issues[0].suggestion).toContain('Add column as NULL')
    })

    it('should detect blocking CREATE UNIQUE INDEX operations', () => {
      const migrationContent = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.createIndex('users', 'email', { unique: true })
        }
      `
      
      const migrationFile = join(tempDir, '002_unique_email.ts')
      writeFileSync(migrationFile, migrationContent)
      
      const result = analyzeMigration(migrationFile)
      
      expect(result.passed).toBe(false)
      expect(result.issues[0].type).toBe('blocking')
      expect(result.issues[0].message).toContain('Creating unique index blocks writes')
    })

    it('should detect unsafe DROP TABLE operations', () => {
      const migrationContent = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.dropTable('old_users')
        }
      `
      
      const migrationFile = join(tempDir, '003_drop_table.ts')
      writeFileSync(migrationFile, migrationContent)
      
      const result = analyzeMigration(migrationFile)
      
      expect(result.passed).toBe(false)
      expect(result.issues[0].type).toBe('unsafe')
      expect(result.issues[0].message).toContain('Dropping tables is destructive')
    })

    it('should detect long-running UPDATE operations', () => {
      const migrationContent = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.sql('UPDATE users SET status = "active" WHERE old_status = "pending"')
        }
      `
      
      const migrationFile = join(tempDir, '004_update_status.ts')
      writeFileSync(migrationFile, migrationContent)
      
      const result = analyzeMigration(migrationFile)
      
      expect(result.passed).toBe(false)
      expect(result.issues[0].type).toBe('long-running')
      expect(result.issues[0].message).toContain('Large UPDATE operations can lock rows')
    })

    it('should warn about missing down migration', () => {
      const migrationContent = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', null: true })
        }
      `
      
      const migrationFile = join(tempDir, '005_no_down.ts')
      writeFileSync(migrationFile, migrationContent)
      
      const result = analyzeMigration(migrationFile)
      
      expect(result.passed).toBe(true)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0].message).toContain('missing down function')
    })

    it('should warn about missing documentation', () => {
      const migrationContent = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', null: true })
        }
        
        export async function down(pgm: MigrationBuilder): Promise<void> {
          pgm.dropColumn('users', 'email')
        }
      `
      
      const migrationFile = join(tempDir, '006_no_docs.ts')
      writeFileSync(migrationFile, migrationContent)
      
      const result = analyzeMigration(migrationFile)
      
      expect(result.passed).toBe(true)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0].message).toContain('missing documentation')
    })

    it('should pass for safe migrations', () => {
      const migrationContent = `
        /**
         * Migration: Add Email Field
         * 
         * Description: Adds nullable email field to users table
         * 
         * Created: 2024-01-01T00:00:00.000Z
         */
        
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { 
            type: 'varchar(255)', 
            null: true,
            comment: 'User email address'
          })
          
          pgm.createIndex('users', 'email', { 
            method: 'CONCURRENTLY',
            name: 'idx_users_email'
          })
        }
        
        export async function down(pgm: MigrationBuilder): Promise<void> {
          pgm.dropIndex('users', 'email', { name: 'idx_users_email' })
          pgm.dropColumn('users', 'email')
        }
      `
      
      const migrationFile = join(tempDir, '007_safe_migration.ts')
      writeFileSync(migrationFile, migrationContent)
      
      const result = analyzeMigration(migrationFile)
      
      expect(result.passed).toBe(true)
      expect(result.issues).toHaveLength(0)
      expect(result.warnings).toHaveLength(0)
    })
  })

  describe('analyzeAllMigrations', () => {
    it('should analyze multiple migration files', () => {
      // Create multiple migration files
      const safeMigration = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', null: true })
        }
        
        export async function down(pgm: MigrationBuilder): Promise<void> {
          pgm.dropColumn('users', 'email')
        }
      `
      
      const unsafeMigration = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.dropTable('old_table')
        }
      `
      
      writeFileSync(join(tempDir, '001_safe.ts'), safeMigration)
      writeFileSync(join(tempDir, '002_unsafe.ts'), unsafeMigration)
      
      const result = analyzeAllMigrations(tempDir)
      
      expect(result.passed).toBe(false)
      expect(result.issues).toHaveLength(1)
      expect(result.issues[0].message).toContain('Dropping tables is destructive')
    })

    it('should handle empty migration directory', () => {
      const result = analyzeAllMigrations(tempDir)
      
      expect(result.passed).toBe(true)
      expect(result.issues).toHaveLength(0)
      expect(result.warnings).toHaveLength(0)
    })
  })

  describe('isOnlineSchemaChange', () => {
    it('should return true for safe online schema changes', () => {
      const safeMigration = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', null: true })
          pgm.createIndex('users', 'email', { method: 'CONCURRENTLY' })
        }
      `
      
      expect(isOnlineSchemaChange(safeMigration)).toBe(true)
    })

    it('should return false for blocking operations', () => {
      const blockingMigration = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', notNull: true })
        }
      `
      
      expect(isOnlineSchemaChange(blockingMigration)).toBe(false)
    })
  })

  describe('generateSafetyReport', () => {
    it('should generate a comprehensive safety report', () => {
      const mockResult = {
        passed: false,
        issues: [
          {
            type: 'blocking' as const,
            message: 'Adding NOT NULL column without default',
            suggestion: 'Add column as NULL, backfill data',
            migration: '001_add_email.ts',
            line: 5
          }
        ],
        warnings: [
          {
            type: 'warning' as const,
            message: 'Migration missing down function',
            suggestion: 'Always provide a rollback strategy',
            migration: '001_add_email.ts'
          }
        ]
      }
      
      const report = generateSafetyReport(mockResult)
      
      expect(report).toContain('# Migration Safety Report')
      expect(report).toContain('❌ Migration safety issues found')
      expect(report).toContain('## Issues')
      expect(report).toContain('## Warnings')
      expect(report).toContain('Adding NOT NULL column without default')
      expect(report).toContain('Migration missing down function')
    })

    it('should show success when no issues found', () => {
      const mockResult = {
        passed: true,
        issues: [],
        warnings: []
      }
      
      const report = generateSafetyReport(mockResult)
      
      expect(report).toContain('✅ All migrations passed safety checks')
    })
  })
})
