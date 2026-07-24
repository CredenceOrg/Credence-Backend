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
})
