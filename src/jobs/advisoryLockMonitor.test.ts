import { beforeEach, describe, expect, it, vi } from 'vitest'
import client from 'prom-client'
import {
  collectStaleAdvisoryLocks,
  getStaleAdvisoryLocks,
  registerAdvisoryLockMetrics,
  resetAdvisoryLockMetrics,
} from './advisoryLockMonitor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFakePool = (rows: Array<Record<string, unknown>>) => ({
  query: vi.fn().mockResolvedValue({ rows }),
})

const makeRejectingPool = (error: Error) => ({
  query: vi.fn().mockRejectedValue(error),
})

/** Build a canonical advisory-lock row with sensible defaults. */
function lockRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    lock_id: '42:0',
    pid: 100,
    query: 'SELECT pg_advisory_lock(42)',
    database: 'credence',
    age_seconds: '310',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Original baseline tests (preserved exactly)
// ---------------------------------------------------------------------------

describe('advisoryLockMonitor', () => {
  beforeEach(() => {
    resetAdvisoryLockMetrics()
  })

  it('registers the advisory lock age gauge in a provided registry', async () => {
    const registry = new client.Registry()
    const gauge = registerAdvisoryLockMetrics(registry)

    const metrics = await registry.getMetricsAsJSON()
    expect(metrics.find((metric) => metric.name === 'pg_advisory_lock_age_seconds')).toBeDefined()
    expect(gauge).toBeDefined()
  })

  it('returns stale advisory locks older than the threshold', async () => {
    const pool = makeFakePool([
      {
        lock_id: '1:0',
        pid: 123,
        query: 'SELECT pg_advisory_lock(1)',
        database: 'testdb',
        age_seconds: '301.5',
      },
    ])

    const staleLocks = await getStaleAdvisoryLocks(pool as any, 300)

    expect(staleLocks).toEqual([
      {
        lockId: '1:0',
        pid: 123,
        query: 'SELECT pg_advisory_lock(1)',
        database: 'testdb',
        ageSeconds: 301.5,
      },
    ])
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [300])
  })

  it('collects stale advisory lock ages and emits gauge values', async () => {
    const pool = makeFakePool([
      {
        lock_id: '2:1',
        pid: 456,
        query: 'SELECT pg_advisory_lock(2, 1)',
        database: 'prod',
        age_seconds: 600,
      },
    ])
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)

    const staleLocks = await collectStaleAdvisoryLocks(pool as any, 300)
    expect(staleLocks).toHaveLength(1)
    expect(staleLocks[0]).toMatchObject({ lockId: '2:1', pid: 456, ageSeconds: 600 })

    const metrics = await registry.getMetricsAsJSON()
    const gaugeMetric = metrics.find((metric) => metric.name === 'pg_advisory_lock_age_seconds')
    expect(gaugeMetric).toBeDefined()
    expect(gaugeMetric?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 600,
          labels: {
            lock_id: '2:1',
            pid: '456',
            database: 'prod',
            query: 'SELECT pg_advisory_lock(2, 1)',
          },
        }),
      ])
    )
  })
})

// ---------------------------------------------------------------------------
// getStaleAdvisoryLocks — boundary and recovery
// ---------------------------------------------------------------------------

describe('getStaleAdvisoryLocks – boundary cases', () => {
  beforeEach(() => {
    resetAdvisoryLockMetrics()
  })

  // ── Empty result ──────────────────────────────────────────────────────────

  it('returns an empty array when no advisory locks are held', async () => {
    const pool = makeFakePool([])
    const result = await getStaleAdvisoryLocks(pool as any, 300)
    expect(result).toEqual([])
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  // ── Default threshold ─────────────────────────────────────────────────────

  it('uses 300 s as the default threshold when none is supplied', async () => {
    const pool = makeFakePool([])
    await getStaleAdvisoryLocks(pool as any)
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [300])
  })

  // ── Custom threshold values ───────────────────────────────────────────────

  it('forwards a custom threshold of 0 s to the query', async () => {
    const pool = makeFakePool([])
    await getStaleAdvisoryLocks(pool as any, 0)
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [0])
  })

  it('forwards a very large threshold (Number.MAX_SAFE_INTEGER) without error', async () => {
    const pool = makeFakePool([])
    await getStaleAdvisoryLocks(pool as any, Number.MAX_SAFE_INTEGER)
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [Number.MAX_SAFE_INTEGER])
  })

  // ── Row parsing: age_seconds as string vs number ──────────────────────────

  it('parses age_seconds when the database returns a string (pg numeric coercion)', async () => {
    const pool = makeFakePool([lockRow({ age_seconds: '123.456' })])
    const [lock] = await getStaleAdvisoryLocks(pool as any, 60)
    expect(lock.ageSeconds).toBe(123.456)
    expect(typeof lock.ageSeconds).toBe('number')
  })

  it('passes through age_seconds when the driver returns a plain number', async () => {
    const pool = makeFakePool([lockRow({ age_seconds: 789 })])
    const [lock] = await getStaleAdvisoryLocks(pool as any, 60)
    expect(lock.ageSeconds).toBe(789)
  })

  it('parses age_seconds of 0 (lock just acquired, exactly at threshold boundary)', async () => {
    const pool = makeFakePool([lockRow({ age_seconds: '0' })])
    const [lock] = await getStaleAdvisoryLocks(pool as any, 0)
    expect(lock.ageSeconds).toBe(0)
  })

  it('parses a fractional age_seconds with full precision', async () => {
    const pool = makeFakePool([lockRow({ age_seconds: '300.001' })])
    const [lock] = await getStaleAdvisoryLocks(pool as any, 300)
    expect(lock.ageSeconds).toBeCloseTo(300.001, 3)
  })

  // ── Row parsing: null / missing query field ───────────────────────────────

  it('replaces a null query with the "<unknown>" sentinel', async () => {
    const pool = makeFakePool([lockRow({ query: null })])
    const [lock] = await getStaleAdvisoryLocks(pool as any, 60)
    expect(lock.query).toBe('<unknown>')
  })

  it('replaces an undefined query with the "<unknown>" sentinel', async () => {
    const pool = makeFakePool([lockRow({ query: undefined })])
    const [lock] = await getStaleAdvisoryLocks(pool as any, 60)
    expect(lock.query).toBe('<unknown>')
  })

  // ── Row parsing: non-standard lock_id and pid coercion ────────────────────

  it('coerces a numeric lock_id to a string', async () => {
    const pool = makeFakePool([lockRow({ lock_id: 99 })])
    const [lock] = await getStaleAdvisoryLocks(pool as any, 60)
    expect(lock.lockId).toBe('99')
    expect(typeof lock.lockId).toBe('string')
  })

  it('coerces a string pid to a number', async () => {
    const pool = makeFakePool([lockRow({ pid: '7777' })])
    const [lock] = await getStaleAdvisoryLocks(pool as any, 60)
    expect(lock.pid).toBe(7777)
    expect(typeof lock.pid).toBe('number')
  })

  // ── Multiple locks returned ───────────────────────────────────────────────

  it('returns multiple locks preserving order (DESC age from query)', async () => {
    const pool = makeFakePool([
      lockRow({ lock_id: 'A:0', age_seconds: '900' }),
      lockRow({ lock_id: 'B:0', age_seconds: '600' }),
      lockRow({ lock_id: 'C:0', age_seconds: '301' }),
    ])
    const locks = await getStaleAdvisoryLocks(pool as any, 300)
    expect(locks).toHaveLength(3)
    expect(locks.map((l) => l.lockId)).toEqual(['A:0', 'B:0', 'C:0'])
    expect(locks[0].ageSeconds).toBeGreaterThan(locks[1].ageSeconds)
    expect(locks[1].ageSeconds).toBeGreaterThan(locks[2].ageSeconds)
  })

  // ── Determinism: identical inputs produce identical results ───────────────

  it('is deterministic: calling twice with the same pool rows returns the same data', async () => {
    const rows = [lockRow()]
    const pool = {
      query: vi.fn().mockResolvedValue({ rows }),
    }
    const first = await getStaleAdvisoryLocks(pool as any, 300)
    const second = await getStaleAdvisoryLocks(pool as any, 300)
    expect(first).toEqual(second)
  })

  // ── SQL shape ─────────────────────────────────────────────────────────────

  it('queries pg_locks joined with pg_stat_activity for advisory lock type', async () => {
    const pool = makeFakePool([])
    await getStaleAdvisoryLocks(pool as any, 300)
    const sql: string = pool.query.mock.calls[0][0]
    expect(sql).toContain('pg_locks')
    expect(sql).toContain('pg_stat_activity')
    expect(sql).toContain("locktype = 'advisory'")
    expect(sql).toContain('granted = true')
    expect(sql).toContain('age_seconds DESC')
  })

  // ── Error recovery ────────────────────────────────────────────────────────

  it('propagates a database connection error without swallowing it', async () => {
    const pool = makeRejectingPool(new Error('connection refused'))
    await expect(getStaleAdvisoryLocks(pool as any, 300)).rejects.toThrow('connection refused')
  })

  it('propagates a query timeout error transparently', async () => {
    const pool = makeRejectingPool(new Error('query timeout'))
    await expect(getStaleAdvisoryLocks(pool as any, 300)).rejects.toThrow('query timeout')
  })

  it('propagates an unexpected non-Error rejection', async () => {
    const pool = { query: vi.fn().mockRejectedValue('string-error') }
    await expect(getStaleAdvisoryLocks(pool as any, 300)).rejects.toBe('string-error')
  })
})

// ---------------------------------------------------------------------------
// collectStaleAdvisoryLocks — boundary and recovery
// ---------------------------------------------------------------------------

describe('collectStaleAdvisoryLocks – boundary cases', () => {
  beforeEach(() => {
    resetAdvisoryLockMetrics()
  })

  // ── Empty set ─────────────────────────────────────────────────────────────

  it('returns an empty array and emits no gauge values when no locks are held', async () => {
    const pool = makeFakePool([])
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)

    const result = await collectStaleAdvisoryLocks(pool as any, 300)
    expect(result).toEqual([])

    const metrics = await registry.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'pg_advisory_lock_age_seconds')
    expect(gauge?.values).toHaveLength(0)
  })

  // ── Gauge reset on each collection ───────────────────────────────────────

  it('resets the gauge before each collection so stale labels do not persist', async () => {
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)

    // First collection: two locks
    const poolA = makeFakePool([
      lockRow({ lock_id: 'X:0', pid: 11, age_seconds: 400 }),
      lockRow({ lock_id: 'Y:0', pid: 22, age_seconds: 500 }),
    ])
    await collectStaleAdvisoryLocks(poolA as any, 300)

    // Second collection: only one lock (X resolved)
    const poolB = makeFakePool([lockRow({ lock_id: 'Y:0', pid: 22, age_seconds: 510 })])
    await collectStaleAdvisoryLocks(poolB as any, 300)

    const metrics = await registry.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'pg_advisory_lock_age_seconds')
    // X:0 must be gone — gauge was reset before the second collect
    const lockIds = (gauge?.values ?? []).map((v: any) => v.labels?.lock_id)
    expect(lockIds).not.toContain('X:0')
    expect(lockIds).toContain('Y:0')
  })

  // ── Multiple concurrent locks ─────────────────────────────────────────────

  it('emits a separate gauge value for each stale lock', async () => {
    const pool = makeFakePool([
      lockRow({ lock_id: '1:0', pid: 10, age_seconds: 310 }),
      lockRow({ lock_id: '2:0', pid: 20, age_seconds: 420 }),
      lockRow({ lock_id: '3:0', pid: 30, age_seconds: 530 }),
    ])
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)
    await collectStaleAdvisoryLocks(pool as any, 300)

    const metrics = await registry.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'pg_advisory_lock_age_seconds')
    expect(gauge?.values).toHaveLength(3)
  })

  // ── Gauge label correctness ───────────────────────────────────────────────

  it('sets gauge labels using string pid even when the row pid is numeric', async () => {
    const pool = makeFakePool([lockRow({ pid: 9999, age_seconds: 400 })])
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)
    await collectStaleAdvisoryLocks(pool as any, 300)

    const metrics = await registry.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'pg_advisory_lock_age_seconds')
    const entry = gauge?.values?.[0] as any
    expect(entry.labels.pid).toBe('9999')
  })

  it('uses the "<unknown>" sentinel as the query label for null queries', async () => {
    const pool = makeFakePool([lockRow({ query: null, age_seconds: 400 })])
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)
    await collectStaleAdvisoryLocks(pool as any, 300)

    const metrics = await registry.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'pg_advisory_lock_age_seconds')
    const entry = gauge?.values?.[0] as any
    expect(entry.labels.query).toBe('<unknown>')
  })

  // ── Gauge auto-creation without prior registerAdvisoryLockMetrics ─────────

  it('auto-creates the gauge when collectStaleAdvisoryLocks is called before register', async () => {
    // No prior registerAdvisoryLockMetrics call — gauge must be lazily created
    const pool = makeFakePool([lockRow({ age_seconds: 400 })])
    const result = await collectStaleAdvisoryLocks(pool as any, 300)
    expect(result).toHaveLength(1)
    // No error means auto-creation succeeded
  })

  // ── Default threshold forwarded ───────────────────────────────────────────

  it('passes the default 300 s threshold to the underlying pool query', async () => {
    const pool = makeFakePool([])
    await collectStaleAdvisoryLocks(pool as any)
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [300])
  })

  // ── Determinism ───────────────────────────────────────────────────────────

  it('is deterministic: two consecutive collections with the same data return identical arrays', async () => {
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)

    const rows = [lockRow({ lock_id: 'Z:0', age_seconds: 350 })]
    const poolA = makeFakePool(rows)
    const poolB = makeFakePool(rows)

    const first = await collectStaleAdvisoryLocks(poolA as any, 300)
    const second = await collectStaleAdvisoryLocks(poolB as any, 300)
    expect(first).toEqual(second)
  })

  // ── Error recovery ────────────────────────────────────────────────────────

  it('propagates a query error without silently swallowing it', async () => {
    const pool = makeRejectingPool(new Error('deadlock detected'))
    await expect(collectStaleAdvisoryLocks(pool as any, 300)).rejects.toThrow('deadlock detected')
  })

  it('does not corrupt the gauge state when the query fails mid-collection', async () => {
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)

    // First successful collection establishes known state
    const goodPool = makeFakePool([lockRow({ lock_id: 'GOOD:0', age_seconds: 400 })])
    await collectStaleAdvisoryLocks(goodPool as any, 300)

    // Second collection fails at the query level (before reset runs)
    const badPool = makeRejectingPool(new Error('network error'))
    await expect(collectStaleAdvisoryLocks(badPool as any, 300)).rejects.toThrow()

    // Gauge still reflects the last successful state — no partial update
    const metrics = await registry.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'pg_advisory_lock_age_seconds')
    const lockIds = (gauge?.values ?? []).map((v: any) => v.labels?.lock_id)
    expect(lockIds).toContain('GOOD:0')
  })
})

// ---------------------------------------------------------------------------
// registerAdvisoryLockMetrics — idempotency and isolation
// ---------------------------------------------------------------------------

describe('registerAdvisoryLockMetrics – idempotency and isolation', () => {
  beforeEach(() => {
    resetAdvisoryLockMetrics()
  })

  it('returns the same gauge instance on repeated calls', () => {
    const registry = new client.Registry()
    const g1 = registerAdvisoryLockMetrics(registry)
    const g2 = registerAdvisoryLockMetrics(registry)
    expect(g1).toBe(g2)
  })

  it('does not double-register the metric in the registry on repeated calls', async () => {
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)
    registerAdvisoryLockMetrics(registry)

    const metrics = await registry.getMetricsAsJSON()
    const gauges = metrics.filter((m) => m.name === 'pg_advisory_lock_age_seconds')
    expect(gauges).toHaveLength(1)
  })

  it('gauge is visible under the correct metric name after registration', async () => {
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)

    const metrics = await registry.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'pg_advisory_lock_age_seconds')
    expect(gauge).toBeDefined()
    expect(gauge?.help).toMatch(/advisory lock/i)
  })
})

// ---------------------------------------------------------------------------
// resetAdvisoryLockMetrics — state-transition invariants
// ---------------------------------------------------------------------------

describe('resetAdvisoryLockMetrics – state-transition invariants', () => {
  it('is safe to call when no gauge has been registered yet (no throw)', () => {
    resetAdvisoryLockMetrics()
    expect(() => resetAdvisoryLockMetrics()).not.toThrow()
  })

  it('forces re-creation of the gauge on the next register call after reset', async () => {
    const reg1 = new client.Registry()
    const g1 = registerAdvisoryLockMetrics(reg1)

    resetAdvisoryLockMetrics()

    const reg2 = new client.Registry()
    const g2 = registerAdvisoryLockMetrics(reg2)

    // Different instances because reset cleared the singleton
    expect(g1).not.toBe(g2)
  })

  it('clears gauge state so a collection after reset starts from scratch', async () => {
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)

    // Populate gauge
    const pool = makeFakePool([lockRow({ lock_id: 'PRE:0', age_seconds: 400 })])
    await collectStaleAdvisoryLocks(pool as any, 300)

    // Reset wipes the module-level gauge reference
    resetAdvisoryLockMetrics()

    // Fresh collection — gauge auto-created internally, old labels never appear
    const emptyPool = makeFakePool([])
    await collectStaleAdvisoryLocks(emptyPool as any, 300)

    // The old registry should show no new observations for PRE:0
    const metrics = await registry.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'pg_advisory_lock_age_seconds')
    // After reset the old registry still holds the old gauge object which was
    // reset() by the second collect call — values array should be empty
    expect(gauge?.values ?? []).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Concurrent / partial-failure safety
// ---------------------------------------------------------------------------

describe('advisoryLockMonitor – concurrent and partial-failure safety', () => {
  beforeEach(() => {
    resetAdvisoryLockMetrics()
  })

  it('handles two simultaneous getStaleAdvisoryLocks calls independently', async () => {
    const poolA = makeFakePool([lockRow({ lock_id: 'A:0', age_seconds: 350 })])
    const poolB = makeFakePool([lockRow({ lock_id: 'B:0', age_seconds: 450 })])

    const [resultA, resultB] = await Promise.all([
      getStaleAdvisoryLocks(poolA as any, 300),
      getStaleAdvisoryLocks(poolB as any, 300),
    ])

    expect(resultA[0].lockId).toBe('A:0')
    expect(resultB[0].lockId).toBe('B:0')
  })

  it('one failing concurrent call does not affect the result of a successful sibling', async () => {
    const goodPool = makeFakePool([lockRow({ lock_id: 'OK:0', age_seconds: 350 })])
    const badPool = makeRejectingPool(new Error('timeout'))

    const [good, bad] = await Promise.allSettled([
      getStaleAdvisoryLocks(goodPool as any, 300),
      getStaleAdvisoryLocks(badPool as any, 300),
    ])

    expect(good.status).toBe('fulfilled')
    expect((good as PromiseFulfilledResult<any>).value[0].lockId).toBe('OK:0')
    expect(bad.status).toBe('rejected')
  })

  it('sequential collect calls do not accumulate duplicate gauge entries', async () => {
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)

    const pool = makeFakePool([lockRow({ lock_id: 'DUP:0', age_seconds: 400 })])
    await collectStaleAdvisoryLocks(pool as any, 300)
    await collectStaleAdvisoryLocks(pool as any, 300)
    await collectStaleAdvisoryLocks(pool as any, 300)

    const metrics = await registry.getMetricsAsJSON()
    const gauge = metrics.find((m) => m.name === 'pg_advisory_lock_age_seconds')
    const dupEntries = (gauge?.values ?? []).filter((v: any) => v.labels?.lock_id === 'DUP:0')
    expect(dupEntries).toHaveLength(1)
  })
})
