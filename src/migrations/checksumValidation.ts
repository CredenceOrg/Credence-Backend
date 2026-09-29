/**
 * Migration checksum validation
 *
 * Detects silent drift when applied migration files are modified after deployment
 * by comparing on-disk SHA-256 checksums against records in migration_checksums.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { MigrationConfig } from './config.js'

export const MIGRATION_CHECKSUMS_TABLE = 'migration_checksums'

export type MigrationChecksumMismatchReason =
  | 'checksum_mismatch'
  | 'missing_file'
  | 'missing_checksum_record'

export interface MigrationChecksumMismatch {
  name: string
  reason: MigrationChecksumMismatchReason
  expected?: string
  actual?: string
}

export class MigrationChecksumError extends Error {
  readonly mismatches: MigrationChecksumMismatch[]

  constructor(message: string, mismatches: MigrationChecksumMismatch[]) {
    super(message)
    this.name = 'MigrationChecksumError'
    this.mismatches = mismatches
  }
}

export interface MigrationChecksumValidationOptions {
  /** When true, record missing checksums from current on-disk files (first-run bootstrap). */
  bootstrapMissing?: boolean
}

export interface MigrationChecksumValidationResult {
  validated: string[]
  bootstrapped: string[]
}

/** Compute a SHA-256 hex digest for migration file contents. */
export function computeFileChecksum(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Compute the checksum of a migration file on disk. */
export function computeMigrationFileChecksum(filePath: string): string {
  return computeFileChecksum(readFileSync(filePath))
}

/** Resolve the on-disk path for an applied migration name (without extension). */
export function resolveMigrationFilePath(
  migrationsDir: string,
  migrationName: string,
): string | null {
  const filePath = join(migrationsDir, `${migrationName}.ts`)
  return existsSync(filePath) ? filePath : null
}

/** Fetch migration names recorded in the node-pg-migrate tracking table. */
export async function fetchAppliedMigrationNames(
  pool: Pool,
  migrationsTable: string,
  migrationsSchema: string,
): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    `SELECT name FROM "${migrationsSchema}"."${migrationsTable}" ORDER BY run_on`,
  )
  return result.rows.map((row) => row.name)
}

/** Return true when the migration_checksums table exists. */
export async function migrationChecksumsTableExists(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [MIGRATION_CHECKSUMS_TABLE],
  )
  return result.rows[0]?.exists === true
}

/** Load stored checksums keyed by migration name. */
export async function fetchStoredChecksums(pool: Pool): Promise<Map<string, string>> {
  if (!(await migrationChecksumsTableExists(pool))) {
    return new Map()
  }

  const result = await pool.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM ${MIGRATION_CHECKSUMS_TABLE}`,
  )
  return new Map(result.rows.map((row) => [row.name, row.checksum]))
}

/** Persist a migration checksum (insert or update). */
export async function recordMigrationChecksum(
  pool: Pool,
  name: string,
  checksum: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO ${MIGRATION_CHECKSUMS_TABLE} (name, checksum, recorded_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (name) DO UPDATE
       SET checksum = EXCLUDED.checksum,
           recorded_at = EXCLUDED.recorded_at`,
    [name, checksum],
  )
}

/**
 * Validate that every applied migration matches its stored checksum.
 *
 * When bootstrapMissing is enabled, missing checksum records are seeded from the
 * current on-disk file so existing deployments can adopt this guard incrementally.
 */
export async function validateMigrationChecksums(
  pool: Pool,
  config: Pick<MigrationConfig, 'migrationsDir' | 'migrationsTable' | 'migrationsSchema'>,
  options: MigrationChecksumValidationOptions = {},
): Promise<MigrationChecksumValidationResult> {
  const bootstrapMissing = options.bootstrapMissing ?? true

  if (!(await migrationChecksumsTableExists(pool))) {
    return { validated: [], bootstrapped: [] }
  }

  const applied = await fetchAppliedMigrationNames(
    pool,
    config.migrationsTable,
    config.migrationsSchema,
  )
  const stored = await fetchStoredChecksums(pool)
  const mismatches: MigrationChecksumMismatch[] = []
  const validated: string[] = []
  const bootstrapped: string[] = []

  for (const name of applied) {
    const filePath = resolveMigrationFilePath(config.migrationsDir, name)
    if (!filePath) {
      mismatches.push({ name, reason: 'missing_file' })
      continue
    }

    const actual = computeMigrationFileChecksum(filePath)
    const expected = stored.get(name)

    if (!expected) {
      if (bootstrapMissing) {
        await recordMigrationChecksum(pool, name, actual)
        bootstrapped.push(name)
        continue
      }
      mismatches.push({ name, reason: 'missing_checksum_record', actual })
      continue
    }

    if (expected !== actual) {
      mismatches.push({ name, reason: 'checksum_mismatch', expected, actual })
      continue
    }

    validated.push(name)
  }

  if (mismatches.length > 0) {
    const details = mismatches
      .map((m) => {
        if (m.reason === 'checksum_mismatch') {
          return `${m.name}: expected ${m.expected}, got ${m.actual}`
        }
        if (m.reason === 'missing_file') {
          return `${m.name}: migration file missing on disk`
        }
        return `${m.name}: no checksum record (run backfill or enable bootstrap)`
      })
      .join('; ')

    throw new MigrationChecksumError(
      `Migration checksum validation failed (${mismatches.length} issue(s)): ${details}`,
      mismatches,
    )
  }

  return { validated, bootstrapped }
}

/** Record checksums for migrations applied in the current run. */
export async function recordAppliedMigrationChecksums(
  pool: Pool,
  migrationsDir: string,
  appliedNames: string[],
): Promise<void> {
  if (appliedNames.length === 0) {
    return
  }

  if (!(await migrationChecksumsTableExists(pool))) {
    return
  }

  for (const name of appliedNames) {
    const filePath = resolveMigrationFilePath(migrationsDir, name)
    if (!filePath) {
      continue
    }
    const checksum = computeMigrationFileChecksum(filePath)
    await recordMigrationChecksum(pool, name, checksum)
  }
}
