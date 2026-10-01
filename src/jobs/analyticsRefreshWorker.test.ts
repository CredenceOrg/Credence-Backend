import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AnalyticsRefreshWorker, getAnalyticsRefreshIntervalMs } from './analyticsRefreshWorker.js'
import type { AnalyticsService } from '../services/analytics/service.js'
import type { AnalyticsRefreshMetrics } from './analyticsRefreshMetrics.js'

function makeService(overrides?: Partial<AnalyticsService>): AnalyticsService {
  return {
    getSummary: vi.fn(),
    refreshConcurrently: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AnalyticsService
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
    const service = makeService()
    const worker = new AnalyticsRefreshWorker(service, logger)

    const result = await worker.run()

    expect(service.refreshConcurrently).toHaveBeenCalledOnce()
    expect(result.refreshed).toBe(true)
    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(result.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.error).toBeUndefined()
  })

  it('logs start and completion messages', async () => {
    const service = makeService()
    const worker = new AnalyticsRefreshWorker(service, logger)

    await worker.run()

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Starting analytics'))
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('completed'))
  })

  it('records success metrics when metrics are provided', async () => {
    const service = makeService()
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker(service, logger, metrics)

    await worker.run()

    expect(metrics.incRuns).toHaveBeenCalledWith('success')
    expect(metrics.observeDuration).toHaveBeenCalledWith(expect.any(Number))
  })

  it('returns error result and records error metric when refresh throws', async () => {
    const service = makeService({
      refreshConcurrently: vi.fn().mockRejectedValue(new Error('pg connection lost')),
    })
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker(service, logger, metrics)

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('pg connection lost')
    expect(metrics.incRuns).toHaveBeenCalledWith('error')
    expect(metrics.observeDuration).toHaveBeenCalledWith(expect.any(Number))
  })

  it('handles non-Error thrown values gracefully', async () => {
    const service = makeService({
      refreshConcurrently: vi.fn().mockRejectedValue('string error'),
    })
    const worker = new AnalyticsRefreshWorker(service, logger)

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('Unknown refresh error')
  })

  it('returns a deterministic error result for a null thrown value', async () => {
    const service = makeService({
      refreshConcurrently: vi.fn().mockRejectedValue(null),
    })
    const worker = new AnalyticsRefreshWorker(service, logger)

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('Unknown refresh error')
  })

  it('returns an error result for an empty Error message without losing the failure signal', async () => {
    const service = makeService({
      refreshConcurrently: vi.fn().mockRejectedValue(new Error('')),
    })
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker(service, logger, metrics)

    const result = await worker.run()

    expect(result.refreshed).toBe(false)
    expect(result.error).toBe('Unknown refresh error')
    expect(metrics.incRuns).toHaveBeenCalledWith('error')
  })

  it('records a non-negative duration even when the refresh fails', async () => {
    const service = makeService({
      refreshConcurrently: vi.fn().mockRejectedValue(new Error('boom'])),
    })
    const worker = new AnalyticsRefreshWorker(service, logger)

    const result = await worker.run()

    expect(result.duration).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(result.duration)).toBe(true)
  })

  it('returns an error result without throwing when the service is unavailable', async () => {
    const service = makeService({
      refreshConcurrently: vi.fn().mockRejectedValue(new Error('service unavailable')),
    })
    const worker = new AnalyticsRefreshWorker(service, logger)

    await expect(worker.run()).resolves.toMatchObject({ refreshed: false })
  })

  it('supports concurrent runs without interfering with each other', async () => {
    const service = makeService()
    const worker = new AnalyticsRefreshWorker(service, logger)

    const results = await Promise.all([worker.run(), worker.run(), worker.run()])

    expect(service.refreshConcurrently).toHaveBeenCalledTimes(3)
    for (const result of results) {
      expect(result.refreshed).toBe(true)
    }
  })

  it('recovers and succeeds on a subsequent run after a transient failure', async () => {
    const refreshConcurrently = vi.fn()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValue(undefined)
    const service = makeService({ refreshConcurrently })
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker(service, logger, metrics)

    const first = await worker.run()
    const second = await worker.run()

    expect(first.refreshed).toBe(false)
    expect(first.error).toBe('transient failure')
    expect(second.refreshed).toBe(true)
    expect(second.error).toBeUndefined()
    expect(metrics.incRuns).toHaveBeenCalledWith('error')
    expect(metrics.incRuns).toHaveBeenCalledWith('success')
  })

  it('records metrics for every run in a mixed success/failure sequence', async () => {
    const refreshConcurrently = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined)
    const service = makeService({ refreshConcurrently })
    const metrics = makeMetrics()
    const worker = new AnalyticsRefreshWorker(service, logger, metrics)

    await worker.run()
    await worker.run()
    await worker.run()

    expect(metrics.incRuns).toHaveBeenCalledWith('success')
    expect(metrics.incRuns).toHaveBeenCalledWith('error')
    expect(metrics.observeDuration).toHaveBeenCalledTimes(3)
  })

  it('does not throw when metrics are omitted during a failure', async () => {
    const service = makeService({
      refreshConcurrently: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const worker = new AnalyticsRefreshWorker(service, logger)

    await expect(worker.run()).resolves.toMatchObject({ refreshed: false })
  })

  it('returns a valid ISO startTime on both success and failure', async () => {
    const successService = makeService()
    const failureService = makeService({
      refreshConcurrently: vi.fn().mockRejectedValue(new Error('boom')),
    })

    const successResult = await new AnalyticsRefreshWorker(successService, logger).run()
    const failureResult = await new AnalyticsRefreshWorker(failureService, logger).run()

    expect(Number.isNaN(Date.parse(successResult.startTime))).toBe(false)
    expect(Number.isNaN(Date.parse(failureResult.startTime))).toBe(false)
  })

  it('propagates a rejection from the logger without corrupting the result shape', async () => {
    const service = makeService()
    const throwingLogger = vi.fn(() => {
      throw new Error('logger failure')
    })
    const worker = new AnalyticsRefreshWorker(service, throwingLogger)

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
