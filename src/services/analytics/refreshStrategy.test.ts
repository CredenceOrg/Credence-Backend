import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  AnalyticsRefreshStrategy,
  classifyTransientDbError,
  isPoolLike,
  ANALYTICS_REFRESH_STATE_TABLE,
  type Connectable,
  type AnalyticsViewSpec,
  type TransientErrorKind,
} from './refreshStrategy.js'
import { resetAnalyticsRefreshMetrics } from '../../jobs/analyticsRefreshMetrics.js'

// ---------------------------------------------------------------------------
// In-memory stub of the Connectable interface. Records every SQL statement
// issued either via `query()` (used for state-table writes) or via a
// dedicated client returned from `connect()` (used for the SET + REFRESH
// pair). Per-script replies let a test simulate transient errors, lock
// contention, or statement timeouts deterministically.
// ---------------------------------------------------------------------------

interface QueryRecord {
  text: string
  params?: readonly unknown[]
}

class StubClient {
  constructor(
    private readonly pool: StubPool,
    public released = false,
  ) {}
  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    this.pool.records.push({ text, params })
    const reply = this.pool.scripts.shift()
    if (reply === undefined) {
      return { rows: [], rowCount: 0 }
    }
    if (reply.kind === 'rows') {
      return { rows: reply.rows as R[], rowCount: reply.rows.length }
    }
    // Build a Postgres-shaped error from a kind/message/SQLSTATE triple.
    const err = Object.assign(new Error(`${reply.kind}: ${reply.message}`), {
      code: reply.sqlState,
    })
    throw err
  }
  release(): void {
    this.released = true
  }
}

type Script =
  | { kind: 'rows'; rows: Record<string, unknown>[] }
  | { kind: 'error'; sqlState: string; message: string }

class StubPool implements Connectable {
  records: QueryRecord[] = []
  /** Queue of pre-canned replies; one consumed per query call. */
  scripts: Script[] = []
  /** Optional: pre-populate rows returned from a `query` call that matches a SQL fragment. */
  rowHook?: (text: string, params?: readonly unknown[]) => Record<string, unknown>[]

  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    this.records.push({ text, params })
    if (this.rowHook) {
      return { rows: this.rowHook(text, params) as R[], rowCount: 1 }
    }
    if (this.scripts.length === 0) {
      return { rows: [], rowCount: 0 }
    }
    const reply = this.scripts.shift()!
    if (reply.kind === 'rows') {
      return { rows: reply.rows as R[], rowCount: reply.rows.length }
    }
    const err = Object.assign(new Error(`${reply.kind}: ${reply.message}`), {
      code: reply.sqlState,
    })
    throw err
  }

  async connect(): Promise<StubClient> {
    return new StubClient(this)
  }

  /** Helper for tests: assert that a recorded statement matches a predicate. */
  hasRecord(pred: (r: QueryRecord) => boolean): boolean {
    return this.records.some(pred)
  }
}

const VIEW: AnalyticsViewSpec = {
  name: 'analytics_metrics_mv',
  statementTimeoutMs: 30_000,
}
const VIEW2: AnalyticsViewSpec = {
  name: 'analytics_other_mv',
  statementTimeoutMs: 60_000,
}

const metricsSink = () => {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    incRuns: viFn((status: 'success' | 'error', view: string) => {
      calls.push({ method: 'incRuns', status, view })
    }),
    observeDuration: viFn((seconds: number, view: string) => {
      calls.push({ method: 'observeDuration', seconds, view })
    }),
    incTransientRetry: viFn((view: string, kind: TransientErrorKind) => {
      calls.push({ method: 'incTransientRetry', view, kind })
    }),
    setCacheGeneration: viFn((value: number) => {
      calls.push({ method: 'setCacheGeneration', value })
    }),
    setConsecutiveFailures: viFn((view: string, count: number) => {
      calls.push({ method: 'setConsecutiveFailures', view, count })
    }),
    incSkip: viFn((reason: string) => {
      calls.push({ method: 'incSkip', reason })
    }),
  }
}

// Inline vitest stub for typed-by-hand test doubles so the metric sink
// helpers can declare their method signatures once without repeating the
// `vi.fn` ceremony at every call site.
function viFn<T extends (...args: never[]) => unknown>(impl: T): T {
  return vi.fn(impl) as unknown as T
}

// ---------------------------------------------------------------------------
// classifyTransientDbError — pg SQLSTATE matcher
// ---------------------------------------------------------------------------

describe('classifyTransientDbError', () => {
  it.each<[string, TransientErrorKind]>([
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock_detected'],
    ['55P03', 'lock_not_available'],
    ['57P03', 'cannot_connect_now'],
    ['08000', 'connection_exception'],
    ['08001', 'connection_exception'],
    ['08006', 'connection_exception'],
    ['53300', 'too_many_connections'],
    ['57014', 'query_canceled'],
  ])('classifies %s as %s', (sqlState, expected) => {
    const err = Object.assign(new Error('boom'), { code: sqlState })
    expect(classifyTransientDbError(err)?.kind).toBe(expected)
  })

  it.each(['23505', '22001', '42P01', '0AD00'])(
    'returns null for non-transient SQLSTATE %s',
    (sqlState) => {
      const err = Object.assign(new Error('boom'), { code: sqlState })
      expect(classifyTransientDbError(err)).toBeNull()
    },
  )

  it('returns null for non-Postgres errors', () => {
    expect(classifyTransientDbError(new Error('boom'))).toBeNull()
    expect(classifyTransientDbError('boom')).toBeNull()
    expect(classifyTransientDbError(null)).toBeNull()
    expect(classifyTransientDbError(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isPoolLike
// ---------------------------------------------------------------------------

describe('isPoolLike', () => {
  it('accepts objects with both query and connect methods', () => {
    expect(isPoolLike(new StubPool())).toBe(true)
  })

  it('rejects objects missing connect()', () => {
    expect(isPoolLike({ query: () => Promise.resolve({ rows: [], rowCount: 0 }) })).toBe(false)
  })

  it('rejects non-objects', () => {
    expect(isPoolLike(null)).toBe(false)
    expect(isPoolLike(undefined)).toBe(false)
    expect(isPoolLike(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Strategy.refreshAll — happy path
// ---------------------------------------------------------------------------

describe('AnalyticsRefreshStrategy.refreshAll — happy path', () => {
  let pool: StubPool
  let metrics: ReturnType<typeof metricsSink>

  beforeEach(() => {
    resetAnalyticsRefreshMetrics()
    pool = new StubPool()
    metrics = metricsSink()
  })

  it('refreshes a single view: SET statement_timeout, REFRESH, state-table writes, metrics, cache bump', async () => {
    const strategy = new AnalyticsRefreshStrategy({
      pool,
      views: [VIEW],
      metrics,
      retryBackoffMs: 0,
      sleep: async () => undefined,
    })

    const result = await strategy.refreshAll()

    expect(result.refreshedViews).toEqual(['analytics_metrics_mv'])
    expect(result.failedViews).toEqual([])
    expect(result.cacheGeneration).toBeGreaterThan(0)

    // Per-view SET must appear on a dedicated client side, not on the
    // shared pool.query (the strategy never writes SET statement_timeout
    // through pool.query; it goes through client.query on a connect() call).
    expect(
      pool.records.some(
        (r) => r.text === `SET statement_timeout = ${VIEW.statementTimeoutMs}`,
      ),
    ).toBe(true)
    expect(
      pool.records.some(
        (r) => r.text === `REFRESH MATERIALIZED VIEW CONCURRENTLY "analytics_metrics_mv"`,
      ),
    ).toBe(true)

    // RESET statement_timeout must run on the dedicated client before release.
    const setIdx = pool.records.findIndex(
      (r) => r.text === `SET statement_timeout = ${VIEW.statementTimeoutMs}`,
    )
    expect(pool.records[setIdx + 1]?.text).toBe(`REFRESH MATERIALIZED VIEW CONCURRENTLY "analytics_metrics_mv"`)
    expect(pool.records.some((r) => r.text === 'RESET statement_timeout')).toBe(true)

    // last_attempt_at write should fire BEFORE the REFRESH so a stuck
    // refresh is observable via the state table.
    const orderOfWrites = pool.records
      .filter((r) => r.text.includes('analytics_view_refresh_state'))
      .map((r) => r.text.trim())

    expect(orderOfWrites.length).toBeGreaterThanOrEqual(2)
    expect(orderOfWrites[0]).toMatch(/last_attempt_at/)
    expect(orderOfWrites[orderOfWrites.length - 1]).toMatch(/last_success_at/)

    // Metrics were called exactly once for this view.
    expect(metrics.calls).toContainEqual({
      method: 'incRuns',
      status: 'success',
      view: 'analytics_metrics_mv',
    })
    expect(metrics.calls).toContainEqual({
      method: 'setCacheGeneration',
      value: result.cacheGeneration,
    })
    // No transient retries on a clean run.
    expect(metrics.calls.filter((c) => c.method === 'incTransientRetry')).toEqual([])
  })

  it('refreshes two views in order; cacheGeneration bumped once', async () => {
    const strategy = new AnalyticsRefreshStrategy({
      pool,
      views: [VIEW, VIEW2],
      metrics,
      retryBackoffMs: 0,
      sleep: async () => undefined,
    })

    const result = await strategy.refreshAll()

    expect(result.refreshedViews).toEqual([
      'analytics_metrics_mv',
      'analytics_other_mv',
    ])
    expect(result.failedViews).toEqual([])
    expect(typeof result.cacheGeneration).toBe('number')

    // The two REFRESH statements appear in order.
    const refreshIndexes = pool.records
      .map((r, i) => ({ i, text: r.text }))
      .filter((r) => r.text.startsWith('REFRESH MATERIALIZED VIEW CONCURRENTLY'))
      .map((r) => r.i)
    expect(refreshIndexes.length).toBe(2)
    expect(refreshIndexes[0]).toBeLessThan(refreshIndexes[1])

    // SET + RESET applied per-view with the right per-view timeout.
    expect(
      pool.records.some(
        (r) => r.text === `SET statement_timeout = ${VIEW.statementTimeoutMs}`,
      ),
    ).toBe(true)
    expect(
      pool.records.some(
        (r) => r.text === `SET statement_timeout = ${VIEW2.statementTimeoutMs}`,
      ),
    ).toBe(true)

    // Cache generation bumped once for the whole tick.
    const setCacheCalls = metrics.calls.filter((c) => c.method === 'setCacheGeneration')
    expect(setCacheCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Strategy.refreshAll — failure paths
// ---------------------------------------------------------------------------

describe('AnalyticsRefreshStrategy.refreshAll — failure paths', () => {
  let pool: StubPool
  let metrics: ReturnType<typeof metricsSink>

  beforeEach(() => {
    resetAnalyticsRefreshMetrics()
    pool = new StubPool()
    metrics = metricsSink()
  })

  it('does NOT bump cache generation when one view fails', async () => {
    // First view's REFRESH throws the non-transient "schema does not exist"
    // SQLSTATE (42P01) — strategy must fail fast without bumping generations.
    pool.scripts = [
      { kind: 'rows', rows: [] }, // last_attempt_at UPDATE — succeeds
      { kind: 'rows', rows: [] }, // REFRESH invites an error — line below
      {
        kind: 'error',
        sqlState: '42P01',
        message: 'relation "analytics_metrics_mv" does not exist',
      },
    ]
    const strategy = new AnalyticsRefreshStrategy({
      pool,
      views: [VIEW],
      retryBackoffMs: 0,
      sleep: async () => undefined,
      metrics,
    })

    const result = await strategy.refreshAll()

    expect(result.refreshedViews).toEqual([])
    expect(result.failedViews).toHaveLength(1)
    expect(result.failedViews[0].error?.kind).toBe('permanent')
    expect(result.cacheGeneration).toBeUndefined()
    expect(metrics.calls.filter((c) => c.method === 'setCacheGeneration')).toEqual([])
  })

  it('retries on transient SQLSTATE 40001 then succeeds; no error metric for the view', async () => {
    // First REFRESH throws serialization_failure (40001), second succeeds.
    pool.scripts = [
      { kind: 'rows', rows: [] }, // last_attempt_at UPDATE #1
      {
        kind: 'error',
        sqlState: '40001',
        message: 'could not serialize access',
      },
      // recordViewError UPDATE on shutdown
      { kind: 'rows', rows: [] },
      // Next attempt: last_attempt_at UPDATE
      { kind: 'rows', rows: [] },
      // The actual REFRESH success (we just need a non-error script)
      { kind: 'rows', rows: [] },
      // UPDATE state row to clear last_error on success
      { kind: 'rows', rows: [] },
    ]
    const strategy = new AnalyticsRefreshStrategy({
      pool,
      views: [VIEW],
      maxAttemptsPerView: 3,
      retryBackoffMs: 0,
      sleep: async () => undefined,
      metrics,
    })

    const result = await strategy.refreshAll()

    expect(result.refreshedViews).toEqual(['analytics_metrics_mv'])
    expect(result.failedViews).toEqual([])
    expect(
      metrics.calls.filter(
        (c) => c.method === 'incTransientRetry' && c.kind === 'serialization_failure',
      ).length,
    ).toBeGreaterThanOrEqual(1)
    // Success metric must fire exactly once (only on the second attempt).
    const incRunsSuccess = metrics.calls.filter(
      (c) => c.method === 'incRuns' && c.status === 'success',
    )
    expect(incRunsSuccess).toHaveLength(1)
    // Error metric must NOT fire for this view — the failure was retried.
    expect(metrics.calls.filter((c) => c.method === 'incRuns' && c.status === 'error')).toEqual([])
    // Cache generation does get bumped because the retry succeeded.
    expect(typeof result.cacheGeneration).toBe('number')
  })

  it('does not retry when the failing SQLSTATE is non-transient', async () => {
    pool.scripts = [
      { kind: 'rows', rows: [] }, // last_attempt_at UPDATE
      {
        kind: 'error',
        sqlState: '23505',
        message: 'unique violation',
      },
    ]
    const strategy = new AnalyticsRefreshStrategy({
      pool,
      views: [VIEW],
      maxAttemptsPerView: 3,
      retryBackoffMs: 0,
      sleep: async () => undefined,
      metrics,
    })

    const result = await strategy.refreshAll()

    expect(result.refreshedViews).toEqual([])
    expect(result.failedViews).toHaveLength(1)
    expect(result.failedViews[0].attempts).toBe(1) // no retries
    expect(result.failedViews[0].error?.kind).toBe('permanent')

    // Exactly one REFRESH was issued (no retry attempts).
    const refreshCount = pool.records.filter(
      (r) => r.text.startsWith('REFRESH MATERIALIZED VIEW CONCURRENTLY'),
    ).length
    expect(refreshCount).toBe(1)
    // No transient-retry metrics fired.
    expect(
      metrics.calls.filter((c) => c.method === 'incTransientRetry'),
    ).toEqual([])
  })

  it('still bumps cache generation when one of two views is permanently broken — expected: no bump', async () => {
    // First view succeeds, second view fails non-transient. ALL-or-NONE
    // means the cache generation must NOT bump.
    pool.scripts = [
      // VIEW: last_attempt_at, REFRESH (success), last_success_at
      { kind: 'rows', rows: [] },
      { kind: 'rows', rows: [] },
      { kind: 'rows', rows: [] },
      { kind: 'rows', rows: [] },
      // VIEW2: last_attempt_at, REFRESH (failure)
      { kind: 'rows', rows: [] },
      {
        kind: 'error',
        sqlState: '22001',
        message: 'value too long',
      },
    ]

    const strategy = new AnalyticsRefreshStrategy({
      pool,
      views: [VIEW, VIEW2],
      maxAttemptsPerView: 1,
      retryBackoffMs: 0,
      sleep: async () => undefined,
      metrics,
    })
    const result = await strategy.refreshAll()

    expect(result.refreshedViews).toEqual(['analytics_metrics_mv'])
    expect(result.failedViews.map((v) => v.view)).toEqual(['analytics_other_mv'])
    expect(result.cacheGeneration).toBeUndefined()
    expect(metrics.calls.filter((c) => c.method === 'setCacheGeneration')).toEqual([])
  })

  it('records last_error on the state row even when the refresh blows up', async () => {
    pool.scripts = [
      { kind: 'rows', rows: [] }, // last_attempt_at UPDATE
      {
        kind: 'error',
        sqlState: '40001',
        message: 'serialization_failure',
      },
      // recordViewError UPDATE — must hit the state table.
      { kind: 'rows', rows: [] },
    ]
    const strategy = new AnalyticsRefreshStrategy({
      pool,
      views: [VIEW],
      maxAttemptsPerView: 1,
      retryBackoffMs: 0,
      sleep: async () => undefined,
    })
    await strategy.refreshAll()

    // The state-row error write must reference the view's name and a string.
    const errorWrite = pool.records.find(
      (r) =>
        r.text.includes(ANALYTICS_REFRESH_STATE_TABLE) &&
        r.text.includes('last_error =') &&
        r.params?.[0] === 'analytics_metrics_mv',
    )
    expect(errorWrite).toBeTruthy()
  })

  it('exhausts retry budget and surfaces the final transient error', async () => {
    pool.scripts = [
      // Attempt 1: last_attempt_at (ok), REFRESH (error: query_canceled)
      { kind: 'rows', rows: [] },
      { kind: 'error', sqlState: '57014', message: 'canceling statement due to statement timeout' },
      { kind: 'rows', rows: [] }, // recordViewError
      // Attempt 2: last_attempt_at, REFRESH (error again)
      { kind: 'rows', rows: [] },
      { kind: 'error', sqlState: '57014', message: 'still too slow' },
      { kind: 'rows', rows: [] }, // recordViewError
      // Attempt 3: last_attempt_at, REFRESH (error)
      { kind: 'rows', rows: [] },
      { kind: 'error', sqlState: '57014', message: 'still too slow' },
      { kind: 'rows', rows: [] }, // recordViewError
    ]
    const strategy = new AnalyticsRefreshStrategy({
      pool,
      views: [VIEW],
      maxAttemptsPerView: 3,
      retryBackoffMs: 0,
      sleep: async () => undefined,
      metrics,
    })
    const result = await strategy.refreshAll()

    expect(result.refreshedViews).toEqual([])
    expect(result.failedViews).toHaveLength(1)
    expect(result.failedViews[0].attempts).toBe(3)
    expect(result.failedViews[0].error?.kind).toBe('query_canceled')
    expect(result.failedViews[0].error?.sqlState).toBe('57014')

    // Three REFRESH attempts issued.
    const refreshCount = pool.records.filter(
      (r) => r.text.startsWith('REFRESH MATERIALIZED VIEW CONCURRENTLY'),
    ).length
    expect(refreshCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Strategy constructor — defensive
// ---------------------------------------------------------------------------

describe('AnalyticsRefreshStrategy constructor', () => {
  it('rejects empty view list', () => {
    expect(() => new AnalyticsRefreshStrategy({ pool: new StubPool(), views: [] })).toThrow(
      /at least one view/,
    )
  })

  it('rejects missing pool', () => {
    expect(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new AnalyticsRefreshStrategy({ pool: undefined as any, views: [VIEW] }),
    ).toThrow(/requires a Postgres pool/)
  })

  it('refuses unsafe view identifiers with a defense-in-depth guard', async () => {
    // We can't actually execute the SQL via the stub because the stub
    // doesn't parse SQL — but we can verify the precondition that a
    // pathological view name throws before any DB calls.
    const pool = new StubPool()
    const strategy = new AnalyticsRefreshStrategy({
      pool,
      views: [{ name: 'analytics_metrics_mv"; DROP TABLE identities;--', statementTimeoutMs: 60_000 }],
      retryBackoffMs: 0,
      sleep: async () => undefined,
    })
    await expect(strategy.refreshAll()).rejects.toThrow(/Unsafe analytics view identifier/)
  })
})
