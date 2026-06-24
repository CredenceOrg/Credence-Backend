#!/usr/bin/env tsx
/* eslint-disable no-console */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import dotenv from 'dotenv'
import pg from 'pg'
import { createBackupVerifyMetrics } from '../src/jobs/backupVerifyMetrics.js'

dotenv.config()
const exec = promisify(execFile)
const { Pool } = pg

const RESTORE_SCHEMA = 'restore_verify'
const TABLES = ['identities', 'bonds', 'attestations', 'payouts', 'audit_logs']

interface Check {
  name: string
  ok: boolean
  detail?: string
}

const results: Check[] = []
const record = (name: string, ok: boolean, detail?: string): void => {
  results.push({ name, ok, detail })
  const icon = ok ? '✅' : '❌'
  const tail = detail ? `  — ${detail}` : ''
  console.log(`${icon} ${name}${tail}`)
}

async function main(): Promise<void> {
  console.log('▶ Backup restore-verify drill')
  const metrics = createBackupVerifyMetrics()
  const start = Date.now()
  let tmpDir: string | null = null
  let restorePool: pg.Pool | null = null

  try {
    const dbUrl = process.env.DB_URL
    if (!dbUrl) throw new Error('DB_URL must be set')

    // ---- 1. Create temporary directory for dump/restore -------------------
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'restore-verify-'))
    console.log(`Temporary directory: ${tmpDir}`)

    // ---- 2. Get latest snapshot (simulated for local dev; adjust for your backup provider)
    // TODO: Replace with actual snapshot retrieval from your backup system (e.g., S3, GCS, etc.)
    // For now, we'll create a fresh dump from the current DB to test the restore process
    const dumpPath = path.join(tmpDir, 'latest.dump')
    console.log('Creating test dump from current DB...')
    await exec('pg_dump', ['--format=c', '--file', dumpPath, dbUrl])
    record('Snapshot retrieved (local test dump)', true)

    // ---- 3. Create restore pool and schema -------------------------------
    restorePool = new Pool({ connectionString: dbUrl })
    await restorePool.query(`DROP SCHEMA IF EXISTS ${RESTORE_SCHEMA} CASCADE`)
    await restorePool.query(`CREATE SCHEMA ${RESTORE_SCHEMA}`)
    record('Isolated restore schema created', true)

    // ---- 4. Restore snapshot into the isolated schema --------------------
    console.log('Restoring snapshot...')
    const restoreEnv = { ...process.env, PGOPTIONS: `-c search_path=${RESTORE_SCHEMA}` }
    await exec('pg_restore', ['--schema=public', '--no-owner', '--no-acl', '--dbname', dbUrl, dumpPath], { env: restoreEnv })
    record('Snapshot restored successfully', true)

    // ---- 5. Rename restored tables to restore schema ---------------------
    // pg_restore might create tables in public, so we need to move them
    for (const table of TABLES) {
      try {
        await restorePool.query(`ALTER TABLE IF EXISTS public.${table} SET SCHEMA ${RESTORE_SCHEMA}`)
      } catch (e) {
        // Ignore if table doesn't exist in public
      }
    }

    // ---- 6. Verify row counts --------------------------------------------
    console.log('Verifying row counts...')
    for (const table of TABLES) {
      const primaryResult = await restorePool.query(`SELECT COUNT(*) AS count FROM public.${table}`)
      const restoreResult = await restorePool.query(`SELECT COUNT(*) AS count FROM ${RESTORE_SCHEMA}.${table}`)
      const primaryCount = parseInt(primaryResult.rows[0].count, 10)
      const restoreCount = parseInt(restoreResult.rows[0].count, 10)
      const ok = primaryCount === restoreCount
      record(`Row count check for ${table}`, ok, `primary=${primaryCount}, restore=${restoreCount}`)
      if (!ok) {
        metrics.incFailure('row_count')
      }
    }

    // ---- 7. Verify checksums (optional, basic implementation) ------------
    console.log('Verifying checksums...')
    for (const table of TABLES) {
      try {
        // Simple checksum by concatenating all columns (adjust based on your schema)
        const primaryChecksumResult = await restorePool.query(`
          SELECT md5(string_agg(md5(information_schema.columns::text), '')) AS checksum
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
        `, [table])
        const restoreChecksumResult = await restorePool.query(`
          SELECT md5(string_agg(md5(information_schema.columns::text), '')) AS checksum
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
        `, [RESTORE_SCHEMA, table])
        const primaryChecksum = primaryChecksumResult.rows[0].checksum
        const restoreChecksum = restoreChecksumResult.rows[0].checksum
        const ok = primaryChecksum === restoreChecksum
        record(`Schema checksum for ${table}`, ok)
      } catch (e) {
        record(`Checksum check for ${table}`, false, (e as Error).message)
        metrics.incFailure('checksum')
      }
    }

    // ---- 8. Clean up restore schema --------------------------------------
    await restorePool.query(`DROP SCHEMA IF EXISTS ${RESTORE_SCHEMA} CASCADE`)
    record('Restore schema cleaned up', true)

    const durationSeconds = (Date.now() - start) / 1000
    metrics.observeDuration(durationSeconds)

    // ---- SUMMARY ---------------------------------------------------------
    const failed = results.filter((r) => !r.ok)
    console.log('')
    console.log(`Drill complete — ${results.length - failed.length}/${results.length} checks passed, duration=${durationSeconds.toFixed(2)}s`)
    if (failed.length > 0) {
      console.error('FAILED CHECKS:')
      for (const f of failed) console.error(' •', f.name, f.detail ?? '')
      process.exit(1)
    }
  } catch (err) {
    console.error('Drill crashed:', err)
    metrics.incFailure('unknown')
    process.exit(1)
  } finally {
    if (restorePool) await restorePool.end()
    if (tmpDir) {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true })
      } catch (e) {
        console.warn('Failed to clean up temp dir:', e)
      }
    }
  }
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('restore-verify.ts')

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Drill crashed:', err)
    process.exit(1)
  })
}

export { main as runRestoreVerifyDrill }
