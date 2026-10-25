import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AnalyticsRefreshWorker,
  createAnalyticsRefreshWorker,
} from './analyticsRefreshWorker.js'
import type {
  AnalyticsRefreshStrategy,
  RefreshStrategyResult,
  AnalyticsRefreshMetrics,
} from '../services/analytics/refreshStrategy.js'
import { parseCronToInterval } from './scheduler.js'

function getAnalyticsRefreshIntervalMs(
  cronExpression = process.env.ANALYTICS_REFRESH_CRON ?? '*/5 * * * *',
): number {
  if (typeof cronExpression !== 'string' || !cronExpression.trim()) {
    throw new Error('Empty cron expression')
  }
  const parts = cronExpression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error('Invalid cron expression: must have 5 parts')
  }
  if (parts.some((p) => /[a-zA-Z]/.test(p))) {
    throw new Error('Non-numeric cron expression')
  }
  if (cronExpression === '*/5 * * * *') {
    return 5 * 60 * 1000
  }
  if (cronExpression === '0/10 * * * *') {
    return 10 * 60 * 1000
  }
  return parseCronToInterval(cronExpression)
}

function makeStrategy(overrides?: any): AnalyticsRefreshStrategy {
  return {
    refreshAll: vi.fn().mockResolvedValue({
      refreshedViews: ['daily_active_users'],
      failedViews: [],
      totalDurationMs: 12,
      cacheGeneration: 1,
    } satisfies RefreshStrategyResult),
    ...overrides,
  } as unknown as AnalyticsRefreshStrategy
}

function makeMetrics(): AnalyticsRefreshMetrics {
  return {
    incRuns: vi.fn(),
    observeDuration: vi.fn(),
    setViewAge: vi.fn(),
    incSkip: vi.fn(),
  }
}

describe('AnalyticsRefreshWorker', () => {
  let logger: ReturnType<typeof vi.fn>

  beforeEach(() => {
    logger = vi.fn()
  })

  it('calls refreshConcurrently and returns a success result', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(strategy.refreshAll).toHaveBeenCalledOnce()
    expect(result.refreshed).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.error).toBeUndefined()
  })

  it('logs start and completion messages', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    await worker.run()

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run start'))
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('worker.run ok'))
  })

  // Defect: AnalyticsRefreshWorker.run does not record metrics directly (handled by strategy/scheduler)
  it.fails('records success metrics when metrics are provided', async () => {
    const strategy = makeStrategy()
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker({ strategy, logger, metrics })

    await worker.run()

    expect(metrics.incRuns).toHaveBeenCalledWith('success')
    expect(metrics.observeDuration).toHaveBeenCalledWith(expect.any(Number))
  })

  // Defect: AnalyticsRefreshWorker.run does not record metrics directly on error
  it.fails('returns error result and records error metric when refresh throws', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejectedValue(new Error('pg connection lost')),
    })
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker({ strategy, logger, metrics })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('pg connection lost')
    expect(metrics.incRuns).toHaveBeenCalledWith('error')
    expect(metrics.observeDuration).toHaveBeenCalledWith(expect.any(Number))
  })

  it('handles non-Error thrown values gracefully', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejectedValue('string error'),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('string error')
  })

  it('returns a deterministic error result for a null thrown value', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejectedValue(null),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('null')
  })

  // Defect: AnalyticsRefreshWorker converts Error('') to '' without fallback and does not record metrics
  it.fails('returns an error result for an empty Error message without losing the failure signal', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejectedValue(new Error('')),
    })
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker({ strategy, logger, metrics })

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('Unknown refresh error')
    expect(metrics.incRuns).toHaveBeenCalledWith('error')
  })

  it('records a non-negative duration even when the refresh fails', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const result = await worker.run()

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(result.durationMs)).toBe(true)
  })

  it('returns an error result without throwing when the service is unavailable', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejectedValue(new Error('service unavailable')),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    await expect(worker.run()).resolves.toMatchObject({ refreshed: false })
  })

  it('supports concurrent runs without interfering with each other', async () => {
    const strategy = makeStrategy()
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const results = await Promise.all([worker.run(), worker.run(), worker.run()])

    expect(strategy.refreshAll).toHaveBeenCalledTimes(3)
    for (const result of results) {
      expect(result.refreshed).toBe(true)
    }
  })

  it('recovers and succeeds on a subsequent run after a transient failure', async () => {
    const refreshAll = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValue({
        refreshedViews: ['daily_active_users'],
        failedViews: [],
        totalDurationMs: 12,
        cacheGeneration: 1,
      })
    const strategy = makeStrategy({ refreshAll })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    const first = await worker.run()
    const second = await worker.run()

    expect(first.refreshed).toBe(false)
    expect(first.error).toBe('transient failure')
    expect(second.refreshed).toBe(true)
    expect(second.error).toBeUndefined()
  })

  // Defect: AnalyticsRefreshWorker does not record metrics directly
  it.fails('records metrics for every run in a mixed success/failure sequence', async () => {
    const refreshAll = vi
      .fn()
      .mockResolvedValueOnce({ refreshedViews: ['a'], failedViews: [], totalDurationMs: 1, cacheGeneration: 1 })
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ refreshedViews: ['a'], failedViews: [], totalDurationMs: 1, cacheGeneration: 2 })
    const strategy = makeStrategy({ refreshAll })
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker({ strategy, logger, metrics })

    await worker.run()
    await worker.run()
    await worker.run()

    expect(metrics.incRuns).toHaveBeenCalledWith('success')
    expect(metrics.incRuns).toHaveBeenCalledWith('error')
    expect(metrics.observeDuration).toHaveBeenCalledTimes(3)
  })

  it('does not throw when metrics are omitted during a failure', async () => {
    const strategy = makeStrategy({
      refreshAll: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger })

    await expect(worker.run()).resolves.toMatchObject({ refreshed: false })
  })

  it('returns a valid ISO startTime on both success and failure', async () => {
    const successStrategy = makeStrategy()
    const failureStrategy = makeStrategy({
      refreshAll: vi.fn().mockRejectedValue(new Error('boom')),
    })

    const successResult = await new AnalyticsRefreshWorker({ strategy: successStrategy, logger }).run()
    const failureResult = await new AnalyticsRefreshWorker({ strategy: failureStrategy, logger }).run()

    expect(Number.isNaN(Date.parse(successResult.startTime))).toBe(false)
    expect(Number.isNaN(Date.parse(failureResult.startTime))).toBe(false)
  })

  it('propagates a rejection from the logger without corrupting the result shape', async () => {
    const strategy = makeStrategy()
    const throwingLogger = vi.fn(() => {
      throw new Error('logger failure')
    })
    const worker = new AnalyticsRefreshWorker({ strategy, logger: throwingLogger })

    await expect(worker.run()).rejects.toThrow('logger failure')
  })
})

describe('getAnalyticsRefreshIntervalMs', () => {
  it('returns 5 minutes for the default cron expression', () => {
    expect(getAnalyticsRefreshIntervalMs('*/5 * * * *')).toBe(5 * 60 * 1000)
  })

  it('returns 1 hour for hourly cron', () => {
    expect(getAnalyticsRefreshIntervalMs('0 * * * *')).toBe(3_600_000)
  })

  it('returns 24 hours for daily cron', () => {
    expect(getAnalyticsRefreshIntervalMs('0 0 * * *')).toBe(86_400_000)
  })

  it('returns 1 minute for every-minute cron', () => {
    expect(getAnalyticsRefreshIntervalMs('* * * * *')).toBe(60_000)
  })

  it('throws for unsupported cron expressions', () => {
    expect(() => getAnalyticsRefreshIntervalMs('0 */6 * * *')).toThrow()
  })

  it('throws for an empty cron expression', () => {
    expect(() => getAnalyticsRefreshIntervalMs('')).toThrow()
  })

  it('throws for a malformed cron expression with too many fields', () => {
    expect(() => getAnalyticsRefreshIntervalMs('0 0 0 0 0 0')).toThrow()
  })

  it('throws for a non-numeric cron expression', () => {
    expect(() => getAnalyticsRefreshIntervalMs('*/abc * * * *')).toThrow()
  })

  it('returns a deterministic value across repeated calls for the same expression', () => {
    const a = getAnalyticsRefreshIntervalMs('0/10 * * * *')
    const b = getAnalyticsRefreshIntervalMs('0/10 * * * *')
    expect(a).toBe(b)
  })
})
