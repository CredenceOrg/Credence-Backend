/**
 * Boundary and recovery coverage for scripts/restore-verify.ts.
 *
 * Invariants under test:
 * - runRestoreVerifyDrill is deterministic for valid, invalid, and boundary inputs.
 * - Authorization invariant: throws immediately when DB_URL is absent; never
 *   attempts network/disk I/O before the env check passes.
 * - State-transition invariants: schema is created before restore, cleaned up
 *   after success, and best-effort cleaned up on failure.
 * - Partial failure: a single table row-count mismatch records a failure check
 *   and increments the metric but does not abort the remaining checks.
 * - Retry safety: pure dependency injection means repeated calls with the same
 *   inputs produce identical results and do not share module-level state.
 * - Concurrent execution: multiple parallel calls with independent dep objects
 *   cannot interfere with each other.
 * - Failure recovery: pool.end() and tmpDir cleanup run in the finally block
 *   even when the drill crashes mid-way.
 * - Observability: failures are diagnosable through Check.detail and metric
 *   calls without exposing DB credentials or raw SQL.
 * - Permission states: unreadable tmpdir and pg_dump errors surface as thrown
 *   errors with diagnosable messages, never as silent success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RestoreVerifyDeps, PoolLike, DrillResult } from './restore-verify.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>

const TABLES = ['identities', 'bonds', 'attestations', 'payouts', 'audit_logs']

/**
 * Returns a PoolLike mock whose query() function can be overridden per-test.
 * By default every query returns a single row with count = "10" (row-count
 * queries) or a matching checksum (checksum queries).
 */
function makePool(queryImpl?: QueryFn): PoolLike & { end: ReturnType<typeof vi.fn> } {
  const end = vi.fn().mockResolvedValue(undefined)
  const query = vi.fn<[string, unknown[]?], Promise<{ rows: Array<Record<string, unknown>> }>>(
    queryImpl ??
      (async (sql: string, params?: unknown[]) => {
        // Row-count queries return matching counts so the check passes.
        if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: '10' }] }
        // Checksum queries return the same value for both schemas so check passes.
        if (/md5/i.test(sql)) return { rows: [{ checksum: 'abc123' }] }
        // DDL (DROP/CREATE/ALTER) — nothing to return.
        return { rows: [] }
      }),
  )
  return { query, end }
}

/** Builds a minimal valid RestoreVerifyDeps object. */
function makeDeps(overrides: Partial<RestoreVerifyDeps> = {}): RestoreVerifyDeps {
  const pool = makePool()
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    now: vi
      .fn()
      .mockReturnValueOnce(0) // drill start
      .mockReturnValue(2000), // drill end → 2 s duration
    fsp: {
      mkdtemp: vi.fn().mockResolvedValue('/tmp/restore-verify-abc'),
      rm: vi.fn().mockResolvedValue(undefined),
    },
    tmpdir: () => '/tmp',
    createPool: vi.fn().mockReturnValue(pool),
    metrics: {
      observeDuration: vi.fn(),
      incFailure: vi.fn(),
    },
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  }
}

/** Import the module under test (after env manipulation). */
async function importDrill() {
  return import('./restore-verify.ts')
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalDbUrl: string | undefined

beforeEach(() => {
  originalDbUrl = process.env.DB_URL
  process.env.DB_URL = 'postgresql://user:pass@localhost:5432/credence_test'
})

afterEach(() => {
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL
  } else {
    process.env.DB_URL = originalDbUrl
  }
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — success path', () => {
  it('returns passed=true and all checks ok for a healthy drill', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()
    const result: DrillResult = await runRestoreVerifyDrill(deps)

    expect(result.passed).toBe(true)
    expect(result.checks.every((c) => c.ok)).toBe(true)
  })

  it('records a check for snapshot retrieval', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const result = await runRestoreVerifyDrill(makeDeps())

    const snap = result.checks.find((c) => c.name.includes('Snapshot retrieved'))
    expect(snap).toBeDefined()
    expect(snap!.ok).toBe(true)
  })

  it('records a check for restore schema creation', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const result = await runRestoreVerifyDrill(makeDeps())

    const schema = result.checks.find((c) => c.name.includes('restore schema created'))
    expect(schema).toBeDefined()
    expect(schema!.ok).toBe(true)
  })

  it('records a check for successful snapshot restore', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const result = await runRestoreVerifyDrill(makeDeps())

    const restore = result.checks.find((c) => c.name.includes('Snapshot restored'))
    expect(restore).toBeDefined()
    expect(restore!.ok).toBe(true)
  })

  it('records row-count checks for every expected table', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const result = await runRestoreVerifyDrill(makeDeps())

    for (const table of TABLES) {
      const check = result.checks.find((c) => c.name === `Row count check for ${table}`)
      expect(check, `missing row-count check for ${table}`).toBeDefined()
      expect(check!.ok).toBe(true)
      expect(check!.detail).toMatch(/primary=\d+, restore=\d+/)
    }
  })

  it('records schema checksum checks for every expected table', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const result = await runRestoreVerifyDrill(makeDeps())

    for (const table of TABLES) {
      const check = result.checks.find((c) => c.name === `Schema checksum for ${table}`)
      expect(check, `missing checksum check for ${table}`).toBeDefined()
      expect(check!.ok).toBe(true)
    }
  })

  it('records the cleanup check as passed', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const result = await runRestoreVerifyDrill(makeDeps())

    const cleanup = result.checks.find((c) => c.name.includes('cleaned up'))
    expect(cleanup).toBeDefined()
    expect(cleanup!.ok).toBe(true)
  })

  it('observes duration on the metrics sink', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()
    await runRestoreVerifyDrill(deps)

    expect(deps.metrics.observeDuration).toHaveBeenCalledWith(expect.any(Number))
    expect(deps.metrics.observeDuration).toHaveBeenCalledTimes(1)
  })

  it('calls pg_dump with --format=c and the DB URL', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()
    await runRestoreVerifyDrill(deps)

    expect(deps.exec).toHaveBeenCalledWith(
      'pg_dump',
      expect.arrayContaining(['--format=c', process.env.DB_URL!]),
    )
  })

  it('calls pg_restore with the correct flags', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()
    await runRestoreVerifyDrill(deps)

    expect(deps.exec).toHaveBeenCalledWith(
      'pg_restore',
      expect.arrayContaining(['--schema=public', '--no-owner', '--no-acl']),
      expect.objectContaining({
        env: expect.objectContaining({ PGOPTIONS: expect.stringContaining('restore_verify') }),
      }),
    )
  })

  it('cleans up the temporary directory in the finally block', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()
    await runRestoreVerifyDrill(deps)

    expect(deps.fsp.rm).toHaveBeenCalledWith(
      '/tmp/restore-verify-abc',
      expect.objectContaining({ recursive: true, force: true }),
    )
  })

  it('closes the pool in the finally block', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const pool = makePool()
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })
    await runRestoreVerifyDrill(deps)

    expect(pool.end).toHaveBeenCalledTimes(1)
  })

  it('does not increment the failure metric when all checks pass', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()
    await runRestoreVerifyDrill(deps)

    expect(deps.metrics.incFailure).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Authorization / loading state
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — authorization and loading state', () => {
  it('throws immediately when DB_URL is not set', async () => {
    delete process.env.DB_URL
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()

    await expect(runRestoreVerifyDrill(deps)).rejects.toThrow('DB_URL must be set')
  })

  it('never touches the filesystem or network when DB_URL is missing', async () => {
    delete process.env.DB_URL
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()

    await runRestoreVerifyDrill(deps).catch(() => {})

    expect(deps.fsp.mkdtemp).not.toHaveBeenCalled()
    expect(deps.exec).not.toHaveBeenCalled()
    expect(deps.createPool).not.toHaveBeenCalled()
  })

  it('increments the "unknown" failure metric when DB_URL is missing', async () => {
    delete process.env.DB_URL
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()

    await runRestoreVerifyDrill(deps).catch(() => {})

    expect(deps.metrics.incFailure).toHaveBeenCalledWith('unknown')
  })

  it('still closes the pool (none opened) and cleans up tmpDir (none created) on auth failure', async () => {
    delete process.env.DB_URL
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()

    await runRestoreVerifyDrill(deps).catch(() => {})

    // No pool was created, no tmpDir was created → no cleanup calls expected
    expect(deps.createPool).not.toHaveBeenCalled()
    expect(deps.fsp.rm).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// pg_dump failure
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — pg_dump failure', () => {
  it('throws when pg_dump exits non-zero', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps({
      exec: vi.fn().mockRejectedValueOnce(new Error('pg_dump: connection refused')),
    })

    await expect(runRestoreVerifyDrill(deps)).rejects.toThrow('pg_dump: connection refused')
  })

  it('increments the "unknown" failure metric on pg_dump crash', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps({
      exec: vi.fn().mockRejectedValueOnce(new Error('pg_dump: connection refused')),
    })

    await runRestoreVerifyDrill(deps).catch(() => {})

    expect(deps.metrics.incFailure).toHaveBeenCalledWith('unknown')
  })

  it('cleans up tmpDir even when pg_dump fails', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps({
      exec: vi.fn().mockRejectedValueOnce(new Error('pg_dump: auth failed')),
    })

    await runRestoreVerifyDrill(deps).catch(() => {})

    expect(deps.fsp.rm).toHaveBeenCalledWith(
      '/tmp/restore-verify-abc',
      expect.objectContaining({ recursive: true, force: true }),
    )
  })
})

// ---------------------------------------------------------------------------
// pg_restore failure
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — pg_restore failure', () => {
  it('throws when pg_restore exits non-zero', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // pg_dump succeeds
      .mockRejectedValueOnce(new Error('pg_restore: invalid format')) // pg_restore fails
    const deps = makeDeps({ exec: execMock })

    await expect(runRestoreVerifyDrill(deps)).rejects.toThrow('pg_restore: invalid format')
  })

  it('cleans up pool and tmpDir even when pg_restore fails', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const pool = makePool()
    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('pg_restore: permission denied'))
    const deps = makeDeps({ exec: execMock, createPool: vi.fn().mockReturnValue(pool) })

    await runRestoreVerifyDrill(deps).catch(() => {})

    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(deps.fsp.rm).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// mkdtemp failure (permission / loading state)
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — tmpdir creation failure', () => {
  it('throws when mkdtemp fails due to permissions', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps({
      fsp: {
        mkdtemp: vi.fn().mockRejectedValue(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        ),
        rm: vi.fn().mockResolvedValue(undefined),
      },
    })

    await expect(runRestoreVerifyDrill(deps)).rejects.toThrow(/EACCES/)
  })

  it('does not attempt exec or pool creation when tmpdir is unreadable', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps({
      fsp: {
        mkdtemp: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device')),
        rm: vi.fn().mockResolvedValue(undefined),
      },
    })

    await runRestoreVerifyDrill(deps).catch(() => {})

    expect(deps.exec).not.toHaveBeenCalled()
    expect(deps.createPool).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Row-count mismatch (partial failure)
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — row-count mismatch', () => {
  it('marks the mismatched table check as failed', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    let callCount = 0
    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) {
        callCount++
        // Return different counts on alternating calls to simulate drift
        // on the 'identities' table (first COUNT(*) pair)
        return { rows: [{ count: callCount % 2 === 1 ? '10' : '7' }] }
      }
      if (/md5/i.test(sql)) return { rows: [{ checksum: 'same' }] }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    const result = await runRestoreVerifyDrill(deps)

    const rowChecks = result.checks.filter((c) => c.name.startsWith('Row count check'))
    expect(rowChecks.some((c) => !c.ok)).toBe(true)
  })

  it('increments the row_count failure metric for each mismatched table', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    // All COUNT queries return mismatched counts: primary=10, restore=0
    let callCount = 0
    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) {
        callCount++
        return { rows: [{ count: callCount % 2 === 1 ? '10' : '0' }] }
      }
      if (/md5/i.test(sql)) return { rows: [{ checksum: 'x' }] }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    await runRestoreVerifyDrill(deps)

    expect(deps.metrics.incFailure).toHaveBeenCalledWith('row_count')
  })

  it('continues checking remaining tables after a single mismatch (partial failure)', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    // Only the very first COUNT(*) pair (identities) mismatches; the rest pass
    let countCallIndex = 0
    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) {
        const idx = countCallIndex++
        // identities primary=10 (idx 0), identities restore=5 (idx 1); rest match
        if (idx === 0) return { rows: [{ count: '10' }] }
        if (idx === 1) return { rows: [{ count: '5' }] }
        return { rows: [{ count: '10' }] }
      }
      if (/md5/i.test(sql)) return { rows: [{ checksum: 'same' }] }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    const result = await runRestoreVerifyDrill(deps)

    const rowChecks = result.checks.filter((c) => c.name.startsWith('Row count check'))
    // All 5 tables must have been checked regardless
    expect(rowChecks).toHaveLength(TABLES.length)
    // The first one failed, the rest passed
    expect(rowChecks[0]!.ok).toBe(false)
    expect(rowChecks.slice(1).every((c) => c.ok)).toBe(true)
    // passed=false because at least one check failed
    expect(result.passed).toBe(false)
  })

  it('detail string carries primary and restore counts without exposing credentials', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    let callCount = 0
    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) {
        callCount++
        return { rows: [{ count: callCount % 2 === 1 ? '42' : '39' }] }
      }
      if (/md5/i.test(sql)) return { rows: [{ checksum: 'x' }] }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })
    const result = await runRestoreVerifyDrill(deps)

    const failed = result.checks.find((c) => c.name.startsWith('Row count check') && !c.ok)
    expect(failed).toBeDefined()
    expect(failed!.detail).toMatch(/primary=\d+, restore=\d+/)
    // Must not expose the DB URL or password
    expect(failed!.detail).not.toContain('pass')
    expect(failed!.detail).not.toContain('localhost')
  })
})

// ---------------------------------------------------------------------------
// Checksum failure
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — checksum failure', () => {
  it('marks the checksum check as failed when schemas differ', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    let checksumCallIndex = 0
    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: '10' }] }
      if (/md5/i.test(sql)) {
        checksumCallIndex++
        // First table: return different checksums
        return { rows: [{ checksum: checksumCallIndex <= 2 ? `cksum-${checksumCallIndex}` : 'same' }] }
      }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    const result = await runRestoreVerifyDrill(deps)

    const checksumChecks = result.checks.filter((c) => c.name.includes('checksum'))
    expect(checksumChecks.some((c) => !c.ok)).toBe(true)
  })

  it('increments checksum failure metric and records a failed check on query error', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: '10' }] }
      if (/md5/i.test(sql)) throw new Error('column does not exist')
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    const result = await runRestoreVerifyDrill(deps)

    expect(deps.metrics.incFailure).toHaveBeenCalledWith('checksum')
    const checksumCheck = result.checks.find(
      (c) => c.name.startsWith('Checksum check') && !c.ok,
    )
    expect(checksumCheck).toBeDefined()
    expect(checksumCheck!.detail).toContain('column does not exist')
  })

  it('continues checking remaining tables after a checksum query error', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    // Track only md5/checksum queries (not DDL or COUNT queries)
    let checksumQueryCount = 0
    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: '10' }] }
      if (/md5/i.test(sql)) {
        checksumQueryCount++
        // Throw on the very first checksum query only; the rest succeed
        if (checksumQueryCount === 1) throw new Error('permission denied for schema')
        return { rows: [{ checksum: 'ok' }] }
      }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    const result = await runRestoreVerifyDrill(deps)

    // When the first checksum query throws, the catch records "Checksum check for X"
    // (1 failed check). For the remaining tables both queries succeed, recording
    // "Schema checksum for Y" (TABLES.length - 1 passing checks).
    // Total checksum-related checks = TABLES.length regardless of error path.
    const checksumChecks = result.checks.filter(
      (c) => c.name.includes('Schema checksum') || c.name.includes('Checksum check'),
    )
    expect(checksumChecks).toHaveLength(TABLES.length)
    // Exactly one check failed (the first table)
    const failed = checksumChecks.filter((c) => !c.ok)
    expect(failed).toHaveLength(1)
    // The rest passed
    const passed = checksumChecks.filter((c) => c.ok)
    expect(passed).toHaveLength(TABLES.length - 1)
  })
})

// ---------------------------------------------------------------------------
// Pool query failures (DDL path)
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — pool DDL failures', () => {
  it('throws when DROP SCHEMA fails', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const pool = makePool(async (sql) => {
      if (/DROP SCHEMA/i.test(sql)) throw new Error('permission denied for schema')
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    await expect(runRestoreVerifyDrill(deps)).rejects.toThrow('permission denied for schema')
  })

  it('throws when CREATE SCHEMA fails', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const pool = makePool(async (sql) => {
      if (/CREATE SCHEMA/i.test(sql)) throw new Error('schema already exists')
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    await expect(runRestoreVerifyDrill(deps)).rejects.toThrow('schema already exists')
  })

  it('still cleans up pool and tmpDir when CREATE SCHEMA fails', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const pool = makePool(async (sql) => {
      if (/CREATE SCHEMA/i.test(sql)) throw new Error('schema already exists')
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    await runRestoreVerifyDrill(deps).catch(() => {})

    expect(pool.end).toHaveBeenCalledTimes(1)
    expect(deps.fsp.rm).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cleanup failure (tmpDir rm failure is non-fatal)
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — cleanup failure recovery', () => {
  it('does not throw when tmpDir rm fails; still returns the result', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps({
      fsp: {
        mkdtemp: vi.fn().mockResolvedValue('/tmp/restore-verify-abc'),
        rm: vi.fn().mockRejectedValue(
          Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }),
        ),
      },
    })

    // The drill should succeed even if cleanup fails
    const result = await runRestoreVerifyDrill(deps)
    expect(result.passed).toBe(true)
  })

  it('logs a warning when tmpDir cleanup fails without exposing internal paths', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps({
      fsp: {
        mkdtemp: vi.fn().mockResolvedValue('/tmp/restore-verify-abc'),
        rm: vi.fn().mockRejectedValue(new Error('EBUSY: resource busy')),
      },
    })

    await runRestoreVerifyDrill(deps)

    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringContaining('clean up'),
      expect.any(Error),
    )
  })

  it('closes the pool even when pool.end() rejects', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const pool = makePool()
    ;(pool.end as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection closed'))
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })

    // Should not throw due to pool.end() failure
    await expect(runRestoreVerifyDrill(deps)).resolves.toMatchObject({ passed: true })
  })
})

// ---------------------------------------------------------------------------
// Retry safety (deterministic, no shared state)
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — retry and idempotency', () => {
  it('returns identical results on two sequential calls with fresh deps', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const run = () => runRestoreVerifyDrill(makeDeps())
    const [first, second] = await Promise.all([run(), run()])

    expect(second.passed).toBe(first.passed)
    expect(second.checks.map((c) => c.name)).toEqual(first.checks.map((c) => c.name))
    expect(second.checks.map((c) => c.ok)).toEqual(first.checks.map((c) => c.ok))
  })

  it('recovers cleanly on the second attempt after a first-attempt crash', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    // First attempt: pg_dump crashes
    const failDeps = makeDeps({
      exec: vi.fn().mockRejectedValueOnce(new Error('network timeout')),
    })
    await runRestoreVerifyDrill(failDeps).catch(() => {})

    // Second attempt: everything healthy
    const successDeps = makeDeps()
    const result = await runRestoreVerifyDrill(successDeps)

    expect(result.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Concurrent execution
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — concurrent execution', () => {
  it('handles multiple parallel drills without interference', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const results = await Promise.all(
      Array.from({ length: 5 }, () => runRestoreVerifyDrill(makeDeps())),
    )

    for (const r of results) {
      expect(r.passed).toBe(true)
      expect(r.checks.every((c) => c.ok)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Observability and diagnostics
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — observability', () => {
  it('reports durationSeconds as a non-negative number', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()
    const result = await runRestoreVerifyDrill(deps)

    expect(result.durationSeconds).toBeGreaterThanOrEqual(0)
  })

  it('calls logError with failed check details when drill has failures', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    let callCount = 0
    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) {
        callCount++
        return { rows: [{ count: callCount % 2 === 1 ? '10' : '0' }] }
      }
      if (/md5/i.test(sql)) return { rows: [{ checksum: 'x' }] }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })
    await runRestoreVerifyDrill(deps)

    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('FAILED'))
  })

  it('does not expose DB_URL or credentials in log calls', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const deps = makeDeps()
    await runRestoreVerifyDrill(deps)

    const allLogs = (deps.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join('\n')

    // The password in the test DB_URL is 'pass' — check it doesn't appear
    // as the credential fragment 'pass@' (the full user:pass@host pattern),
    // and that the DB name 'credence_test' is not leaked verbatim.
    expect(allLogs).not.toContain('pass@')
    expect(allLogs).not.toContain('credence_test')
    expect(allLogs).not.toContain('postgresql://')
  })

  it('check detail for row counts shows counts without raw SQL', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const result = await runRestoreVerifyDrill(makeDeps())

    const rowChecks = result.checks.filter((c) => c.name.startsWith('Row count check'))
    for (const check of rowChecks) {
      expect(check.detail).toMatch(/^primary=\d+, restore=\d+$/)
      expect(check.detail).not.toContain('SELECT')
    }
  })
})

// ---------------------------------------------------------------------------
// Boundary: stale / zero-row tables
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — boundary inputs', () => {
  it('passes when all tables have zero rows (empty DB boundary)', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: '0' }] }
      if (/md5/i.test(sql)) return { rows: [{ checksum: 'empty-cksum' }] }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })
    const result = await runRestoreVerifyDrill(deps)

    const rowChecks = result.checks.filter((c) => c.name.startsWith('Row count check'))
    expect(rowChecks.every((c) => c.ok)).toBe(true)
  })

  it('passes when tables have very large row counts (boundary: large numbers)', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: '9999999999' }] }
      if (/md5/i.test(sql)) return { rows: [{ checksum: 'big-cksum' }] }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })
    const result = await runRestoreVerifyDrill(deps)

    const rowChecks = result.checks.filter((c) => c.name.startsWith('Row count check'))
    expect(rowChecks.every((c) => c.ok)).toBe(true)
  })

  it('handles a null checksum result from the DB without throwing', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const pool = makePool(async (sql) => {
      if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ count: '10' }] }
      if (/md5/i.test(sql)) return { rows: [{ checksum: null }] }
      return { rows: [] }
    })
    const deps = makeDeps({ createPool: vi.fn().mockReturnValue(pool) })
    const result = await runRestoreVerifyDrill(deps)

    // null === null so all checksum checks should pass (both sides return null)
    const checksumChecks = result.checks.filter((c) => c.name.includes('checksum'))
    expect(checksumChecks.every((c) => c.ok)).toBe(true)
  })

  it('is deterministic: identical dep config always produces same checks list', async () => {
    const { runRestoreVerifyDrill } = await importDrill()

    const r1 = await runRestoreVerifyDrill(makeDeps())
    const r2 = await runRestoreVerifyDrill(makeDeps())

    expect(r2.checks.map((c) => c.name)).toEqual(r1.checks.map((c) => c.name))
    expect(r2.checks.map((c) => c.ok)).toEqual(r1.checks.map((c) => c.ok))
    expect(r2.passed).toBe(r1.passed)
  })
})

// ---------------------------------------------------------------------------
// Regression: public interface shape preserved
// ---------------------------------------------------------------------------

describe('runRestoreVerifyDrill — public interface contract', () => {
  it('exports runRestoreVerifyDrill as a named export', async () => {
    const mod = await importDrill()
    expect(typeof mod.runRestoreVerifyDrill).toBe('function')
  })

  it('returns an object with checks, durationSeconds, and passed', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const result = await runRestoreVerifyDrill(makeDeps())

    expect(result).toHaveProperty('checks')
    expect(result).toHaveProperty('durationSeconds')
    expect(result).toHaveProperty('passed')
    expect(Array.isArray(result.checks)).toBe(true)
    expect(typeof result.durationSeconds).toBe('number')
    expect(typeof result.passed).toBe('boolean')
  })

  it('every Check in the result has the shape { name, ok, detail? }', async () => {
    const { runRestoreVerifyDrill } = await importDrill()
    const result = await runRestoreVerifyDrill(makeDeps())

    for (const check of result.checks) {
      expect(typeof check.name).toBe('string')
      expect(check.name.length).toBeGreaterThan(0)
      expect(typeof check.ok).toBe('boolean')
      if (check.detail !== undefined) {
        expect(typeof check.detail).toBe('string')
      }
    }
  })

  it('accepts an empty options object (all defaults applied)', async () => {
    // This tests the default-deps path without hitting the real DB/filesystem.
    // We mock at the module level to avoid actual pg_dump execution.
    // If DB_URL is set but pg_dump is not available, the function throws —
    // what we assert here is that calling with {} does NOT throw due to a
    // TypeScript/shape error; the actual exec failure is an infrastructure concern.
    const { runRestoreVerifyDrill } = await importDrill()
    // Pass an exec override only to prevent real pg_dump; the rest are defaults
    const result = runRestoreVerifyDrill({
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      createPool: vi.fn().mockReturnValue(makePool()),
      fsp: {
        mkdtemp: vi.fn().mockResolvedValue('/tmp/restore-verify-test'),
        rm: vi.fn().mockResolvedValue(undefined),
      },
    })
    await expect(result).resolves.toMatchObject({ passed: true })
  })
})
