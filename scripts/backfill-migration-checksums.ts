#!/usr/bin/env node

/**
 * Backfill migration_checksums from currently applied migrations.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/backfill-migration-checksums.ts
 *
 * Invariants:
 * - Exit contract is deterministic: 0 = success, 1 = unrecoverable error. No throw escapes.
 * - Missing migration_checksums table is a hard stop (exit 1) — run migrations first.
 * - Missing on-disk files are skipped with a warning; remaining migrations are still processed.
 * - Per-migration checksum errors are isolated: one failure does not abort the rest.
 * - pool.end() is always called, even on partial failure, to prevent connection leaks.
 * - No migration file content is written to logs; only names, checksums, and error reasons.
 */

import pg from 'pg'
import { pathToFileURL } from 'node:url'
import {
  fetchAppliedMigrationNames,
  recordMigrationChecksum,
  resolveMigrationFilePath,
  computeMigrationFileChecksum,
  migrationChecksumsTableExists,
} from '../src/migrations/checksumValidation.js'
import {
  loadMigrationConfig,
  resolveMigrationsDir,
} from '../src/migrations/config.js'

const { Pool } = pg

export interface BackfillResult {
  recorded: number
  skipped: number
  failed: number
  total: number
}

/**
 * Core backfill logic. Accepts a pg.Pool so it can be tested without a live
 * database. Returns a structured result describing what was recorded, skipped,
 * and failed — and exits with code 1 only on unrecoverable errors (missing
 * table, connection failure). Per-migration failures are isolated and counted.
 *
 * @param pool   An open pg.Pool. The caller is responsible for pool.end().
 * @param migrationsDir   Resolved path to the migrations directory.
 * @param migrationsTable Name of the node-pg-migrate tracking table.
 * @param migrationsSchema Schema that owns the tracking table.
 */
export async function runBackfill(
  pool: pg.Pool,
  migrationsDir: string,
  migrationsTable: string,
  migrationsSchema: string,
): Promise<BackfillResult> {
  if (!(await migrationChecksumsTableExists(pool))) {
    throw new Error(
      'migration_checksums table does not exist. Run migrations first (npm run migrate:dev).',
    )
  }

  const applied = await fetchAppliedMigrationNames(pool, migrationsTable, migrationsSchema)

  let recorded = 0
  let skipped = 0
  let failed = 0

  for (const name of applied) {
    const filePath = resolveMigrationFilePath(migrationsDir, name)
    if (!filePath) {
      console.warn(`Skipping ${name}: file not found in ${migrationsDir}`)
      skipped += 1
      continue
    }

    let checksum: string
    try {
      checksum = computeMigrationFileChecksum(filePath)
    } catch (error) {
      // Recovery: I/O error (permission denied, file deleted between resolve and
      // read). Isolate the failure so the rest of the backfill continues. Never
      // log the file path content — only the migration name and the OS reason.
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`Failed to read ${name}: ${reason}`)
      failed += 1
      continue
    }

    try {
      await recordMigrationChecksum(pool, name, checksum)
      recorded += 1
      console.log(`Recorded ${name}: ${checksum}`)
    } catch (error) {
      // Recovery: transient DB write error. Isolate so other migrations still
      // get recorded. The checksum itself is not sensitive — log it for diagnostics.
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`Failed to record ${name}: ${reason}`)
      failed += 1
    }
  }

  console.log(
    `Backfill complete: ${recorded}/${applied.length} checksum(s) recorded` +
      (skipped > 0 ? `, ${skipped} skipped (file not found)` : '') +
      (failed > 0 ? `, ${failed} failed` : '') +
      '.',
  )

  return { recorded, skipped, failed, total: applied.length }
}

async function main(): Promise<void> {
  const config = loadMigrationConfig()
  config.migrationsDir = resolveMigrationsDir()

  const pool = new Pool({ connectionString: config.databaseUrl })
  try {
    await runBackfill(
      pool,
      config.migrationsDir,
      config.migrationsTable,
      config.migrationsSchema,
    )
  } finally {
    await pool.end()
  }
}

const entry = process.argv[1]
const isDirectRun = Boolean(entry && import.meta.url === pathToFileURL(entry).href)

if (isDirectRun) {
  main().catch((error) => {
    console.error('Backfill failed:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
