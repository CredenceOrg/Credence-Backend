import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { runMigration, MigrationOptions } from '../migrations/runner.js'

// Mock the node-pg-migrate runner
vi.mock('node-pg-migrate', () => ({
  runner: vi.fn()
}))

// Mock the config
vi.mock('../migrations/config.js', () => ({
  loadMigrationConfig: () => ({
    databaseUrl: 'postgres://test:test@localhost:5432/test',
    migrationsDir: '/tmp/migrations',
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'public',
    transactional: true,
    createSchema: true
  }),
  validateConfig: () => true
}))

describe('Enhanced Migration Runner', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = join(tmpdir(), `migration-runner-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    vi.clearAllMocks()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe('preflight checks', () => {
    it('should block migration with blocking operations by default', async () => {
      const { runner } = await import('node-pg-migrate')
      vi.mocked(runner).mockResolvedValue([])

      // Create an unsafe migration
      const unsafeMigration = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', notNull: true })
        }
      `
      
      const migrationFile = join(tempDir, '001_unsafe.ts')
      writeFileSync(migrationFile, unsafeMigration)

      const options: MigrationOptions = {
        direction: 'up',
        file: migrationFile
      }

      const result = await runMigration(options)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Blocking operations detected')
      expect(result.preflight).toBeDefined()
      expect(result.preflight!.passed).toBe(false)
      expect(runner).not.toHaveBeenCalled()
    })

    it('should allow blocking operations when explicitly allowed', async () => {
      const { runner } = await import('node-pg-migrate')
      vi.mocked(runner).mockResolvedValue([])

      // Create an unsafe migration
      const unsafeMigration = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', notNull: true })
        }
      `
      
      const migrationFile = join(tempDir, '001_unsafe.ts')
      writeFileSync(migrationFile, unsafeMigration)

      const options: MigrationOptions = {
        direction: 'up',
        file: migrationFile,
        allowBlocking: true
      }

      const result = await runMigration(options)

      expect(result.success).toBe(true)
      expect(runner).toHaveBeenCalled()
    })

    it('should skip preflight checks when requested', async () => {
      const { runner } = await import('node-pg-migrate')
      vi.mocked(runner).mockResolvedValue([])

      // Create an unsafe migration
      const unsafeMigration = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.dropTable('dangerous_table')
        }
      `
      
      const migrationFile = join(tempDir, '001_unsafe.ts')
      writeFileSync(migrationFile, unsafeMigration)

      const options: MigrationOptions = {
        direction: 'up',
        file: migrationFile,
        skipPreflight: true
      }

      const result = await runMigration(options)

      expect(result.success).toBe(true)
      expect(runner).toHaveBeenCalled()
      expect(result.preflight).toBeUndefined()
    })

    it('should pass safe migrations through preflight', async () => {
      const { runner } = await import('node-pg-migrate')
      vi.mocked(runner).mockResolvedValue(['001_safe.ts'])

      // Create a safe migration
      const safeMigration = `
        /**
         * Migration: Add Email Field
         * 
         * Description: Adds nullable email field to users table
         */
        
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { 
            type: 'varchar(255)', 
            null: true,
            comment: 'User email address'
          })
        }
        
        export async function down(pgm: MigrationBuilder): Promise<void> {
          pgm.dropColumn('users', 'email')
        }
      `
      
      const migrationFile = join(tempDir, '001_safe.ts')
      writeFileSync(migrationFile, safeMigration)

      const options: MigrationOptions = {
        direction: 'up',
        file: migrationFile
      }

      const result = await runMigration(options)

      expect(result.success).toBe(true)
      expect(result.applied).toEqual(['001_safe.ts'])
      expect(result.preflight!.passed).toBe(true)
      expect(runner).toHaveBeenCalled()
    })

    it('should log warnings for safe migrations with warnings', async () => {
      const { runner } = await import('node-pg-migrate')
      vi.mocked(runner).mockResolvedValue(['001_warning.ts'])
      
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      // Create a migration with warnings
      const warningMigration = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', null: true })
        }
        // Missing down function
      `
      
      const migrationFile = join(tempDir, '001_warning.ts')
      writeFileSync(migrationFile, warningMigration)

      const options: MigrationOptions = {
        direction: 'up',
        file: migrationFile,
        verbose: true
      }

      const result = await runMigration(options)

      expect(result.success).toBe(true)
      expect(result.preflight!.warnings).toHaveLength(1)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('⚠️  Migration warnings:')
      )
      
      consoleSpy.mockRestore()
    })
  })

  describe('error handling', () => {
    it('should handle migration execution errors', async () => {
      const { runner } = await import('node-pg-migrate')
      vi.mocked(runner).mockRejectedValue(new Error('Database connection failed'))

      // Create a safe migration
      const safeMigration = `
        import { MigrationBuilder } from 'node-pg-migrate'
        
        export async function up(pgm: MigrationBuilder): Promise<void> {
          pgm.addColumn('users', 'email', { type: 'varchar(255)', null: true })
        }
        
        export async function down(pgm: MigrationBuilder): Promise<void> {
          pgm.dropColumn('users', 'email')
        }
      `
      
      const migrationFile = join(tempDir, '001_safe.ts')
      writeFileSync(migrationFile, safeMigration)

      const options: MigrationOptions = {
        direction: 'up',
        file: migrationFile
      }

      const result = await runMigration(options)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database connection failed')
      expect(result.preflight!.passed).toBe(true)
    })

    it('should handle file read errors in preflight', async () => {
      const nonExistentFile = join(tempDir, 'nonexistent.ts')

      const options: MigrationOptions = {
        direction: 'up',
        file: nonExistentFile
      }

      const result = await runMigration(options)

      expect(result.success).toBe(false)
      expect(result.error).toContain('ENOENT')
      expect(result.preflight!.passed).toBe(false)
    })
  })

  describe('directory-based migrations', () => {
    it('should skip preflight for directory migrations with warning', async () => {
      const { runner } = await import('node-pg-migrate')
      vi.mocked(runner).mockResolvedValue(['001_safe.ts', '002_safe.ts'])
      
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const options: MigrationOptions = {
        direction: 'up',
        verbose: true
      }

      const result = await runMigration(options)

      expect(result.success).toBe(true)
      expect(result.preflight).toBeUndefined()
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping preflight checks for directory-based migrations')
      )
      
      consoleSpy.mockRestore()
    })
  })
})
