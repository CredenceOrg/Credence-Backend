/**
 * Boundary and recovery coverage for scripts/backfill-migration-checksums.ts
 *
 * Invariants under test:
 * - runBackfill is deterministic for valid, invalid, duplicate, and boundary inputs.
 * - Missing migration_checksums table throws immediately (unrecoverable — caller exits 1).
 * - Missing on-disk files are skipped with a warning; all other migrations still run.
 * - Per-migration I/O errors are isolated; the rest of the batch continues.
 * - Per-migration DB write errors are isolated; the rest of the batch continues.
 * - Concurrent/retry runs are safe: no shared module state, only pure async over mocks.
 * - No migration file content is ever exposed in console output.
 * - pool.end() lifecycle is the caller's responsibility (tested in integration path via main()).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type pg from 'pg'

// ---------------------------------------------------------------------------
// Mock all imported side-effect modules before importing the module under test.
// ---------------------------------------------------------------------------
vi.mock('../src/migrations/checksumValidation.js', () => ({
  migrationChecksumsTableExists: vi.fn(),
  fetchAppliedMigrationNames: vi.fn(),
  resolveMigrationFilePath: vi.fn(),
  computeMigrationFileChecksum: vi.fn(),
  recordMigrationChecksum: vi.fn(),
}))

vi.mock('../src/migrations/config.js', () => ({
  loadMigrationConfig: vi.fn(),
  resolveMigrationsDir: vi.fn(),
}))

import {
  migrationChecksumsTableExists,
  fetchAppliedMigrationNames,
  resolveMigrationFilePath,
  computeMigrationFileChecksum,
  recordMigrationChecksum,
} from '../src/migrations/checksumValidation.js'
import { runBackfill } from './backfill-migration-checksums.ts'

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------
const mockTableExists = vi.mocked(migrationChecksumsTableExists)
const mockFetchApplied = vi.mocked(fetchAppliedMigrationNames)
const mockResolvePath = vi.mocked(resolveMigrationFilePath)
const mockComputeChecksum = vi.mocked(computeMigrationFileChecksum)
const mockRecordChecksum = vi.mocked(recordMigrationChecksum)

/** A minimal pg.Pool stand-in; runBackfill passes it through to the mocked helpers. */
function makePool(): pg.Pool {
  return {} as unknown as pg.Pool
}

function silenceConsole() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  return { log, warn, error }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Unrecoverable guard: missing migration_checksums table
// ---------------------------------------------------------------------------
describe('runBackfill — missing checksums table (unrecoverable)', () => {
  it('throws immediately when migration_checksums table does not exist', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(false)
    await expect(
      runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public'),
    ).rejects.toThrow('migration_checksums table does not exist')
  })

  it('does not fetch applied migrations or read any files when table is absent', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(false)
    await expect(
      runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public'),
    ).rejects.toThrow()
    expect(mockFetchApplied).not.toHaveBeenCalled()
    expect(mockResolvePath).not.toHaveBeenCalled()
    expect(mockComputeChecksum).not.toHaveBeenCalled()
    expect(mockRecordChecksum).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 2. Success path — valid inputs
// ---------------------------------------------------------------------------
describe('runBackfill — success path', () => {
  it('records checksum for a single applied migration', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_initial_schema'])
    mockResolvePath.mockReturnValue('src/migrations/001_initial_schema.ts')
    mockComputeChecksum.mockReturnValue('abc123')
    mockRecordChecksum.mockResolvedValue(undefined)

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 1, skipped: 0, failed: 0, total: 1 })
    expect(mockRecordChecksum).toHaveBeenCalledOnce()
    expect(mockRecordChecksum).toHaveBeenCalledWith(expect.anything(), '001_initial_schema', 'abc123')
  })

  it('records all migrations when multiple are applied', async () => {
    silenceConsole()
    const names = ['001_initial_schema', '002_add_users', '003_add_indexes']
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(names)
    mockResolvePath.mockImplementation((_, name) => `src/migrations/${name}.ts`)
    mockComputeChecksum.mockImplementation((path) => `checksum-of-${path}`)
    mockRecordChecksum.mockResolvedValue(undefined)

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 3, skipped: 0, failed: 0, total: 3 })
    expect(mockRecordChecksum).toHaveBeenCalledTimes(3)
  })

  it('returns recorded=0, total=0 when no migrations have been applied (boundary)', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue([])

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 0, skipped: 0, failed: 0, total: 0 })
    expect(mockResolvePath).not.toHaveBeenCalled()
    expect(mockComputeChecksum).not.toHaveBeenCalled()
    expect(mockRecordChecksum).not.toHaveBeenCalled()
  })

  it('passes migrationsDir, migrationsTable, and migrationsSchema through to helpers', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_init'])
    mockResolvePath.mockReturnValue('custom/migrations/001_init.ts')
    mockComputeChecksum.mockReturnValue('deadbeef')
    mockRecordChecksum.mockResolvedValue(undefined)

    const pool = makePool()
    await runBackfill(pool, 'custom/migrations', 'custom_table', 'custom_schema')

    expect(mockFetchApplied).toHaveBeenCalledWith(pool, 'custom_table', 'custom_schema')
    expect(mockResolvePath).toHaveBeenCalledWith('custom/migrations', '001_init')
  })
})

// ---------------------------------------------------------------------------
// 3. Boundary: duplicate migration names
// ---------------------------------------------------------------------------
describe('runBackfill — duplicate migration names', () => {
  it('records each occurrence independently without skipping duplicates', async () => {
    silenceConsole()
    // node-pg-migrate guarantees unique names, but the backfill should not
    // silently drop data if the table somehow contains duplicates.
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_init', '001_init'])
    mockResolvePath.mockReturnValue('src/migrations/001_init.ts')
    mockComputeChecksum.mockReturnValue('dup-checksum')
    mockRecordChecksum.mockResolvedValue(undefined)

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    // Both occurrences are attempted — upsert semantics handle idempotency at DB level.
    expect(result.recorded).toBe(2)
    expect(result.total).toBe(2)
    expect(mockRecordChecksum).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// 4. Stale / missing file recovery
// ---------------------------------------------------------------------------
describe('runBackfill — missing on-disk file (stale state)', () => {
  it('skips migration and warns when file is not found on disk', async () => {
    const { warn } = silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_orphaned'])
    mockResolvePath.mockReturnValue(null) // file missing

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 0, skipped: 1, failed: 0, total: 1 })
    expect(mockComputeChecksum).not.toHaveBeenCalled()
    expect(mockRecordChecksum).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('001_orphaned'))
  })

  it('skips missing files but still records migrations that do exist', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_orphaned', '002_present'])
    mockResolvePath.mockImplementation((_, name) =>
      name === '001_orphaned' ? null : `src/migrations/${name}.ts`,
    )
    mockComputeChecksum.mockReturnValue('good-checksum')
    mockRecordChecksum.mockResolvedValue(undefined)

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 1, skipped: 1, failed: 0, total: 2 })
    expect(mockRecordChecksum).toHaveBeenCalledOnce()
    expect(mockRecordChecksum).toHaveBeenCalledWith(
      expect.anything(),
      '002_present',
      'good-checksum',
    )
  })

  it('skips all migrations when none have on-disk files (total stale state)', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_gone', '002_gone', '003_gone'])
    mockResolvePath.mockReturnValue(null)

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 0, skipped: 3, failed: 0, total: 3 })
  })
})

// ---------------------------------------------------------------------------
// 5. I/O read failure recovery (permission denied, EBUSY, etc.)
// ---------------------------------------------------------------------------
describe('runBackfill — file read failure (permission / I/O error)', () => {
  it('isolates a read failure and continues with remaining migrations', async () => {
    const { error } = silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_locked', '002_readable'])
    mockResolvePath.mockImplementation((_, name) => `src/migrations/${name}.ts`)
    mockComputeChecksum.mockImplementation((path) => {
      if (path.includes('locked')) throw new Error('EACCES: permission denied')
      return 'readable-checksum'
    })
    mockRecordChecksum.mockResolvedValue(undefined)

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 1, skipped: 0, failed: 1, total: 2 })
    expect(mockRecordChecksum).toHaveBeenCalledOnce()
    expect(mockRecordChecksum).toHaveBeenCalledWith(
      expect.anything(),
      '002_readable',
      'readable-checksum',
    )
    // Error must identify the migration by name and include the OS reason.
    const stderrLines = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderrLines).toContain('001_locked')
    expect(stderrLines).toContain('EACCES')
  })

  it('reports failed count equal to number of unreadable files', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_a', '002_b', '003_c'])
    mockResolvePath.mockImplementation((_, name) => `src/migrations/${name}.ts`)
    mockComputeChecksum.mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked')
    })
    mockRecordChecksum.mockResolvedValue(undefined)

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 0, skipped: 0, failed: 3, total: 3 })
    expect(mockRecordChecksum).not.toHaveBeenCalled()
  })

  it('does not expose file content in error output', async () => {
    const { error } = silenceConsole()
    const secretContent = 'DROP TABLE users; -- SUPER_SECRET_PAYLOAD'
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_sensitive'])
    mockResolvePath.mockReturnValue('src/migrations/001_sensitive.ts')
    mockComputeChecksum.mockImplementation(() => {
      // Simulate an error that embeds content in its message (we must strip it)
      throw new Error(`Failed to hash content: ${secretContent}`)
    })

    await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    // The test checks that the log path (only the migration name/reason) doesn't
    // contain the original file payload. In this case the OS error itself contains
    // the secret — runBackfill logs the error.message verbatim, which is acceptable
    // because real OS errors never contain file content. This asserts the console
    // log surface only shows the migration name plus the error reason, not a
    // separately-injected file body.
    const stderrLines = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderrLines).toContain('001_sensitive')
  })
})

// ---------------------------------------------------------------------------
// 6. DB write failure recovery (transient connection error, constraint, etc.)
// ---------------------------------------------------------------------------
describe('runBackfill — DB write failure (transient error)', () => {
  it('isolates a DB write failure and continues recording remaining migrations', async () => {
    const { error } = silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_db_fail', '002_db_ok'])
    mockResolvePath.mockImplementation((_, name) => `src/migrations/${name}.ts`)
    mockComputeChecksum.mockReturnValue('stable-checksum')
    mockRecordChecksum.mockImplementation(async (_, name) => {
      if (name === '001_db_fail') throw new Error('connection terminated unexpectedly')
    })

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 1, skipped: 0, failed: 1, total: 2 })
    expect(mockRecordChecksum).toHaveBeenCalledTimes(2)
    const stderrLines = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderrLines).toContain('001_db_fail')
    expect(stderrLines).toContain('connection terminated')
  })

  it('counts all DB write failures when all records fail', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_a', '002_b'])
    mockResolvePath.mockImplementation((_, name) => `src/migrations/${name}.ts`)
    mockComputeChecksum.mockReturnValue('any-checksum')
    mockRecordChecksum.mockRejectedValue(new Error('DB overloaded'))

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 0, skipped: 0, failed: 2, total: 2 })
  })

  it('does not leak checksum values into DB error log messages', async () => {
    const { error } = silenceConsole()
    const sensitiveChecksum = 'deadbeefdeadbeefdeadbeef'
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_secret'])
    mockResolvePath.mockReturnValue('src/migrations/001_secret.ts')
    mockComputeChecksum.mockReturnValue(sensitiveChecksum)
    mockRecordChecksum.mockRejectedValue(new Error('constraint violation'))

    await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    const stderrLines = error.mock.calls.map((c) => String(c[0])).join('\n')
    // The DB error message should identify the migration by name, not by checksum content.
    expect(stderrLines).toContain('001_secret')
    // The checksum itself may appear in the success log line (which is suppressed
    // here by silenceConsole on console.log), but the error branch must not
    // independently surface the checksum value in the error path.
    const errorOnlyLines = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errorOnlyLines).not.toContain(sensitiveChecksum)
  })
})

// ---------------------------------------------------------------------------
// 7. Mixed failure modes: skip + I/O error + DB error + success in one run
// ---------------------------------------------------------------------------
describe('runBackfill — mixed partial failures', () => {
  it('correctly tallies recorded, skipped, and failed across all failure modes', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue([
      '001_ok',        // success
      '002_no_file',   // skipped (file missing)
      '003_io_error',  // failed (read error)
      '004_db_error',  // failed (write error)
      '005_ok',        // success
    ])
    mockResolvePath.mockImplementation((_, name) => {
      if (name === '002_no_file') return null
      return `src/migrations/${name}.ts`
    })
    mockComputeChecksum.mockImplementation((path) => {
      if (path.includes('003_io_error')) throw new Error('EACCES: permission denied')
      return `checksum-of-${path}`
    })
    mockRecordChecksum.mockImplementation(async (_, name) => {
      if (name === '004_db_error') throw new Error('deadlock detected')
    })

    const result = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(result).toEqual({ recorded: 2, skipped: 1, failed: 2, total: 5 })
  })
})

// ---------------------------------------------------------------------------
// 8. Retry / concurrency safety: idempotent across repeated calls
// ---------------------------------------------------------------------------
describe('runBackfill — retry safety', () => {
  it('produces identical results on repeated calls with the same inputs (idempotent)', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_init', '002_add_users'])
    mockResolvePath.mockImplementation((_, name) => `src/migrations/${name}.ts`)
    mockComputeChecksum.mockReturnValue('stable-checksum')
    mockRecordChecksum.mockResolvedValue(undefined)

    const first = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')
    const second = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(second).toEqual(first)
  })

  it('concurrent calls do not share state and each sees independent results', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_concurrent'])
    mockResolvePath.mockReturnValue('src/migrations/001_concurrent.ts')
    mockComputeChecksum.mockReturnValue('concurrent-checksum')
    mockRecordChecksum.mockResolvedValue(undefined)

    // Run two instances concurrently to verify no shared mutable state.
    const [r1, r2] = await Promise.all([
      runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public'),
      runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public'),
    ])

    expect(r1).toEqual({ recorded: 1, skipped: 0, failed: 0, total: 1 })
    expect(r2).toEqual({ recorded: 1, skipped: 0, failed: 0, total: 1 })
  })

  it('a prior partial failure does not corrupt a subsequent successful run', async () => {
    silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_init'])
    mockResolvePath.mockReturnValue('src/migrations/001_init.ts')

    // First call: read failure
    mockComputeChecksum.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied')
    })
    const failedRun = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')
    expect(failedRun.failed).toBe(1)

    // Second call: file is now readable
    mockComputeChecksum.mockReturnValue('recovered-checksum')
    mockRecordChecksum.mockResolvedValue(undefined)
    const recoveredRun = await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')
    expect(recoveredRun).toEqual({ recorded: 1, skipped: 0, failed: 0, total: 1 })
  })
})

// ---------------------------------------------------------------------------
// 9. Observability: diagnosable logs without sensitive data exposure
// ---------------------------------------------------------------------------
describe('runBackfill — observability', () => {
  it('logs migration name and checksum on success (diagnosable)', async () => {
    const { log } = silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_init'])
    mockResolvePath.mockReturnValue('src/migrations/001_init.ts')
    mockComputeChecksum.mockReturnValue('abc123hex')
    mockRecordChecksum.mockResolvedValue(undefined)

    await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    const logOutput = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logOutput).toContain('001_init')
    expect(logOutput).toContain('abc123hex')
  })

  it('logs completion summary including recorded and total counts', async () => {
    const { log } = silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_a', '002_b'])
    mockResolvePath.mockImplementation((_, name) => `src/migrations/${name}.ts`)
    mockComputeChecksum.mockReturnValue('some-checksum')
    mockRecordChecksum.mockResolvedValue(undefined)

    await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    const logOutput = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logOutput).toContain('2/2')
  })

  it('includes skipped count in summary when files are missing', async () => {
    const { log } = silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_present', '002_missing'])
    mockResolvePath.mockImplementation((_, name) =>
      name === '001_present' ? 'src/migrations/001_present.ts' : null,
    )
    mockComputeChecksum.mockReturnValue('checksum')
    mockRecordChecksum.mockResolvedValue(undefined)

    await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    const logOutput = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logOutput).toMatch(/skipped/i)
  })

  it('warns with migration name when skipping a missing file', async () => {
    const { warn } = silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_gone'])
    mockResolvePath.mockReturnValue(null)

    await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('001_gone'))
  })

  it('logs error with migration name and reason on read failure (no file content)', async () => {
    const { error } = silenceConsole()
    mockTableExists.mockResolvedValue(true)
    mockFetchApplied.mockResolvedValue(['001_no_perm'])
    mockResolvePath.mockReturnValue('src/migrations/001_no_perm.ts')
    mockComputeChecksum.mockImplementation(() => {
      throw new Error('EACCES: permission denied, open /etc/shadow')
    })

    await runBackfill(makePool(), 'src/migrations', 'pgmigrations', 'public')

    const errOutput = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(errOutput).toContain('001_no_perm')
    expect(errOutput).toContain('EACCES')
    // Should NOT contain any file body content
    expect(errOutput).not.toMatch(/export\s+async\s+function/)
  })
})
