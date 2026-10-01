import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DistributedLock } from '../../src/jobs/distributedLock.js'
import type { RedisClient } from '../../src/cache/redis.js'
import { InvoiceDueDateWorker } from '../../src/jobs/invoiceDueDateWorker.js'
import type { ExportWorker } from '../../src/jobs/exportWorker.js'
import type { AnalyticsRefreshWorker } from '../../src/jobs/analyticsRefreshWorker.js'
import {
  createLockedInvoiceDueDateWorker,
  createLockedExportWorker,
  createLockedAnalyticsRefreshWorker,
  type BaseLockedWorkerOptions,
} from '../../src/jobs/lockedWorkers.js'

// Exercise the real lock lifecycle without sockets or wall-clock sleeps. The
// Redis double models atomic NX, exact PX expiry, and token-checked Lua calls.
function makeRedis() {
  const entries = new Map<string, { value: string; expiresAt: number }>()
  const read = (key: string) => {
    const entry = entries.get(key)
    if (entry && entry.expiresAt > Date.now()) return entry
    entries.delete(key)
  }
  return {
    get: vi.fn(async (key: string) => read(key)?.value ?? null),
    set: vi.fn(async (key: string, value: string, options?: { NX?: boolean; PX?: number }) => {
      if (options?.NX && read(key)) return null
      entries.set(key, { value, expiresAt: options?.PX === undefined ? Infinity : Date.now() + options.PX })
      return 'OK'
    }),
    eval: vi.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
      const entry = read(options.keys[0])
      if (!entry || entry.value !== options.arguments[0]) return 0
      if (options.arguments.length === 1) entries.delete(options.keys[0])
      else entry.expiresAt = Date.now() + Number(options.arguments[1])
      return 1
    }),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type Options = Partial<Omit<BaseLockedWorkerOptions, 'distributedLock' | 'lockKey'>>
const cases = [
  {
    name: 'invoice', ttl: 30 * 60 * 1000,
    result: { processedTenants: 1, evaluatedInvoices: 2, triggeredActions: 2, errors: 0, duration: 1, startTime: '2026-09-29T00:00:00.000Z' },
    failure: { processedTenants: 1, evaluatedInvoices: 2, triggeredActions: 1, errors: 1, duration: 1, startTime: '2026-09-29T00:00:00.000Z' },
    make: (run: ReturnType<typeof vi.fn>, lock: DistributedLock, key: string, options?: Options) =>
      createLockedInvoiceDueDateWorker({ run } as unknown as InvoiceDueDateWorker, lock, key, options),
  },
  {
    name: 'export', ttl: 60 * 60 * 1000,
    result: { totalRows: 2, batchesProcessed: 1, errors: 0, duration: 1, startTime: '2026-09-29T00:00:00.000Z' },
    failure: { totalRows: 1, batchesProcessed: 1, errors: 1, duration: 1, startTime: '2026-09-29T00:00:00.000Z' },
    make: (run: ReturnType<typeof vi.fn>, lock: DistributedLock, key: string, options?: Options) =>
      createLockedExportWorker({ run } as unknown as ExportWorker, lock, key, options),
  },
  {
    name: 'analytics', ttl: 15 * 60 * 1000,
    result: { refreshed: true, refreshedViews: ['summary'], failedViews: [], durationMs: 1, startTime: '2026-09-29T00:00:00.000Z' },
    failure: { refreshed: false, refreshedViews: ['summary'], failedViews: [{ view: 'details', error: 'private database detail' }], durationMs: 1, startTime: '2026-09-29T00:00:00.000Z' },
    make: (run: ReturnType<typeof vi.fn>, lock: DistributedLock, key: string, options?: Options) =>
      createLockedAnalyticsRefreshWorker({ run } as unknown as AnalyticsRefreshWorker, lock, key, options),
  },
]

describe.each(cases)('$name locked worker boundary and recovery', spec => {
  const key = `cron:${spec.name}`
  const marker = `${key}:lastRun`
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T00:00:00Z'))
  })
  afterEach(() => { vi.useRealTimers() })

  function fixture(options: Options = {}) {
    const redis = makeRedis()
    const lock = new DistributedLock(redis as unknown as RedisClient)
    const run = vi.fn().mockResolvedValue(spec.result)
    const logger = vi.fn()
    const worker = spec.make(run, lock, key, { redisClient: redis, enableIdempotency: true, logger, ...options })
    return { redis, lock, run, logger, worker }
  }

  it('returns the original result and publishes the default-TTL marker only after success', async () => {
    const { worker, run, redis, lock } = fixture()
    const started = deferred<void>()
    const finish = deferred<typeof spec.result>()
    run.mockImplementationOnce(() => { started.resolve(); return finish.promise })
    const pending = worker.run()
    await started.promise
    expect(await redis.get(marker)).toBeNull()
    expect(await redis.get(key)).not.toBeNull()
    finish.resolve(spec.result)
    expect(await pending).toBe(spec.result)
    expect(redis.set).toHaveBeenCalledWith(marker, '2026-09-29T00:00:00.000Z', { PX: spec.ttl })
    expect(await redis.get(key)).toBeNull()
    expect(worker.getLockMetrics()).toEqual(lock.getMetrics())
    expect(lock.getMetrics()).toMatchObject({ acquisitions: 1, releases: 1, errors: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('skips duplicates without acquiring the lock or extending marker expiry', async () => {
    const { worker, run, redis, lock, logger } = fixture()
    await redis.set(marker, 'private-marker-value', { PX: spec.ttl })
    expect(await worker.run()).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(lock.getMetrics().acquisitions).toBe(0)
    expect(redis.set).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('idempotency'))
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private-marker-value')
  })

  it('expires the marker at the exact custom TTL boundary', async () => {
    const { worker, run } = fixture({ lockTtlMs: 1000 })
    await worker.run()
    await vi.advanceTimersByTimeAsync(999)
    expect(await worker.run()).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(await worker.run()).toBe(spec.result)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('treats an empty marker as absent and isolates markers by job key', async () => {
    const { worker, redis, run } = fixture()
    await redis.set(marker, '', { PX: 1000 })
    await redis.set('cron:unrelated:lastRun', 'complete', { PX: 1000 })
    expect(await worker.run()).toBe(spec.result)
    expect(run).toHaveBeenCalledTimes(1)
    expect(await redis.get('cron:unrelated:lastRun')).toBe('complete')
  })

  it('retains no-options factory behavior without requiring an idempotency client or logger', async () => {
    const redis = makeRedis()
    const run = vi.fn().mockResolvedValue(spec.result)
    const worker = spec.make(run, new DistributedLock(redis as unknown as RedisClient), key)
    await worker.run()
    await worker.run()
    expect(run).toHaveBeenCalledTimes(2)
    expect(await redis.get(marker)).toBeNull()
  })

  it.each([
    { enableIdempotency: false },
    { redisClient: undefined },
  ])('preserves opt-out compatibility with %o', async options => {
    const { worker, redis, run } = fixture(options)
    await redis.set(marker, 'existing', { PX: 1000 })
    await worker.run()
    await worker.run()
    expect(run).toHaveBeenCalledTimes(2)
    expect(redis.get).not.toHaveBeenCalled()
    expect(redis.set.mock.calls.filter(([storedKey]) => storedKey === marker)).toHaveLength(1)
  })

  it('returns null on contention without publishing a marker and diagnoses the skip', async () => {
    const { worker, redis, run, logger, lock } = fixture()
    await redis.set(key, 'other-owner', { PX: 1000 })
    expect(await worker.run()).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(await redis.get(marker)).toBeNull()
    expect(await redis.get(key)).toBe('other-owner')
    expect(lock.getMetrics()).toMatchObject({ contentions: 1, releases: 0 })
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('lock held by another worker'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(await worker.run()).toBe(spec.result)
  })

  it('rejects a marker read failure before work and permits retry after recovery', async () => {
    const { worker, redis, run } = fixture()
    const error = new Error('permission denied')
    redis.get.mockRejectedValueOnce(error)
    await expect(worker.run()).rejects.toBe(error)
    expect(run).not.toHaveBeenCalled()
    expect(redis.set).not.toHaveBeenCalled()
    expect(await worker.run()).toBe(spec.result)
  })

  it('rejects acquisition failure without invoking work or marking completion', async () => {
    const { worker, redis, run, lock } = fixture()
    const error = new Error('Redis unavailable')
    redis.set.mockRejectedValueOnce(error)
    await expect(worker.run()).rejects.toBe(error)
    expect(run).not.toHaveBeenCalled()
    expect(await redis.get(marker)).toBeNull()
    expect(lock.getMetrics().errors).toBe(1)
    expect(await worker.run()).toBe(spec.result)
  })

  it('releases the lock after rejection, preserves the error, and allows a successful retry', async () => {
    const { worker, run, redis, lock } = fixture()
    const error = new Error('worker validation failed')
    run.mockRejectedValueOnce(error)
    await expect(worker.run()).rejects.toBe(error)
    expect(await redis.get(marker)).toBeNull()
    expect(await redis.get(key)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(await worker.run()).toBe(spec.result)
    expect(lock.getMetrics().releases).toBe(2)
  })

  it('returns partial failures without marking completion, allowing recovery without waiting for TTL', async () => {
    const { worker, run, redis, logger } = fixture()
    run.mockResolvedValueOnce(spec.failure)
    expect(await worker.run()).toBe(spec.failure)
    expect(await redis.get(marker)).toBeNull()
    expect(await redis.get(key)).toBeNull()
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('not marked complete'))
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private database detail')
    expect(await worker.run()).toBe(spec.result)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('propagates marker-write failure and releases ownership without recording false success', async () => {
    const { worker, redis, run } = fixture()
    const error = new Error('marker write rejected')
    const set = redis.set.getMockImplementation()!
    redis.set.mockImplementationOnce(set).mockRejectedValueOnce(error)
    await expect(worker.run()).rejects.toBe(error)
    expect(await redis.get(marker)).toBeNull()
    expect(await redis.get(key)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    // The job already ran: retries require the underlying worker's existing
    // idempotency. A lock/marker cannot roll back external side effects.
    expect(await worker.run()).toBe(spec.result)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps a completed marker when release fails so a retry cannot repeat completed work', async () => {
    const { worker, redis, run, lock } = fixture()
    redis.eval.mockRejectedValueOnce(new Error('release unavailable'))
    expect(await worker.run()).toBe(spec.result)
    expect(lock.getMetrics().errors).toBe(1)
    expect(await worker.run()).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('excludes concurrent replicas and maintains ownership across heartbeat boundaries', async () => {
    const { worker, redis, run, lock } = fixture({ lockTtlMs: 1000 })
    const started = deferred<void>()
    const finish = deferred<typeof spec.result>()
    run.mockImplementationOnce(() => { started.resolve(); return finish.promise })
    const pending = worker.run()
    await started.promise
    const otherRun = vi.fn().mockResolvedValue(spec.result)
    const other = spec.make(otherRun, new DistributedLock(redis as unknown as RedisClient), key, { redisClient: redis, enableIdempotency: true, lockTtlMs: 1000 })
    await vi.advanceTimersByTimeAsync(1200)
    expect(lock.getMetrics().heartbeats).toBe(2)
    expect(await other.run()).toBeNull()
    expect(otherRun).not.toHaveBeenCalled()
    finish.resolve(spec.result)
    await pending
    expect(await other.run()).toBeNull()
    expect(otherRun).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks a stale pre-lock read after another replica finishes and releases', async () => {
    const { worker, run, redis } = fixture()
    const readStarted = deferred<void>()
    const staleRead = deferred<string | null>()
    redis.get.mockImplementationOnce(() => { readStarted.resolve(); return staleRead.promise })
    const pending = worker.run()
    await readStarted.promise
    const otherRun = vi.fn().mockResolvedValue(spec.result)
    const other = spec.make(otherRun, new DistributedLock(redis as unknown as RedisClient), key, { redisClient: redis, enableIdempotency: true })
    await other.run()
    staleRead.resolve(null)
    expect(await pending).toBeNull()
    expect(run).not.toHaveBeenCalled()
    expect(otherRun).toHaveBeenCalledTimes(1)
    expect(await redis.get(key)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails closed on the under-lock marker read and releases ownership before retry', async () => {
    const { worker, run, redis } = fixture()
    const get = redis.get.getMockImplementation()!
    const error = new Error('marker permission denied')
    redis.get.mockImplementationOnce(get).mockRejectedValueOnce(error)
    await expect(worker.run()).rejects.toBe(error)
    expect(run).not.toHaveBeenCalled()
    expect(await redis.get(key)).toBeNull()
    expect(await worker.run()).toBe(spec.result)
  })
})

describe('invoice caller compatibility', () => {
  it.each([undefined, new Date('2026-09-29T12:00:00Z'), '2026-09-29T12:00:00Z'])('forwards nowUtc unchanged: %s', async nowUtc => {
    const redis = makeRedis()
    const run = vi.fn().mockResolvedValue(cases[0].result)
    const worker = createLockedInvoiceDueDateWorker({ run } as unknown as InvoiceDueDateWorker, new DistributedLock(redis as unknown as RedisClient), 'invoice')
    await worker.run(nowUtc)
    expect(run).toHaveBeenCalledWith(nowUtc)
  })

  it.each(['invalid-date', '2026-09-29T12:00:00', new Date(NaN)])('preserves real date validation without accessing tenant data: %s', async invalidDate => {
    const redis = makeRedis()
    const listTenants = vi.fn().mockResolvedValue([])
    const listPendingDueDateInvoices = vi.fn()
    const underlying = new InvoiceDueDateWorker(
      { listPendingDueDateInvoices, markDueDateActionTriggered: vi.fn() },
      { listTenants },
    )
    const worker = createLockedInvoiceDueDateWorker(underlying, new DistributedLock(redis as unknown as RedisClient), 'invoice', { redisClient: redis, enableIdempotency: true })
    await expect(worker.run(invalidDate)).rejects.toThrow()
    expect(listTenants).not.toHaveBeenCalled()
    expect(listPendingDueDateInvoices).not.toHaveBeenCalled()
    expect(await redis.get('invoice')).toBeNull()
    expect(await redis.get('invoice:lastRun')).toBeNull()
    expect(await worker.run('2026-09-29T12:00:00Z')).toMatchObject({ errors: 0, evaluatedInvoices: 0 })
  })

  it('recovers a real partial tenant failure without retriggering completed invoice actions', async () => {
    const redis = makeRedis()
    const now = '2026-09-29T12:00:00Z'
    const triggered = new Map<string, string>()
    const markDueDateActionTriggered = vi.fn(async (id: string, at: string) => { triggered.set(id, at) })
    let failSecondTenant = true
    const underlying = new InvoiceDueDateWorker({
      listPendingDueDateInvoices: vi.fn(async (tenant: string) => {
        if (tenant === 'second' && failSecondTenant) {
          failSecondTenant = false
          throw new Error('temporary repository outage')
        }
        return [{ invoiceId: tenant, dueAtUtc: now, actionTriggeredAtUtc: triggered.get(tenant) }]
      }),
      markDueDateActionTriggered,
    }, { listTenants: async () => [{ tenantId: 'first', timezone: 'UTC' }, { tenantId: 'second', timezone: 'UTC' }] })
    const worker = createLockedInvoiceDueDateWorker(underlying, new DistributedLock(redis as unknown as RedisClient), 'invoice', { redisClient: redis, enableIdempotency: true })
    expect(await worker.run(now)).toMatchObject({ errors: 1, triggeredActions: 1 })
    expect(await redis.get('invoice:lastRun')).toBeNull()
    expect(await worker.run(now)).toMatchObject({ errors: 0, triggeredActions: 1 })
    expect(markDueDateActionTriggered.mock.calls).toEqual([['first', new Date(now).toISOString()], ['second', new Date(now).toISOString()]])
    expect(await worker.run(now)).toBeNull()
    expect(markDueDateActionTriggered).toHaveBeenCalledTimes(2)
  })
})

describe('analytics resolved-error boundaries', () => {
  it.each([
    { refreshed: false, failedViews: [], error: 'private failure' },
    { refreshed: true, failedViews: [], error: 'private failure' },
    { refreshed: true, failedViews: [{ view: 'summary', error: 'private failure' }] },
  ])('does not mark degraded or inconsistent success flags complete: %o', async failure => {
    const redis = makeRedis()
    const result = { ...cases[2].result, ...failure }
    const run = vi.fn().mockResolvedValue(result)
    const worker = createLockedAnalyticsRefreshWorker({ run } as unknown as AnalyticsRefreshWorker, new DistributedLock(redis as unknown as RedisClient), 'analytics', { redisClient: redis, enableIdempotency: true })
    expect(await worker.run()).toBe(result)
    expect(await redis.get('analytics:lastRun')).toBeNull()
    expect(await redis.get('analytics')).toBeNull()
  })
})
