import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Pool } from 'pg'
import {
  computeFileChecksum,
  computeMigrationFileChecksum,
  resolveMigrationFilePath,
  validateMigrationChecksums,
  MigrationChecksumError,
  MIGRATION_CHECKSUMS_TABLE,
} from '../checksumValidation.js'

function createMockPool(handlers: {
  tableExists?: boolean
  applied?: string[]
  stored?: Map<string, string>
  recorded?: Array<{ name: string; checksum: string }>
}): Pool {
  const recorded: Array<{ name: string; checksum: string }> = handlers.recorded ?? []
  const stored = new Map(handlers.stored ?? [])

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('information_schema.tables')) {
      return { rows: [{ exists: handlers.tableExists ?? true }] }
    }
    if (sql.includes('pgmigrations') && sql.includes('SELECT name')) {
      return { rows: (handlers.applied ?? []).map((name) => ({ name })) }
    }
    if (sql.includes(`FROM ${MIGRATION_CHECKSUMS_TABLE}`) && sql.includes('SELECT')) {
      return {
        rows: [...stored.entries()].map(([name, checksum]) => ({ name, checksum })),
      }
    }
    if (sql.includes(`INSERT INTO ${MIGRATION_CHECKSUMS_TABLE}`)) {
      const [name, checksum] = params as [string, string]
      stored.set(name, checksum)
      recorded.push({ name, checksum })
      return { rows: [] }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })

  return { query } as unknown as Pool
}

describe('checksumValidation', () => {
  let migrationsDir: string

  beforeEach(() => {
    migrationsDir = mkdtempSync(join(tmpdir(), 'credence-migrations-'))
  })

  it('computeFileChecksum returns stable SHA-256 hex', () => {
    const checksum = computeFileChecksum('export async function up() {}')
    expect(checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(checksum).toBe(computeFileChecksum('export async function up() {}'))
  })

  it('resolveMigrationFilePath finds numbered migration files', () => {
    writeFileSync(join(migrationsDir, '001_initial_schema.ts'), 'up')
    expect(resolveMigrationFilePath(migrationsDir, '001_initial_schema')).toBe(
      join(migrationsDir, '001_initial_schema.ts'),
    )
    expect(resolveMigrationFilePath(migrationsDir, '999_missing')).toBeNull()
  })

  it('computeMigrationFileChecksum reads file content', () => {
    const filePath = join(migrationsDir, '001_initial_schema.ts')
    writeFileSync(filePath, 'migration body')
    expect(computeMigrationFileChecksum(filePath)).toBe(computeFileChecksum('migration body'))
  })

  it('passes when applied migration checksums match stored values', async () => {
    const name = '001_initial_schema'
    const body = 'export async function up() {}'
    writeFileSync(join(migrationsDir, `${name}.ts`), body)
    const checksum = computeFileChecksum(body)

    const pool = createMockPool({
      applied: [name],
      stored: new Map([[name, checksum]]),
    })

    const result = await validateMigrationChecksums(pool, {
      migrationsDir,
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
    }, { bootstrapMissing: false })

    expect(result.validated).toEqual([name])
    expect(result.bootstrapped).toEqual([])
  })

  it('throws MigrationChecksumError when checksums diverge', async () => {
    const name = '001_initial_schema'
    writeFileSync(join(migrationsDir, `${name}.ts`), 'tampered content')

    const pool = createMockPool({
      applied: [name],
      stored: new Map([[name, computeFileChecksum('original content')]]),
    })

    await expect(
      validateMigrationChecksums(pool, {
        migrationsDir,
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'public',
      }, { bootstrapMissing: false }),
    ).rejects.toBeInstanceOf(MigrationChecksumError)
  })

  it('bootstraps missing checksum records when enabled', async () => {
    const name = '001_initial_schema'
    const body = 'export async function up() {}'
    writeFileSync(join(migrationsDir, `${name}.ts`), body)
    const recorded: Array<{ name: string; checksum: string }> = []

    const pool = createMockPool({
      applied: [name],
      stored: new Map(),
      recorded,
    })

    const result = await validateMigrationChecksums(pool, {
      migrationsDir,
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
    }, { bootstrapMissing: true })

    expect(result.bootstrapped).toEqual([name])
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.checksum).toBe(computeFileChecksum(body))
  })

  it('skips validation when migration_checksums table does not exist', async () => {
    const pool = createMockPool({ tableExists: false, applied: ['001_initial_schema'] })

    const result = await validateMigrationChecksums(pool, {
      migrationsDir,
      migrationsTable: 'pgmigrations',
      migrationsSchema: 'public',
    })

    expect(result).toEqual({ validated: [], bootstrapped: [] })
  })

  it('reports missing migration files as checksum errors', async () => {
    const pool = createMockPool({
      applied: ['001_initial_schema'],
      stored: new Map([['001_initial_schema', 'abc123']]),
    })

    await expect(
      validateMigrationChecksums(pool, {
        migrationsDir,
        migrationsTable: 'pgmigrations',
        migrationsSchema: 'public',
      }, { bootstrapMissing: false }),
    ).rejects.toMatchObject({
      mismatches: [{ name: '001_initial_schema', reason: 'missing_file' }],
    })
  })
})
