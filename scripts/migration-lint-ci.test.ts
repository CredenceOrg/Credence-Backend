/**
 * Boundary and recovery coverage for scripts/migration-lint-ci.ts (issue #1323).
 *
 * Invariants under test:
 * - Exit contract is deterministic: 0 = pass/skip, 1 = block/error. No throw.
 * - Public interfaces (`lintChangedMigrations`, `runCli`) are preserved.
 * - Partial failure (one unreadable file) does not hide other blockers and
 *   does not crash the gate; it surfaces as typed READ_FAILURE.
 * - Stale state (diff lists a file deleted before lint) is skipped, not fatal.
 * - Retries / concurrent runs are safe: pure functions, no shared module state.
 * - Logs are diagnosable (code + path + suggestion) without file contents.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn() }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() }
})

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { lintChangedMigrations, runCli } from './migration-lint-ci.ts'

const mockExecSync = vi.mocked(execSync)
const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

const SAFE_SQL = `/**
 * Safe: nullable column first.
 */
export async function up(pgm: any) {
  await pgm.sql('ALTER TABLE identities ADD COLUMN slug TEXT NULL')
}
export async function down(pgm: any) {}
`

const BLOCKING_SQL = `
export async function up(pgm: any) {
  await pgm.sql('ALTER TABLE identities ADD COLUMN slug TEXT NOT NULL')
}
export async function down(pgm: any) {}
`

const UNIQUE_SQL = `
export async function up(pgm: any) {
  await pgm.sql('CREATE UNIQUE INDEX idx_identities_slug ON identities (slug)')
}
export async function down(pgm: any) {}
`

function silenceConsole() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  return { log, error }
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.MIGRATION_LINT_BASE_SHA
  delete process.env.GITHUB_BASE_REF
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.MIGRATION_LINT_BASE_SHA
  delete process.env.GITHUB_BASE_REF
})

describe('lintChangedMigrations — success and rejection', () => {
  it('returns no failures for a valid safe migration', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(SAFE_SQL)
    expect(lintChangedMigrations(['src/migrations/001_safe.ts'])).toEqual([])
  })

  it('returns empty for empty input (valid boundary)', () => {
    expect(lintChangedMigrations([])).toEqual([])
  })

  it('flags invalid blocking SQL with ADD_COLUMN_NOT_NULL', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(BLOCKING_SQL)
    const failures = lintChangedMigrations(['src/migrations/999_bad.ts'])
    expect(failures).toHaveLength(1)
    expect(failures[0]!.ok).toBe(false)
    if (!failures[0]!.ok) {
      expect(failures[0]!.code).toBe('ADD_COLUMN_NOT_NULL')
    }
  })

  it('flags duplicate blocking inputs once per occurrence without losing data', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(BLOCKING_SQL)
    const failures = lintChangedMigrations([
      'src/migrations/999_bad.ts',
      'src/migrations/999_bad.ts',
    ])
    expect(failures).toHaveLength(2)
    for (const f of failures) {
      expect(f.ok).toBe(false)
    }
  })

  it('collects partial failures: one blocker + one safe file', () => {
    mockExistsSync.mockImplementation(((p: unknown) => true) as typeof existsSync)
    mockReadFileSync.mockImplementation(
      ((p: unknown) => (String(p).includes('bad') ? BLOCKING_SQL : SAFE_SQL)) as typeof readFileSync,
    )
    const failures = lintChangedMigrations([
      'src/migrations/999_bad.ts',
      'src/migrations/001_safe.ts',
    ])
    expect(failures).toHaveLength(1)
    if (!failures[0]!.ok) {
      expect(failures[0]!.message).toContain('999_bad.ts')
    }
  })
})

describe('lintChangedMigrations — boundary and recovery', () => {
  it('skips stale files that no longer exist (deleted after diff)', () => {
    mockExistsSync.mockReturnValue(false)
    const failures = lintChangedMigrations(['src/migrations/999_gone.ts'])
    expect(failures).toEqual([])
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })

  it('mixes stale + blocking: stale skipped, blocker still reported', () => {
    mockExistsSync.mockImplementation(
      ((p: unknown) => !String(p).includes('gone')) as typeof existsSync,
    )
    mockReadFileSync.mockReturnValue(BLOCKING_SQL)
    const failures = lintChangedMigrations([
      'src/migrations/999_gone.ts',
      'src/migrations/999_bad.ts',
    ])
    expect(failures).toHaveLength(1)
  })

  it('recovers from read permission failure as typed READ_FAILURE (no throw)', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    const failures = lintChangedMigrations(['src/migrations/999_locked.ts'])
    expect(failures).toHaveLength(1)
    expect(failures[0]!.ok).toBe(false)
    if (!failures[0]!.ok) {
      expect(failures[0]!.code).toBe('READ_FAILURE')
      expect(failures[0]!.message).toContain('999_locked.ts')
      expect(failures[0]!.message).toContain('EACCES')
      // Must not leak file content; message only carries path + reason.
      expect(failures[0]!.message).not.toContain('NOT NULL')
    }
  })

  it('partial I/O failure does not hide a separate blocker', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(((p: unknown) => {
      if (String(p).includes('locked')) throw new Error('EBUSY: resource busy')
      return BLOCKING_SQL
    }) as unknown as typeof readFileSync)
    const failures = lintChangedMigrations([
      'src/migrations/999_locked.ts',
      'src/migrations/999_bad.ts',
    ])
    expect(failures).toHaveLength(2)
    const codes = failures.map((f) => (!f.ok ? f.code : 'ok')).sort()
    expect(codes).toEqual(['ADD_COLUMN_NOT_NULL', 'READ_FAILURE'])
  })

  it('handles empty file content deterministically as pass', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('')
    expect(lintChangedMigrations(['src/migrations/999_empty.ts'])).toEqual([])
  })

  it('is retry-safe: repeated calls return identical results', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(BLOCKING_SQL)
    const first = lintChangedMigrations(['src/migrations/999_bad.ts'])
    const second = lintChangedMigrations(['src/migrations/999_bad.ts'])
    expect(second).toEqual(first)
  })
})

describe('runCli — base-ref resolution and skip boundaries', () => {
  it('skips with 0 when no base ref is provided (loading state)', () => {
    const { log } = silenceConsole()
    expect(runCli([])).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no base ref'))
  })

  it('prefers argv over env vars', () => {
    const { log } = silenceConsole()
    process.env.MIGRATION_LINT_BASE_SHA = 'env-sha-should-lose'
    mockExecSync.mockReturnValue('')
    expect(runCli(['abc1234'])).toBe(0)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('abc1234...HEAD'),
      expect.anything(),
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no numbered migration'))
  })

  it('uses MIGRATION_LINT_BASE_SHA env fallback', () => {
    silenceConsole()
    process.env.MIGRATION_LINT_BASE_SHA = 'abc1234'
    mockExecSync.mockReturnValue('')
    expect(runCli([])).toBe(0)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('abc1234...HEAD'),
      expect.anything(),
    )
  })

  it('uses GITHUB_BASE_REF with origin/ prefix for short branch names', () => {
    silenceConsole()
    process.env.GITHUB_BASE_REF = 'main'
    mockExecSync.mockReturnValue('')
    expect(runCli([])).toBe(0)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('origin/main...HEAD'),
      expect.anything(),
    )
  })

  it('passes full SHAs through without origin/ prefix (boundary: 7 and 40 hex)', () => {
    silenceConsole()
    const sha7 = 'abc1234'
    const sha40 = 'a'.repeat(40)
    mockExecSync.mockReturnValue('')
    expect(runCli([sha7])).toBe(0)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining(`${sha7}...HEAD`),
      expect.anything(),
    )
    vi.clearAllMocks()
    mockExecSync.mockReturnValue('')
    expect(runCli([sha40])).toBe(0)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining(`${sha40}...HEAD`),
      expect.anything(),
    )
  })

  it('passes slash refs through without double origin/ prefix', () => {
    silenceConsole()
    mockExecSync.mockReturnValue('')
    expect(runCli(['origin/main'])).toBe(0)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('origin/main...HEAD'),
      expect.anything(),
    )
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining('origin/origin/'),
      expect.anything(),
    )
  })
})

describe('runCli — diff filtering boundaries', () => {
  it('returns 0 when diff output is empty', () => {
    const { log } = silenceConsole()
    mockExecSync.mockReturnValue('')
    expect(runCli(['main'])).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no numbered migration'))
  })

  it('returns 0 when diff output is only whitespace/newlines', () => {
    silenceConsole()
    mockExecSync.mockReturnValue('  \n\n   \n')
    expect(runCli(['main'])).toBe(0)
  })

  it('ignores non-numbered and test files from the diff', () => {
    silenceConsole()
    mockExecSync.mockReturnValue(
      [
        'src/migrations/guardrails.ts',
        'src/migrations/001_foo.test.ts',
        'src/migrations/example-guardrails-migration.ts',
        '',
      ].join('\n'),
    )
    expect(runCli(['main'])).toBe(0)
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })

  it('trims whitespace around diff lines', () => {
    silenceConsole()
    mockExecSync.mockReturnValue('  src/migrations/001_safe.ts  \n')
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(SAFE_SQL)
    expect(runCli(['main'])).toBe(0)
    expect(mockReadFileSync).toHaveBeenCalledWith(
      'src/migrations/001_safe.ts',
      expect.anything(),
    )
  })
})

describe('runCli — failure, recovery, and observability', () => {
  it('returns 1 with typed code when a changed migration is blocking', () => {
    const { error } = silenceConsole()
    mockExecSync.mockReturnValue('src/migrations/999_bad.ts\n')
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(BLOCKING_SQL)
    expect(runCli(['main'])).toBe(1)
    const stderr = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderr).toContain('ADD_COLUMN_NOT_NULL')
    expect(stderr).toContain('suggestion:')
  })

  it('returns 1 for CREATE_UNIQUE_INDEX and keeps suggestion diagnosable', () => {
    const { error } = silenceConsole()
    mockExecSync.mockReturnValue('src/migrations/999_unique.ts\n')
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(UNIQUE_SQL)
    expect(runCli(['main'])).toBe(1)
    const stderr = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderr).toContain('CREATE_UNIQUE_INDEX')
    expect(stderr).not.toContain('NOT NULL')
  })

  it('recovers from git diff failure with exit 1 and diagnosable log (no throw)', () => {
    const { error } = silenceConsole()
    mockExecSync.mockImplementation(() => {
      throw new Error('fatal: unknown revision')
    })
    expect(runCli(['bogus-base'])).toBe(1)
    const stderr = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderr).toContain('failed to diff')
    expect(stderr).toContain('unknown revision')
  })

  it('recovers from lint-stage read failure with exit 1 and READ_FAILURE code', () => {
    const { error } = silenceConsole()
    mockExecSync.mockReturnValue('src/migrations/999_locked.ts\n')
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    expect(runCli(['main'])).toBe(1)
    const stderr = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderr).toContain('READ_FAILURE')
  })

  it('is idempotent across retries: same inputs give same exit code', () => {
    silenceConsole()
    mockExecSync.mockReturnValue('src/migrations/999_bad.ts\n')
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(BLOCKING_SQL)
    expect(runCli(['main'])).toBe(1)
    expect(runCli(['main'])).toBe(1)
  })

  it('does not expose file contents in error output', () => {
    const { error } = silenceConsole()
    const secret = 'SUPER_SECRET_PAYLOAD_XYZ'
    mockExecSync.mockReturnValue('src/migrations/999_bad.ts\n')
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(`${BLOCKING_SQL}\n-- ${secret}\n`)
    expect(runCli(['main'])).toBe(1)
    const stderr = error.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderr).not.toContain(secret)
  })
})
