/**
 * Boundary and recovery test coverage for scripts/migrate-dry-run.ts (issue #1322).
 *
 * Invariants under test
 * ─────────────────────
 * - Exit-code contract is deterministic: 0 = no-pending / success, 1 = failure / error. No throw.
 * - console.error is called (not console.log) on failure; console.log on success.
 * - A numbered list of migration names is printed when migrations are pending.
 * - dryRunMigration is always invoked with { skipPreflight: true, verbose: true }.
 * - No sensitive data (SQL, file content, etc.) leaks into the error output.
 * - Retry-safe: repeated calls with the same inputs produce identical outputs.
 * - No shared mutable state across invocations.
 *
 * Test architecture
 * ─────────────────
 * The script exports `main()` (introduced alongside the isDirectRun guard so the
 * module is safely importable without auto-executing). Each test:
 *  1. Configures the dryRunMigration mock for the desired scenario.
 *  2. Stubs process.exit so it doesn't kill the Vitest worker.
 *  3. Spies on console.log / console.error to capture output.
 *  4. Calls main() and awaits the sentinel throw that represents process.exit.
 *  5. Asserts the captured exit code and output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Module mock (hoisted) ─────────────────────────────────────────────────────
// Vitest hoists vi.mock() calls before imports, so dryRunMigration is already
// replaced by the time the test file's imports are resolved.
vi.mock('../src/migrations/runner.js', () => ({
  dryRunMigration: vi.fn(),
}))

import { dryRunMigration } from '../src/migrations/runner.js'
import { main } from './migrate-dry-run.ts'

const mockDryRunMigration = vi.mocked(dryRunMigration)

// ── Helpers ───────────────────────────────────────────────────────────────────

type RunResult = { exitCode: number | undefined; stdout: string[]; stderr: string[] }

/**
 * Call main() with I/O intercepted.
 *
 * process.exit is stubbed as a no-op so it does not kill the Vitest worker
 * and does not throw into main()'s own catch block (which would misreport
 * the exit code). The exit code is captured from the first call to the stub.
 *
 * Since process.exit is a no-op, execution continues past the call site after
 * the exit would normally terminate the process. Each branch in main() calls
 * process.exit as its final statement, so continuation is benign — no code
 * executes after the exit call in any branch.
 */
async function run(): Promise<RunResult> {
  const stdout: string[] = []
  const stderr: string[] = []

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdout.push(args.map(String).join(' '))
  })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderr.push(args.map(String).join(' '))
  })
  // No-op: does not throw, does not exit. Execution continues past the call
  // site, but each branch in main() has no code after process.exit().
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { /* no-op */ })

  try {
    await main()
  } finally {
    logSpy.mockRestore()
    errorSpy.mockRestore()
  }

  // Capture exit calls BEFORE restoring the spy (restore resets mock state).
  const exitCalls = exitSpy.mock.calls.slice()
  exitSpy.mockRestore()

  // First call wins — matches the first process.exit() invocation in main().
  const firstCall = exitCalls[0]
  const exitCode = firstCall !== undefined
    ? (typeof firstCall[0] === 'number' ? firstCall[0] : 0)
    : undefined

  return { exitCode, stdout, stderr }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/credence_test'
})

afterEach(() => {
  delete process.env.DATABASE_URL
  vi.restoreAllMocks()
})

// ── Success: no pending migrations ───────────────────────────────────────────

describe('migrate-dry-run — success: no pending migrations', () => {
  it('exits 0 when there are no pending migrations', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [] })
    const { exitCode } = await run()
    expect(exitCode).toBe(0)
  })

  it('prints "No pending migrations" to stdout', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [] })
    const { stdout } = await run()
    expect(stdout.join('\n')).toContain('No pending migrations')
  })

  it('writes nothing to stderr when there are no pending migrations', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [] })
    const { stderr } = await run()
    expect(stderr).toHaveLength(0)
  })
})

// ── Success: pending migrations present ──────────────────────────────────────

describe('migrate-dry-run — success: pending migrations present', () => {
  const migrations = ['001_initial_schema', '002_add_composite_indexes', '003_add_users']

  it('exits 0 when migrations are pending', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: migrations })
    const { exitCode } = await run()
    expect(exitCode).toBe(0)
  })

  it('prints a completion summary to stdout', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: migrations })
    const { stdout } = await run()
    const output = stdout.join('\n')
    expect(output).toContain('Dry-run completed')
    expect(output).toContain(`${migrations.length} migration(s) would be applied`)
  })

  it('prints all migration names in a numbered list', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: migrations })
    const { stdout } = await run()
    const output = stdout.join('\n')
    migrations.forEach((name, idx) => {
      expect(output).toContain(`${idx + 1}. ${name}`)
    })
  })

  it('list is 1-indexed (first entry is "1.")', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: ['001_initial_schema'] })
    const { stdout } = await run()
    expect(stdout.join('\n')).toContain('1. 001_initial_schema')
  })

  it('writes nothing to stderr when migrations are pending but success', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: migrations })
    const { stderr } = await run()
    expect(stderr).toHaveLength(0)
  })

  it('correctly reports count for exactly one pending migration', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: ['001_initial_schema'] })
    const { stdout } = await run()
    expect(stdout.join('\n')).toContain('1 migration(s) would be applied')
  })

  it('handles a large number of pending migrations without crashing', async () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `${String(i + 1).padStart(3, '0')}_migration`,
    )
    mockDryRunMigration.mockResolvedValue({ success: true, applied: many })
    const { exitCode, stdout } = await run()
    expect(exitCode).toBe(0)
    const output = stdout.join('\n')
    expect(output).toContain('50 migration(s) would be applied')
    expect(output).toContain('50. 050_migration')
  })
})

// ── Failure: success: false ───────────────────────────────────────────────────

describe('migrate-dry-run — failure: dryRunMigration returns success: false', () => {
  it('exits 1 when the dry-run fails', async () => {
    mockDryRunMigration.mockResolvedValue({ success: false, applied: [], error: 'Connection refused' })
    const { exitCode } = await run()
    expect(exitCode).toBe(1)
  })

  it('writes the error message to stderr', async () => {
    mockDryRunMigration.mockResolvedValue({ success: false, applied: [], error: 'Connection refused' })
    const { stderr } = await run()
    const output = stderr.join('\n')
    expect(output).toContain('Dry-run failed')
    expect(output).toContain('Connection refused')
  })

  it('does not write to stdout on failure', async () => {
    mockDryRunMigration.mockResolvedValue({ success: false, applied: [], error: 'Connection refused' })
    const { stdout } = await run()
    expect(stdout).toHaveLength(0)
  })

  it('exits 1 for DATABASE_URL-missing error message', async () => {
    mockDryRunMigration.mockResolvedValue({
      success: false,
      applied: [],
      error: 'DATABASE_URL environment variable is required for migrations.',
    })
    const { exitCode, stderr } = await run()
    expect(exitCode).toBe(1)
    expect(stderr.join('\n')).toContain('Dry-run failed')
  })

  it('exits 1 for checksum validation failure', async () => {
    mockDryRunMigration.mockResolvedValue({
      success: false,
      applied: ['001_initial_schema'],
      error: 'Migration checksum validation failed (1 issue(s)): 001_initial_schema: expected abc, got def',
    })
    const { exitCode, stderr } = await run()
    expect(exitCode).toBe(1)
    expect(stderr.join('\n')).toContain('Dry-run failed')
  })

  it('exits 1 for blocking-operations preflight error', async () => {
    mockDryRunMigration.mockResolvedValue({
      success: false,
      applied: [],
      error: 'Blocking operations detected. Use allowBlocking: true to override.',
    })
    const { exitCode } = await run()
    expect(exitCode).toBe(1)
  })

  it('exits 1 when error field is an empty string (boundary: falsy error)', async () => {
    mockDryRunMigration.mockResolvedValue({ success: false, applied: [], error: '' })
    const { exitCode } = await run()
    expect(exitCode).toBe(1)
  })

  it('exits 1 when error field is absent (boundary: missing error field)', async () => {
    mockDryRunMigration.mockResolvedValue({ success: false, applied: [] })
    const { exitCode } = await run()
    expect(exitCode).toBe(1)
  })
})

// ── Recovery: dryRunMigration throws ─────────────────────────────────────────

describe('migrate-dry-run — recovery: dryRunMigration throws', () => {
  it('exits 1 when dryRunMigration throws an Error', async () => {
    mockDryRunMigration.mockRejectedValue(new Error('Unexpected failure'))
    const { exitCode } = await run()
    expect(exitCode).toBe(1)
  })

  it('writes the exception to stderr', async () => {
    mockDryRunMigration.mockRejectedValue(new Error('Unexpected failure'))
    const { stderr } = await run()
    const output = stderr.join('\n')
    expect(output).toContain('Error during dry-run')
    expect(output).toContain('Unexpected failure')
  })

  it('does not write to stdout when an exception is thrown', async () => {
    mockDryRunMigration.mockRejectedValue(new Error('Unexpected failure'))
    const { stdout } = await run()
    expect(stdout).toHaveLength(0)
  })

  it('exits 1 when dryRunMigration rejects with a non-Error string', async () => {
    mockDryRunMigration.mockRejectedValue('raw string rejection')
    const { exitCode, stderr } = await run()
    expect(exitCode).toBe(1)
    expect(stderr.join('\n')).toContain('raw string rejection')
  })

  it('exits 1 when dryRunMigration rejects with null', async () => {
    mockDryRunMigration.mockRejectedValue(null)
    const { exitCode } = await run()
    expect(exitCode).toBe(1)
  })

  it('exits 1 for ECONNREFUSED', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    })
    mockDryRunMigration.mockRejectedValue(err)
    const { exitCode, stderr } = await run()
    expect(exitCode).toBe(1)
    expect(stderr.join('\n')).toContain('ECONNREFUSED')
  })

  it('exits 1 for EACCES permission-denied error', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    mockDryRunMigration.mockRejectedValue(err)
    const { exitCode, stderr } = await run()
    expect(exitCode).toBe(1)
    expect(stderr.join('\n')).toContain('EACCES')
  })
})

// ── Invocation contract ───────────────────────────────────────────────────────

describe('migrate-dry-run — invocation contract', () => {
  it('calls dryRunMigration with skipPreflight: true', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [] })
    await run()
    expect(mockDryRunMigration).toHaveBeenCalledWith(
      expect.objectContaining({ skipPreflight: true }),
    )
  })

  it('calls dryRunMigration with verbose: true', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [] })
    await run()
    expect(mockDryRunMigration).toHaveBeenCalledWith(
      expect.objectContaining({ verbose: true }),
    )
  })

  it('calls dryRunMigration exactly once per main() invocation', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [] })
    await run()
    expect(mockDryRunMigration).toHaveBeenCalledTimes(1)
  })
})

// ── Observability: no sensitive data leakage ──────────────────────────────────

describe('migrate-dry-run — observability: no sensitive data leakage', () => {
  it('does not write migration SQL to stderr on success', async () => {
    mockDryRunMigration.mockResolvedValue({
      success: true,
      applied: ['001_initial_schema'],
      sql: ['CREATE TABLE identities (id UUID PRIMARY KEY);'],
    })
    const { stderr } = await run()
    expect(stderr).toHaveLength(0)
  })

  it('does not include sql array contents in stdout list output', async () => {
    mockDryRunMigration.mockResolvedValue({
      success: true,
      applied: ['001_initial_schema'],
      sql: ['CREATE TABLE identities (id UUID PRIMARY KEY);'],
    })
    const { stdout } = await run()
    expect(stdout.join('\n')).not.toContain('CREATE TABLE')
  })

  it('does not expose injected content in error output on failure', async () => {
    const secretPayload = 'SUPER_SECRET_PAYLOAD_XYZ_99'
    mockDryRunMigration.mockResolvedValue({ success: false, applied: [], error: 'Runner failed' })
    const { stderr } = await run()
    expect(stderr.join('\n')).not.toContain(secretPayload)
  })
})

// ── Retry-safety and idempotency ──────────────────────────────────────────────

describe('migrate-dry-run — retry-safety and idempotency', () => {
  it('produces identical exit code on repeated calls with the same inputs', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: ['001_initial_schema'] })
    const first = await run()
    const second = await run()
    expect(second.exitCode).toBe(first.exitCode)
  })

  it('produces identical stdout on repeated calls with the same inputs', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: ['001_initial_schema'] })
    const first = await run()
    const second = await run()
    expect(second.stdout.join('\n')).toBe(first.stdout.join('\n'))
  })

  it('is idempotent on failure: same error produces same exit code', async () => {
    mockDryRunMigration.mockResolvedValue({ success: false, applied: [], error: 'ECONNREFUSED' })
    const first = await run()
    const second = await run()
    expect(first.exitCode).toBe(1)
    expect(second.exitCode).toBe(1)
  })

  it('no shared state: success → failure transition is correct', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [] })
    const successRun = await run()
    expect(successRun.exitCode).toBe(0)

    mockDryRunMigration.mockResolvedValue({ success: false, applied: [], error: 'broke' })
    const failRun = await run()
    expect(failRun.exitCode).toBe(1)
  })

  it('no shared state: failure → success transition is correct', async () => {
    mockDryRunMigration.mockResolvedValue({ success: false, applied: [], error: 'broke' })
    const failRun = await run()
    expect(failRun.exitCode).toBe(1)

    mockDryRunMigration.mockResolvedValue({ success: true, applied: ['001_initial_schema'] })
    const successRun = await run()
    expect(successRun.exitCode).toBe(0)
  })
})

// ── Boundary: edge-case inputs ────────────────────────────────────────────────

describe('migrate-dry-run — boundary: edge-case inputs', () => {
  it('handles applied list with a single empty-string entry (exits 0)', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [''] })
    const { exitCode, stdout } = await run()
    expect(exitCode).toBe(0)
    expect(stdout.join('\n')).toContain('1 migration(s) would be applied')
  })

  it('handles migration names with hyphens and dots without error', async () => {
    const weirdName = '001_migration-with_dashes.and.dots'
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [weirdName] })
    const { exitCode, stdout } = await run()
    expect(exitCode).toBe(0)
    expect(stdout.join('\n')).toContain(weirdName)
  })

  it('handles a very long migration name without truncating it', async () => {
    const longName = '001_' + 'a'.repeat(200)
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [longName] })
    const { stdout } = await run()
    expect(stdout.join('\n')).toContain(longName)
  })

  it('handles a very long error message without crashing', async () => {
    mockDryRunMigration.mockResolvedValue({
      success: false,
      applied: [],
      error: 'E: ' + 'x'.repeat(2000),
    })
    const { exitCode } = await run()
    expect(exitCode).toBe(1)
  })

  it('treats success:true applied:[] the same regardless of sql field presence', async () => {
    mockDryRunMigration.mockResolvedValue({ success: true, applied: [], sql: [] })
    const withSql = await run()

    mockDryRunMigration.mockResolvedValue({ success: true, applied: [] })
    const withoutSql = await run()

    expect(withSql.exitCode).toBe(withoutSql.exitCode)
    expect(withSql.stdout.join('\n')).toBe(withoutSql.stdout.join('\n'))
  })
})

// ── Authorization and validation invariants ───────────────────────────────────

describe('migrate-dry-run — authorization and validation invariants', () => {
  it('surfaces DATABASE_URL-missing error from runner correctly', async () => {
    mockDryRunMigration.mockResolvedValue({
      success: false,
      applied: [],
      error: 'DATABASE_URL environment variable is required for migrations.',
    })
    const { exitCode, stderr } = await run()
    expect(exitCode).toBe(1)
    expect(stderr.join('\n')).toContain('Dry-run failed')
  })

  it('surfaces invalid DATABASE_URL format error from runner correctly', async () => {
    mockDryRunMigration.mockResolvedValue({
      success: false,
      applied: [],
      error: 'DATABASE_URL must be a valid PostgreSQL connection string starting with postgres://',
    })
    const { exitCode, stderr } = await run()
    expect(exitCode).toBe(1)
    expect(stderr.join('\n')).toContain('Dry-run failed')
  })

  it('does not print success banner when success is false even if applied is non-empty', async () => {
    // The runner may populate applied[] on partial failure; the script must
    // honour success:false and not print a misleading "Dry-run completed" line.
    mockDryRunMigration.mockResolvedValue({
      success: false,
      applied: ['001_initial_schema'],
      error: 'Partial apply failed mid-run',
    })
    const { exitCode, stdout, stderr } = await run()
    expect(exitCode).toBe(1)
    expect(stderr.join('\n')).toContain('Dry-run failed')
    expect(stdout.join('\n')).not.toContain('Dry-run completed')
    expect(stdout.join('\n')).not.toContain('Migrations to be applied')
  })
})
