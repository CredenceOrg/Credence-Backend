import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadMigrationConfig, validateConfig, MigrationConfig } from '../config.js'

describe('loadMigrationConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv }
    delete process.env.DATABASE_URL
    delete process.env.MIGRATIONS_DIR
    delete process.env.MIGRATIONS_TABLE
    delete process.env.MIGRATIONS_SCHEMA
    delete process.env.MIGRATIONS_TRANSACTIONAL
    delete process.env.MIGRATIONS_CREATE_SCHEMA
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('throws error when DATABASE_URL is not set', () => {
    expect(() => loadMigrationConfig()).toThrow('DATABASE_URL environment variable is required')
  })

  it('returns config with DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb'
    
    const config = loadMigrationConfig()
    
    expect(config.databaseUrl).toBe('postgres://user:pass@localhost:5432/testdb')
    expect(config.migrationsDir).toBe('src/migrations')
    expect(config.migrationsTable).toBe('pgmigrations')
    expect(config.migrationsSchema).toBe('public')
    expect(config.transactional).toBe(true)
    expect(config.createSchema).toBe(true)
  })

  it('uses custom MIGRATIONS_DIR', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb'
    process.env.MIGRATIONS_DIR = 'custom/migrations'
    
    const config = loadMigrationConfig()
    
    expect(config.migrationsDir).toBe('custom/migrations')
  })

  it('uses custom MIGRATIONS_TABLE', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb'
    process.env.MIGRATIONS_TABLE = 'custom_migrations'
    
    const config = loadMigrationConfig()
    
    expect(config.migrationsTable).toBe('custom_migrations')
  })

  it('uses custom MIGRATIONS_SCHEMA', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb'
    process.env.MIGRATIONS_SCHEMA = 'custom_schema'
    
    const config = loadMigrationConfig()
    
    expect(config.migrationsSchema).toBe('custom_schema')
  })

  it('disables transactional when MIGRATIONS_TRANSACTIONAL is false', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb'
    process.env.MIGRATIONS_TRANSACTIONAL = 'false'
    
    const config = loadMigrationConfig()
    
    expect(config.transactional).toBe(false)
  })

  it('disables createSchema when MIGRATIONS_CREATE_SCHEMA is false', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb'
    process.env.MIGRATIONS_CREATE_SCHEMA = 'false'
    
    const config = loadMigrationConfig()
    
    expect(config.createSchema).toBe(false)
  })
})

describe('validateConfig', () => {
  it('returns true for valid config', () => {
    const config: MigrationConfig = {
      databaseUrl: 'postgres://user:pass@localhost:5432/testdb',
      migrationsDir: 'migrations',
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
      transactional: true,
      createSchema: true,
    }
    
    expect(validateConfig(config)).toBe(true)
  })

  it('throws error when databaseUrl is empty', () => {
    const config: MigrationConfig = {
      databaseUrl: '',
      migrationsDir: 'migrations',
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
      transactional: true,
      createSchema: true,
    }
    
    expect(() => validateConfig(config)).toThrow('DATABASE_URL is required')
  })

  it('throws error when databaseUrl is not a postgres URL', () => {
    const config: MigrationConfig = {
      databaseUrl: 'mysql://user:pass@localhost:3306/testdb',
      migrationsDir: 'migrations',
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
      transactional: true,
      createSchema: true,
    }
    
    expect(() => validateConfig(config)).toThrow('must be a valid PostgreSQL connection string')
  })

  it('accepts postgresql:// prefix', () => {
    const config: MigrationConfig = {
      databaseUrl: 'postgresql://user:pass@localhost:5432/testdb',
      migrationsDir: 'migrations',
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
      transactional: true,
      createSchema: true,
    }
    
    expect(validateConfig(config)).toBe(true)
  })

  it('throws error when migrationsDir is empty', () => {
    const config: MigrationConfig = {
      databaseUrl: 'postgres://user:pass@localhost:5432/testdb',
      migrationsDir: '',
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
      transactional: true,
      createSchema: true,
    }
    
    expect(() => validateConfig(config)).toThrow('Migrations directory is required')
  })
})
