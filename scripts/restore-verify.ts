#!/usr/bin/env tsx
/* eslint-disable no-console */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import dotenv from 'dotenv'
import pg from 'pg'
import { createBackupVerifyMetrics, type BackupVerifyMetrics } from '../src/jobs/backupVerifyMetrics.js'

dotenv.config()
const execFilePromise = promisify(execFile)
const { Pool } = pg

const RESTORE_SCHEMA = 'restore_verify'
const TABLES = ['identities', 'bonds', 'attestations', 'payouts', 'audit_logs']

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

export interface DrillResult {
  checks: Check[]
  durationSeconds: number
  passed: boolean
}

/** Shape of every injectable side-effecting dependency. */
export interface RestoreVerifyDeps {
  /** Runs an external process (defaults to promisified execFile). */
  exec: (
    cmd: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>

  /** Returns the current epoch ms (defaults to Date.now). */
  now: () => number

  /** fs.promises subset used by the drill. */
  fsp: {
    mkdtemp: (prefix: string) => Promise<string>
    rm: (p: string, opts: { recursive: boolean; force: boolean }) => Promise<void>
  }

  /** Returns the OS temp dir prefix (defaults to os.tmpdir). */
  tmpdir: () => string

  /** Factory that returns a fresh pg.Pool-like for the given connection string. */
  createPool: (connectionString: string) => PoolLike

  /** Metrics sink (defaults to createBackupVerifyMetrics()). */
  metrics: BackupVerifyMetrics

  /** Logger — defaults to console.log / console.error so normal runs are unaffected. */
  log: (msg: string) => void
  logError: (msg: string, err?: unknown) => void
}

/** Minimal pg.Pool interface needed by the drill. */
export interface PoolLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
}

function defaultDeps(): RestoreVerifyDeps {
  return {
    exec: async (cmd, args, opts) => {
      const result = await execFilePromise(cmd, args, opts ?? {})
      return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
    },
    now: () => Date.now(),
    fsp: fs.promises as unknown as RestoreVerifyDeps['fsp'],
    tmpdir: os.tmpdir,
    createPool: (connectionString) => new Pool({ connectionString }),
    metrics: createBackupVerifyMetrics(),
    log: (msg) => console.log(msg),
    logError: (msg, err) => console.error(msg, err),
  }
}

// ---------------------------------------------------------------------------
// Core drill logic (pure-ish, all side-effects injected)
// ---------------------------------------------------------------------------

export async function runRestoreVerifyDrill(
  deps: Partial<RestoreVerifyDeps> = {},
): Promise<DrillResult> {
  const d: RestoreVerifyDeps = { ...defaultDeps(), ...deps }

  d.log('▶ Backup restore-verify drill')

  const startMs = d.now()
  const checks: Check[] = []
  let tmpDir: string | null = null
  let pool: PoolLike | null = null

  const record = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
    const icon = ok ? '✅' : '❌'
    const tail = detail ? `  — ${detail}` : ''
    d.log(`${icon} ${name}${tail}`)
  }

  try {
    const dbUrl = process.env.DB_URL
    if (!dbUrl) throw new Error('DB_URL must be set')

    // ---- 1. Create temporary directory for dump/restore ------------------
    tmpDir = await d.fsp.mkdtemp(path.join(d.tmpdir(), 'restore-verify-'))
    d.log(`Temporary directory: ${tmpDir}`)

    // ---- 2. Dump current DB (local dev; swap for real snapshot retrieval) -
    const dumpPath = path.join(tmpDir, 'latest.dump')
    d.log('Creating test dump from current DB...')
    await d.exec('pg_dump', ['--format=c', '--file', dumpPath, dbUrl])
    record('Snapshot retrieved (local test dump)', true)

    // ---- 3. Create restore pool and schema --------------------------------
    pool = d.createPool(dbUrl)
    await pool.query(`DROP SCHEMA IF EXISTS ${RESTORE_SCHEMA} CASCADE`)
    await pool.query(`CREATE SCHEMA ${RESTORE_SCHEMA}`)
    record('Isolated restore schema created', true)

    // ---- 4. Restore snapshot into the isolated schema --------------------
    d.log('Restoring snapshot...')
    const restoreEnv = { ...process.env, PGOPTIONS: `-c search_path=${RESTORE_SCHEMA}` }
    await d.exec(
      'pg_restore',
      ['--schema=public', '--no-owner', '--no-acl', '--dbname', dbUrl, dumpPath],
      { env: restoreEnv },
    )
    record('Snapshot restored successfully', true)

    // ---- 5. Rename restored tables to restore schema ---------------------
    for (const table of TABLES) {
      try {
        await pool.query(
          `ALTER TABLE IF EXISTS public.${table} SET SCHEMA ${RESTORE_SCHEMA}`,
        )
      } catch {
        // Ignore: table may not exist in public after restore
      }
    }

    // ---- 6. Verify row counts --------------------------------------------
    d.log('Verifying row counts...')
    for (const table of TABLES) {
      const primaryResult = await pool.query(
        `SELECT COUNT(*) AS count FROM public.${table}`,
      )
      const restoreResult = await pool.query(
        `SELECT COUNT(*) AS count FROM ${RESTORE_SCHEMA}.${table}`,
      )
      const primaryCount = parseInt(String(primaryResult.rows[0]!.count), 10)
      const restoreCount = parseInt(String(restoreResult.rows[0]!.count), 10)
      const ok = primaryCount === restoreCount
      record(
        `Row count check for ${table}`,
        ok,
        `primary=${primaryCount}, restore=${restoreCount}`,
      )
      if (!ok) d.metrics.incFailure('row_count')
    }

    // ---- 7. Verify schema checksums (structural, not data) ---------------
    d.log('Verifying checksums...')
    for (const table of TABLES) {
      try {
        const primaryChecksumResult = await pool.query(
          `SELECT md5(string_agg(md5(information_schema.columns::text), '')) AS checksum
           FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1`,
          [table],
        )
        const restoreChecksumResult = await pool.query(
          `SELECT md5(string_agg(md5(information_schema.columns::text), '')) AS checksum
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2`,
          [RESTORE_SCHEMA, table],
        )
        const primaryChecksum = primaryChecksumResult.rows[0]!.checksum
        const restoreChecksum = restoreChecksumResult.rows[0]!.checksum
        record(`Schema checksum for ${table}`, primaryChecksum === restoreChecksum)
      } catch (e) {
        record(`Checksum check for ${table}`, false, (e as Error).message)
        d.metrics.incFailure('checksum')
      }
    }

    // ---- 8. Clean up restore schema --------------------------------------
    await pool.query(`DROP SCHEMA IF EXISTS ${RESTORE_SCHEMA} CASCADE`)
    record('Restore schema cleaned up', true)

    const durationSeconds = (d.now() - startMs) / 1000
    d.metrics.observeDuration(durationSeconds)

    // ---- SUMMARY ---------------------------------------------------------
    const failed = checks.filter((c) => !c.ok)
    d.log(
      `Drill complete — ${checks.length - failed.length}/${checks.length} checks passed, duration=${durationSeconds.toFixed(2)}s`,
    )
    if (failed.length > 0) {
      d.logError('FAILED CHECKS:')
      for (const f of failed) d.logError(` • ${f.name} ${f.detail ?? ''}`)
    }

    return { checks, durationSeconds, passed: failed.length === 0 }
  } catch (err) {
    d.logError('Drill crashed:', err)
    d.metrics.incFailure('unknown')
    // Re-throw so CLI callers can exit(1); tests can catch for assertions.
    throw err
  } finally {
    if (pool) {
      try {
        await pool.end()
      } catch {
        // Best-effort cleanup
      }
    }
    if (tmpDir) {
      try {
        await d.fsp.rm(tmpDir, { recursive: true, force: true })
      } catch (e) {
        d.logError('Failed to clean up temp dir:', e)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly
// ---------------------------------------------------------------------------

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('restore-verify.ts')

if (invokedDirectly) {
  runRestoreVerifyDrill().catch((err) => {
    console.error('Drill crashed:', err)
    process.exit(1)
  })
}
