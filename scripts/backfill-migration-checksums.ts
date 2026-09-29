#!/usr/bin/env node

/**
 * Backfill migration_checksums from currently applied migrations.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/backfill-migration-checksums.ts
 */

import pg from 'pg'
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

async function main(): Promise<void> {
  const config = loadMigrationConfig()
  config.migrationsDir = resolveMigrationsDir()

  const pool = new Pool({ connectionString: config.databaseUrl })
  try {
    if (!(await migrationChecksumsTableExists(pool))) {
      console.error(
        'migration_checksums table does not exist. Run migrations first (npm run migrate:dev).',
      )
      process.exit(1)
    }

    const applied = await fetchAppliedMigrationNames(
      pool,
      config.migrationsTable,
      config.migrationsSchema,
    )

    let recorded = 0
    for (const name of applied) {
      const filePath = resolveMigrationFilePath(config.migrationsDir, name)
      if (!filePath) {
        console.warn(`Skipping ${name}: file not found in ${config.migrationsDir}`)
        continue
      }
      const checksum = computeMigrationFileChecksum(filePath)
      await recordMigrationChecksum(pool, name, checksum)
      recorded += 1
      console.log(`Recorded ${name}: ${checksum}`)
    }

    console.log(`Backfill complete: ${recorded}/${applied.length} checksum(s) recorded.`)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('Backfill failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
