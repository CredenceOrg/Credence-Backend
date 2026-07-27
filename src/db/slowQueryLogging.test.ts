import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Pool, QueryResult } from 'pg'
import { instrumentSlowQueryLogging } from './pool.js'
import { logger } from '../utils/logger.js'
import { dbSlowQueriesTotal, dbSlowQueryDurationSeconds } from '../observability/customMetrics.js'

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('instrumentSlowQueryLogging', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    dbSlowQueriesTotal.reset()
    dbSlowQueryDurationSeconds.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Negative test: before this change, no code timed queries or emitted a
  // slow-query log at all, so this assertion fails on main. After the fix,
  // a query exceeding the threshold is logged together with its plan.
  it('logs a slow query together with its EXPLAIN plan, without leaking bind values', async () => {
    const mainResult = { rows: [{ id: 1 }], rowCount: 1 } as unknown as QueryResult
    const explainPlan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users' } }]

    const query = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15))
        return mainResult
      })
      .mockImplementationOnce(async (text: string) => {
        expect(text).toMatch(/^EXPLAIN \(FORMAT JSON\) SELECT/)
        return { rows: [{ 'QUERY PLAN': explainPlan }] } as unknown as QueryResult
      })

    const fakePool = { query } as unknown as Pool
    instrumentSlowQueryLogging(fakePool, 'api', 5)

    const result = await fakePool.query('SELECT * FROM users WHERE ssn = $1', ['secret-ssn-value'])
    expect(result).toBe(mainResult)

    await flushMicrotasks()

    expect(query).toHaveBeenCalledTimes(2)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    const [payload] = warnSpy.mock.calls[0] as [Record<string, unknown>]
    expect(payload.message).toBe('Slow query exceeded threshold')
    expect(payload.query).toBe('SELECT * FROM users WHERE ssn = $1')
    expect(payload.pool).toBe('api')
    expect(payload.thresholdMs).toBe(5)
    expect(payload.plan).toBe(JSON.stringify(explainPlan))
    expect(payload.durationMs as number).toBeGreaterThanOrEqual(5)

    // Bind parameter values must never be logged, only the placeholder text.
    expect(JSON.stringify(payload)).not.toContain('secret-ssn-value')
  })

  it('does not log or call EXPLAIN for a query that completes below the threshold', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 } as unknown as QueryResult)
    const fakePool = { query } as unknown as Pool
    instrumentSlowQueryLogging(fakePool, 'api', 10_000)

    await fakePool.query('SELECT 1')
    await flushMicrotasks()

    expect(query).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not wrap query() when thresholdMs is 0 (disabled)', () => {
    const query = vi.fn().mockResolvedValue({ rows: [] } as unknown as QueryResult)
    const fakePool = { query } as unknown as Pool
    const original = fakePool.query

    instrumentSlowQueryLogging(fakePool, 'api', 0)

    expect(fakePool.query).toBe(original)
  })

  it('still logs (with plan omitted) when EXPLAIN itself fails', async () => {
    const query = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { rows: [] } as unknown as QueryResult
      })
      .mockRejectedValueOnce(new Error('syntax error at or near "EXPLAIN"'))

    const fakePool = { query } as unknown as Pool
    instrumentSlowQueryLogging(fakePool, 'api', 5)

    await fakePool.query('SELECT pg_sleep(1)')
    await flushMicrotasks()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [payload] = warnSpy.mock.calls[0] as [Record<string, unknown>]
    expect(payload.plan).toBeUndefined()
  })

  it('still reports a slow query that ultimately rejects', async () => {
    const query = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        throw new Error('connection terminated')
      })
      .mockResolvedValueOnce({ rows: [{ 'QUERY PLAN': [{}] }] } as unknown as QueryResult)

    const fakePool = { query } as unknown as Pool
    instrumentSlowQueryLogging(fakePool, 'api', 5)

    await expect(
      fakePool.query('DELETE FROM sessions WHERE id = $1', ['abc'])
    ).rejects.toThrow('connection terminated')
    await flushMicrotasks()

    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('uses plain EXPLAIN, never EXPLAIN ANALYZE, so mutating queries are not re-executed', async () => {
    const query = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { rows: [], rowCount: 1 } as unknown as QueryResult
      })
      .mockImplementationOnce(async (text: string) => {
        expect(text).not.toContain('ANALYZE')
        return { rows: [{ 'QUERY PLAN': [{}] }] } as unknown as QueryResult
      })

    const fakePool = { query } as unknown as Pool
    instrumentSlowQueryLogging(fakePool, 'api', 5)

    await fakePool.query('DELETE FROM sessions WHERE id = $1', ['abc'])
    await flushMicrotasks()

    expect(query).toHaveBeenCalledTimes(2)
  })

  it('increments the slow-query counter and duration histogram', async () => {
    const query = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { rows: [] } as unknown as QueryResult
      })
      .mockResolvedValueOnce({ rows: [{ 'QUERY PLAN': [{}] }] } as unknown as QueryResult)

    const fakePool = { query } as unknown as Pool
    instrumentSlowQueryLogging(fakePool, 'worker', 5)

    await fakePool.query('SELECT 1')
    await flushMicrotasks()

    const counterValue = await dbSlowQueriesTotal.get()
    const workerSample = counterValue.values.find((v) => v.labels.pool === 'worker')
    expect(workerSample?.value).toBe(1)

    const histogramValue = await dbSlowQueryDurationSeconds.get()
    const workerHistogramSample = histogramValue.values.find(
      (v) => v.labels.pool === 'worker' && v.metricName?.endsWith('_count')
    )
    expect(workerHistogramSample?.value).toBe(1)
  })
})
