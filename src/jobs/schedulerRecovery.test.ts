import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DistributedLock } from './distributedLock.js'
import { createScheduler, JobScheduler, parseCronToInterval } from './scheduler.js'
import type { IdempotencyRedisClient } from './scheduler.js'
import { getActiveCorrelationIds } from '../utils/logger.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Model the Redis operations used by the scheduler and DistributedLock,
// including TTL expiry and ownership checks, without a live service.
function redisDouble() {
  const values = new Map<string, { value: string; expires: number }>()
  function read(key: string) {
    const entry = values.get(key)
    if (entry && entry.expires <= Date.now()) values.delete(key)
    return values.get(key)?.value ?? null
  }
  return {
    get: vi.fn(async (key: string) => read(key)),
    set: vi.fn(async (key: string, value: string, options?: { PX?: number; NX?: boolean }) => {
      if (options?.NX && read(key) !== null) return null
      values.set(key, { value, expires: Date.now() + (options?.PX ?? Infinity) })
      return 'OK'
    }),
    eval: vi.fn(async (script: string, options: { keys: string[]; arguments: string[] }) => {
      const key = options.keys[0]
      if (read(key) !== options.arguments[0]) return 0
      if (script.includes('pexpire')) {
        values.get(key)!.expires = Date.now() + Number(options.arguments[1])
      } else {
        values.delete(key)
      }
      return 1
    }),
  }
}

describe('scheduler boundaries and recovery', () => {
  const schedulers: JobScheduler[] = []
  const makeScheduler = (job: { run(): Promise<unknown> }, options: ConstructorParameters<typeof JobScheduler>[1]) => {
    const scheduler = new JobScheduler(job, options)
    schedulers.push(scheduler)
    return scheduler
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    schedulers.splice(0).forEach(scheduler => scheduler.stop())
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648])('rejects invalid interval %s before scheduling', intervalMs => {
    expect(() => makeScheduler({ run: vi.fn() }, { intervalMs })).toThrow(/intervalMs/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([1, 2_147_483_647])('accepts timer boundary %s', intervalMs => {
    const scheduler = makeScheduler({ run: vi.fn() }, { intervalMs })
    scheduler.start()
    expect(scheduler.isActive()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])('rejects invalid lock TTL %s', lockTtlMs => {
    expect(() => makeScheduler({ run: vi.fn() }, { intervalMs: 100, lockTtlMs })).toThrow(/lockTtlMs/)
  })

  it('rejects enabled idempotency without a Redis client', () => {
    expect(() => makeScheduler({ run: vi.fn() }, { intervalMs: 100, enableIdempotency: true })).toThrow(/redisClient/)
  })

  it('runs at the exact interval boundary and keeps start/stop idempotent', async () => {
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const scheduler = makeScheduler(job, { intervalMs: 100 })
    scheduler.stop()
    scheduler.start()
    scheduler.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(99)
    expect(job.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(job.run).toHaveBeenCalledTimes(1)
    scheduler.stop()
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(job.run).toHaveBeenCalledTimes(1)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(job.run).toHaveBeenCalledTimes(2)
  })

  it('runs exactly once with a distributed lock and retains its correlation context', async () => {
    const redis = redisDouble()
    const lock = new DistributedLock(redis as unknown as ConstructorParameters<typeof DistributedLock>[0])
    const ids: Array<string | undefined> = []
    const job = { run: vi.fn(async () => { ids.push(getActiveCorrelationIds().correlationId) }) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, distributedLock: lock })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(job.run).toHaveBeenCalledTimes(1)
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/i)
    await vi.advanceTimersByTimeAsync(100)
    expect(job.run).toHaveBeenCalledTimes(2)
    expect(ids[1]).not.toBe(ids[0])
    expect(lock.getMetrics()).toMatchObject({ acquisitions: 2, releases: 2 })
  })

  it('guards pending Redis reads against overlapping ticks and exposes drain state', async () => {
    const read = deferred<string | null>()
    const redis = redisDouble()
    redis.get.mockReturnValueOnce(read.promise)
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, redisClient: redis, enableIdempotency: true })
    scheduler.start()
    expect(scheduler.isJobRunning()).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(redis.get).toHaveBeenCalledTimes(1)
    expect(job.run).not.toHaveBeenCalled()
    read.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(job.run).toHaveBeenCalledTimes(1)
    expect(scheduler.isJobRunning()).toBe(false)
  })

  it('guards pending lock acquisition and resets after contention', async () => {
    const acquire = deferred<string | null>()
    const redis = redisDouble()
    const lock = new DistributedLock(redis as unknown as ConstructorParameters<typeof DistributedLock>[0])
    vi.spyOn(lock, 'acquire').mockReturnValueOnce(acquire.promise)
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, distributedLock: lock })
    scheduler.start()
    expect(scheduler.isJobRunning()).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(lock.acquire).toHaveBeenCalledTimes(1)
    acquire.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.isJobRunning()).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(job.run).toHaveBeenCalledTimes(1)
  })

  it('continues draining in-flight work after stop and does not start a duplicate on restart', async () => {
    const pending = deferred<unknown>()
    const job = { run: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true })
    scheduler.start()
    scheduler.stop()
    expect(scheduler.isActive()).toBe(false)
    expect(scheduler.isJobRunning()).toBe(true)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(job.run).toHaveBeenCalledTimes(1)
    pending.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.isJobRunning()).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(job.run).toHaveBeenCalledTimes(2)
  })

  it('allows an immediate job to stop the already-registered timer', async () => {
    const job = { run: vi.fn(async () => { scheduler.stop() }) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(job.run).toHaveBeenCalledTimes(1)
    expect(scheduler.isActive()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the invocation reserved until lock release completes', async () => {
    const released = deferred<boolean>()
    const redis = redisDouble()
    const lock = new DistributedLock(redis as unknown as ConstructorParameters<typeof DistributedLock>[0])
    vi.spyOn(lock, 'release').mockReturnValueOnce(released.promise)
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, distributedLock: lock })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.isJobRunning()).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(job.run).toHaveBeenCalledTimes(1)
    released.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.isJobRunning()).toBe(false)
  })

  it.each([[100, 500], [200_000, 600_000]])('uses the bounded default lock TTL for interval %s', async (intervalMs, ttlMs) => {
    const redis = redisDouble()
    const lock = new DistributedLock(redis as unknown as ConstructorParameters<typeof DistributedLock>[0])
    const acquire = vi.spyOn(lock, 'acquire')
    const scheduler = makeScheduler({ run: vi.fn().mockResolvedValue(undefined) }, { intervalMs, runOnStart: true, distributedLock: lock })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(acquire).toHaveBeenCalledWith('cron:score-snapshot', ttlMs)
  })

  it('treats an existing empty completion marker as present and keeps it intact', async () => {
    const redis = redisDouble()
    await redis.set('cron:score-snapshot:lastRun', '', { PX: 100 })
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, redisClient: redis, enableIdempotency: true })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(job.run).not.toHaveBeenCalled()
    expect(await redis.get('cron:score-snapshot:lastRun')).toBe('')
    expect(redis.set).toHaveBeenCalledTimes(1)
  })

  it.each(['read', 'acquire', 'job', 'write'] as const)('contains %s failures and retries on the next tick', async phase => {
    const redis = redisDouble()
    const lock = new DistributedLock(redis as unknown as ConstructorParameters<typeof DistributedLock>[0])
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const error = new Error('permission denied: credential=private-value')
    const logs: string[] = []
    if (phase === 'read') redis.get.mockRejectedValueOnce(error)
    if (phase === 'acquire') vi.spyOn(lock, 'acquire').mockRejectedValueOnce(error)
    if (phase === 'job') job.run.mockRejectedValueOnce(error)
    if (phase === 'write') {
      const set = redis.set.getMockImplementation()!
      redis.set.mockImplementationOnce(set).mockRejectedValueOnce(error)
    }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, distributedLock: lock, redisClient: redis, enableIdempotency: true, logger: msg => logs.push(msg) })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.isActive()).toBe(true)
    expect(scheduler.isJobRunning()).toBe(false)
    expect(logs.some(msg => msg.includes('Job failed'))).toBe(true)
    expect(logs.join('\n')).not.toContain('private-value')
    expect(await redis.get('cron:score-snapshot:lastRun')).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(job.run).toHaveBeenCalledTimes(phase === 'job' || phase === 'write' ? 2 : 1)
    expect(await redis.get('cron:score-snapshot:lastRun')).not.toBeNull()
    expect(lock.getMetrics().acquisitions).toBe(lock.getMetrics().releases)
  })

  it('contains non-Error rejection and releases the local guard', async () => {
    const job = { run: vi.fn().mockRejectedValueOnce('secret-token').mockResolvedValue(undefined) }
    const log = vi.fn()
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, logger: log })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(job.run).toHaveBeenCalledTimes(2)
    expect(scheduler.isJobRunning()).toBe(false)
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token')
  })

  it('writes a completion marker without a lock and respects exact marker expiry', async () => {
    const redis = redisDouble()
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, redisClient: redis, enableIdempotency: true })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(redis.set).toHaveBeenCalledWith('cron:score-snapshot:lastRun', '2026-01-01T00:00:00.000Z', { PX: 100 })
    scheduler.stop()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(99)
    expect(job.run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(job.run).toHaveBeenCalledTimes(2)
  })

  it('holds the lock and local guard until the completion marker is acknowledged', async () => {
    const acknowledgment = deferred<string | null>()
    const redis = redisDouble()
    const set = redis.set.getMockImplementation()!
    redis.set.mockImplementationOnce(set).mockReturnValueOnce(acknowledgment.promise)
    const lock = new DistributedLock(redis as unknown as ConstructorParameters<typeof DistributedLock>[0])
    const release = vi.spyOn(lock, 'release')
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, distributedLock: lock, redisClient: redis, enableIdempotency: true })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.isJobRunning()).toBe(true)
    expect(release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(job.run).toHaveBeenCalledTimes(1)
    acknowledgment.resolve('OK')
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledTimes(1)
    expect(scheduler.isJobRunning()).toBe(false)
  })

  it('checks completion under the lock even when another replica readied a run earlier', async () => {
    const redis = redisDouble()
    const lockA = new DistributedLock(redis as unknown as ConstructorParameters<typeof DistributedLock>[0])
    const lockB = new DistributedLock(redis as unknown as ConstructorParameters<typeof DistributedLock>[0])
    const delayedAcquire = deferred<string | null>()
    vi.spyOn(lockB, 'acquire').mockReturnValueOnce(delayedAcquire.promise)
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const options = { intervalMs: 100, runOnStart: true, redisClient: redis, enableIdempotency: true }
    const schedulerB = makeScheduler(job, { ...options, distributedLock: lockB })
    schedulerB.start()
    const schedulerA = makeScheduler(job, { ...options, distributedLock: lockA })
    schedulerA.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(job.run).toHaveBeenCalledTimes(1)
    // B acquires after A publishes the marker and releases. It must read
    // the current marker, not rely on a read made before acquiring.
    delayedAcquire.resolve(await lockA.acquire('cron:score-snapshot'))
    await vi.advanceTimersByTimeAsync(0)
    expect(job.run).toHaveBeenCalledTimes(1)
    expect(schedulerB.isJobRunning()).toBe(false)
  })

  it('does not access Redis when idempotency is disabled', async () => {
    const redis = redisDouble()
    const scheduler = makeScheduler({ run: vi.fn().mockResolvedValue(undefined) }, { intervalMs: 100, runOnStart: true, redisClient: redis })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(redis.get).not.toHaveBeenCalled()
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('rejects an unacknowledged marker write as a recoverable failure', async () => {
    const redis = redisDouble()
    redis.set.mockResolvedValueOnce(null)
    const log = vi.fn()
    const job = { run: vi.fn().mockResolvedValue(undefined) }
    const scheduler = makeScheduler(job, { intervalMs: 100, runOnStart: true, redisClient: redis, enableIdempotency: true, logger: log })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Job failed'))
    await vi.advanceTimersByTimeAsync(100)
    expect(job.run).toHaveBeenCalledTimes(2)
  })

  it('forwards the factory idempotency options and custom lock key', async () => {
    const redis = redisDouble()
    await redis.set('custom-job:lastRun', 'sensitive-marker', { PX: 100 })
    const log = vi.fn()
    const job = { run: vi.fn() }
    const scheduler = createScheduler(job, { runOnStart: true, lockKey: 'custom-job', redisClient: redis as IdempotencyRedisClient, enableIdempotency: true, logger: log })
    schedulers.push(scheduler)
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(redis.get).toHaveBeenCalledWith('custom-job:lastRun')
    expect(job.run).not.toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive-marker')
  })

  it.each([1n, { credential: 'private-value' }, (() => { const value: { self?: unknown } = {}; value.self = value; return value })()])('does not serialize arbitrary job results into logs', async result => {
    const logs: string[] = []
    const scheduler = makeScheduler({ run: vi.fn().mockResolvedValue(result) }, { intervalMs: 100, runOnStart: true, logger: msg => logs.push(msg) })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(logs).toContain('Job completed')
    expect(logs.some(msg => msg.includes('Job failed'))).toBe(false)
    expect(logs.join('\n')).not.toContain('private-value')
  })
})

describe('supported cron boundaries', () => {
  it.each([' 0 * * * * ', '0\t*\t*\t*\t*', '0  *  *  *  *'])('normalizes whitespace in %j', expression => {
    expect(parseCronToInterval(expression)).toBe(3_600_000)
  })

  it.each(['* * 1 * *', '0 * * 1 *', '0 0 * * 1', '* * * * 8', '0 25 * * *', '', '0 * * * * *'])('rejects unsupported fields in %j', expression => {
    expect(() => parseCronToInterval(expression)).toThrow()
  })
})
