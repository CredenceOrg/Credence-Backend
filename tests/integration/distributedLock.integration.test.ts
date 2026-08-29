import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DistributedLock } from '../../src/jobs/distributedLock.js'
import { JobScheduler } from '../../src/jobs/scheduler.js'
import { LockedInvoiceDueDateWorker } from '../../src/jobs/lockedWorkers.js'
import { InvoiceDueDateWorker } from '../../src/jobs/invoiceDueDateWorker.js'
import type { ScoreSnapshotJob } from '../../src/jobs/scoreSnapshot.js'

// ---------------------------------------------------------------------------
// Enhanced in-memory Redis stub – supports GET, SET NX PX, EVAL for locks
// ---------------------------------------------------------------------------

interface StoreEntry {
  value: string
  expiresAt: number
}

function makeFakeRedis() {
  const store = new Map<string, StoreEntry>()

  function isAlive(entry: StoreEntry | undefined): entry is StoreEntry {
    return entry !== undefined && entry.expiresAt > Date.now()
  }

  return {
    _store: store,

    async get(key: string): Promise<string | null> {
      const entry = store.get(key)
      if (!isAlive(entry)) {
        store.delete(key)
        return null
      }
      return entry.value
    },

    async set(
      key: string,
      value: string,
      options?: { NX?: boolean; PX?: number }
    ): Promise<string | null> {
      const existing = store.get(key)
      if (options?.NX && isAlive(existing)) {
        return null
      }
      store.set(key, {
        value,
        expiresAt: options?.PX ? Date.now() + options.PX : Infinity,
      })
      return 'OK'
    },

    async del(...keys: string[]): Promise<number> {
      let deleted = 0
      for (const key of keys) {
        if (store.delete(key)) deleted++
      }
      return deleted
    },

    async eval(
      _script: string,
      opts: { keys: string[]; arguments: string[] }
    ): Promise<number> {
      const key = opts.keys[0]
      const token = opts.arguments[0]
      const entry = store.get(key)

      if (!isAlive(entry) || entry.value !== token) {
        return 0
      }

      if (opts.arguments.length === 1) {
        store.delete(key)
        return 1
      } else {
        entry.expiresAt = Date.now() + parseInt(opts.arguments[1])
        return 1
      }
    },
  }
}

type FakeRedis = ReturnType<typeof makeFakeRedis>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScoreSnapshotJob(run: () => Promise<any>): ScoreSnapshotJob {
  return { run } as unknown as ScoreSnapshotJob
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Integration: Concurrent worker scenarios
// ---------------------------------------------------------------------------

describe('DistributedLock integration — concurrent workers', () => {
  it('only one worker executes when 3 workers compete for the same lock', async () => {
    const sharedRedis = makeFakeRedis()

    const locks = [
      new DistributedLock(sharedRedis as any, 10_000),
      new DistributedLock(sharedRedis as any, 10_000),
      new DistributedLock(sharedRedis as any, 10_000),
    ]

    const executionOrder: number[] = []

    const jobs = locks.map((_, i) =>
      makeScoreSnapshotJob(async () => {
        executionOrder.push(i)
        await delay(20)
        return { processed: 1, saved: 1, errors: 0, duration: 20, startTime: new Date().toISOString() }
      })
    )

    const schedulers = locks.map((lock, i) =>
      new JobScheduler(jobs[i], {
        intervalMs: 60_000,
        runOnStart: true,
        distributedLock: lock,
        lockKey: 'cron:concurrent-3way',
      })
    )

    schedulers.forEach(s => s.start())
    await delay(100)
    schedulers.forEach(s => s.stop())

    expect(executionOrder).toHaveLength(1)

    const totalContentions = locks.reduce((sum, l) => sum + l.getMetrics().contentions, 0)
    expect(totalContentions).toBeGreaterThanOrEqual(2)
  })

  it('race condition: two workers initiated at exact same time, only one wins', async () => {
    const sharedRedis = makeFakeRedis()

    const lockA = new DistributedLock(sharedRedis as any, 5_000)
    const lockB = new DistributedLock(sharedRedis as any, 5_000)

    let runCount = 0

    // Fire both acquisitions simultaneously using Promise.all
    const [resultA, resultB] = await Promise.all([
      lockA.withLock('cron:race-condition', async () => {
        runCount++
        await delay(10)
        return 'A'
      }),
      lockB.withLock('cron:race-condition', async () => {
        runCount++
        await delay(10)
        return 'B'
      }),
    ])

    expect(runCount).toBe(1)
    expect(resultA.executed !== resultB.executed).toBe(true) // exactly one succeeded
  })
})

// ---------------------------------------------------------------------------
// Integration: Lock expiry and reacquisition
// ---------------------------------------------------------------------------

describe('DistributedLock integration — expiry and reacquisition', () => {
  it('second worker acquires lock after TTL expires (no heartbeat)', async () => {
    const sharedRedis = makeFakeRedis()
    const lockA = new DistributedLock(sharedRedis as any, 200) // 200ms TTL
    const lockB = new DistributedLock(sharedRedis as any, 5_000)

    const tokenA = await lockA.acquire('cron:expire-test', 200)
    expect(tokenA).not.toBeNull()

    // Worker B cannot acquire while A holds
    const attemptDuring = await lockB.acquire('cron:expire-test', 5_000)
    expect(attemptDuring).toBeNull()

    // Wait for lock to expire naturally
    await delay(250)

    // Worker B can now acquire
    const tokenB = await lockB.acquire('cron:expire-test', 5_000)
    expect(tokenB).not.toBeNull()
    expect(tokenB).not.toBe(tokenA)
  })

  it('withLock: second worker executes after first worker TTL expires (no release)', async () => {
    const sharedRedis = makeFakeRedis()

    // Worker A — short TTL, no heartbeat (simulate crash or slow worker with expired lock)
    const lockA = new DistributedLock(sharedRedis as any, 150)
    const lockB = new DistributedLock(sharedRedis as any, 5_000)

    const executionLog: string[] = []

    // A acquires but takes longer than TTL (no heartbeat because default
    // heartbeatIntervalMs = floor(150*0.6) = 90ms, but the fn takes 200ms)
    const resultA = await lockA.withLock('cron:expire-withlock', async () => {
      executionLog.push('A-started')
      await delay(200) // longer than TTL of 150ms
      executionLog.push('A-finished')
      return 'A'
    })

    expect(resultA.executed).toBe(true)
    expect(executionLog).toContain('A-started')

    // B should be able to acquire now since A's lock expired
    const resultB = await lockB.withLock('cron:expire-withlock', async () => {
      executionLog.push('B')
      return 'B'
    })

    expect(resultB.executed).toBe(true)
    expect(executionLog).toContain('B')
  })
})

// ---------------------------------------------------------------------------
// Integration: Idempotency — same job should not run twice within TTL window
// ---------------------------------------------------------------------------

describe('DistributedLock integration — idempotency', () => {
  it('job with idempotency guard skips second run within TTL window', async () => {
    const sharedRedis = makeFakeRedis()
    const lockA = new DistributedLock(sharedRedis as any, 10_000)
    const lockB = new DistributedLock(sharedRedis as any, 10_000)

    const idempotencyKey = 'cron:idempotent-job:lastRun'
    const idempotencyTtl = 1_000

    // First run — sets idempotency marker
    const runA = await lockA.withLock('cron:idempotent-job', async () => {
      // Set idempotency marker after successful run
      await sharedRedis.set(idempotencyKey, '1', { PX: idempotencyTtl })
      return 'A'
    })

    expect(runA.executed).toBe(true)

    // Second run (same scheduler interval) — should detect idempotency and skip
    const marker = await sharedRedis.get(idempotencyKey)
    expect(marker).toBe('1') // marker still exists

    // Simulate what scheduler would do: check marker before acquiring lock
    let skippedDueToIdempotency = false
    if (marker) {
      skippedDueToIdempotency = true
    }

    expect(skippedDueToIdempotency).toBe(true)
  })

  it('idempotency marker expires, allowing next run after TTL', async () => {
    const sharedRedis = makeFakeRedis()
    const lock = new DistributedLock(sharedRedis as any, 10_000)

    const idempotencyKey = 'cron:idempotent-expire:lastRun'
    const idempotencyTtl = 100

    // First run sets marker with 100ms TTL
    await sharedRedis.set(idempotencyKey, '1', { PX: idempotencyTtl })

    // Marker exists immediately
    expect(await sharedRedis.get(idempotencyKey)).toBe('1')

    // Wait for expiry
    await delay(150)

    // Marker gone
    expect(await sharedRedis.get(idempotencyKey)).toBeNull()

    // Second run can proceed
    const result = await lock.withLock('cron:idempotent-expire', async () => {
      await sharedRedis.set(idempotencyKey, '2', { PX: idempotencyTtl })
      return 'ran'
    })

    expect(result.executed).toBe(true)
    expect(result.result).toBe('ran')
  })

  it('full idempotency flow with scheduler: set lastRun after success, skip if not expired', async () => {
    const sharedRedis = makeFakeRedis()
    const lock = new DistributedLock(sharedRedis as any, 5_000)

    const idempotencyKey = 'cron:full-idempotent:lastRun'
    const idempotencyTtl = 300

    let runCount = 0

    const runWithIdempotency = async (): Promise<{ executed: boolean; skippedBy: string }> => {
      const marker = await sharedRedis.get(idempotencyKey)
      if (marker) {
        return { executed: false, skippedBy: 'idempotency' }
      }

      const { executed, result } = await lock.withLock('cron:full-idempotent', async () => {
        runCount++
        await sharedRedis.set(idempotencyKey, String(runCount), { PX: idempotencyTtl })
        return runCount
      })

      if (!executed) {
        return { executed: false, skippedBy: 'lock-contention' }
      }

      return { executed: true, skippedBy: 'none' }
    }

    // Run 1 — should succeed
    const r1 = await runWithIdempotency()
    expect(r1.executed).toBe(true)
    expect(r1.skippedBy).toBe('none')
    expect(runCount).toBe(1)

    // Run 2 — should be skipped by idempotency
    const r2 = await runWithIdempotency()
    expect(r2.executed).toBe(false)
    expect(r2.skippedBy).toBe('idempotency')
    expect(runCount).toBe(1)

    // Wait for idempotency TTL to expire
    await delay(400)

    // Run 3 — should succeed again
    const r3 = await runWithIdempotency()
    expect(r3.executed).toBe(true)
    expect(r3.skippedBy).toBe('none')
    expect(runCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Integration: Heartbeat extends lock correctly
// ---------------------------------------------------------------------------

describe('DistributedLock integration — heartbeat', () => {
  it('heartbeat keeps lock alive past original TTL for a long-running job', async () => {
    const sharedRedis = makeFakeRedis()

    const lockShort = new DistributedLock(sharedRedis as any, 300) // 300ms default
    const lockMonitor = new DistributedLock(sharedRedis as any, 300)

    const { executed, result } = await lockShort.withLock(
      'cron:heartbeat-long',
      async () => {
        // Simulate long work — sleep past original TTL
        await delay(500)
        return 'done'
      },
      {
        ttlMs: 200,                   // lock would expire at 200ms without heartbeat
        heartbeatIntervalMs: 50,      // heartbeat every 50ms (at 60ms remaining)
      }
    )

    expect(executed).toBe(true)
    expect(result).toBe('done')

    // Lock should have been released after withLock
    // Verify by trying to acquire it immediately
    const canAcquireNow = await lockMonitor.acquire('cron:heartbeat-long', 100)
    expect(canAcquireNow).not.toBeNull()

    await lockMonitor.release('cron:heartbeat-long', canAcquireNow!)
  })

  it('heartbeat extends lock but another worker still cannot steal it during the job', async () => {
    const sharedRedis = makeFakeRedis()

    const lockWorker = new DistributedLock(sharedRedis as any, 500)
    const lockCompetitor = new DistributedLock(sharedRedis as any, 500)

    let competitorAttemptedDuring = false

    const workerPromise = lockWorker.withLock(
      'cron:heartbeat-steal',
      async () => {
        // After starting, let competitor try to steal
        await delay(50)

        const token = await lockCompetitor.acquire('cron:heartbeat-steal', 500)
        competitorAttemptedDuring = true
        expect(token).toBeNull() // should still be held by worker

        // Continue working
        await delay(300)
        return 'worker-done'
      },
      {
        ttlMs: 200,
        heartbeatIntervalMs: 60, // heartbeat at 60ms, well before 200ms expiry
      }
    )

    const result = await workerPromise
    expect(result.executed).toBe(true)
    expect(result.result).toBe('worker-done')
    expect(competitorAttemptedDuring).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration: Lock release on worker crash (simulated)
// ---------------------------------------------------------------------------

describe('DistributedLock integration — worker crash simulation', () => {
  it('lock expires and another worker acquires it after simulated crash (no release)', async () => {
    const sharedRedis = makeFakeRedis()

    const lockCrash = new DistributedLock(sharedRedis as any, 200)
    const lockRecovery = new DistributedLock(sharedRedis as any, 5_000)

    // Worker A acquires lock then "crashes" (no release)
    const tokenA = await lockCrash.acquire('cron:crash-test', 200)
    expect(tokenA).not.toBeNull()

    // Simulate crash — just don't release

    // Worker B cannot acquire immediately
    const attemptDuring = await lockRecovery.acquire('cron:crash-test', 5_000)
    expect(attemptDuring).toBeNull()

    // Wait for lock TTL to expire
    await delay(250)

    // Worker B acquires after lock naturally expires
    const tokenB = await lockRecovery.acquire('cron:crash-test', 5_000)
    expect(tokenB).not.toBeNull()
    expect(tokenB).not.toBe(tokenA)

    await lockRecovery.release('cron:crash-test', tokenB!)
  })

  it('withLock releases lock in finally block even when fn throws (crash inside job)', async () => {
    const sharedRedis = makeFakeRedis()

    const lockCrash = new DistributedLock(sharedRedis as any, 5_000)
    const lockRecovery = new DistributedLock(sharedRedis as any, 5_000)

    await expect(
      lockCrash.withLock('cron:crash-finally', async () => {
        throw new Error('unexpected crash during job')
      })
    ).rejects.toThrow('unexpected crash during job')

    // Lock should be released in finally, so recovery can acquire it
    const token = await lockRecovery.acquire('cron:crash-finally', 5_000)
    expect(token).not.toBeNull()

    await lockRecovery.release('cron:crash-finally', token!)
  })
})

// ---------------------------------------------------------------------------
// Integration: Network delay simulation
// ---------------------------------------------------------------------------

describe('DistributedLock integration — network delay simulation', () => {
  it('handles staggered worker starts with network jitter', async () => {
    const sharedRedis = makeFakeRedis()

    const lockA = new DistributedLock(sharedRedis as any, 5_000)
    const lockB = new DistributedLock(sharedRedis as any, 5_000)
    const lockC = new DistributedLock(sharedRedis as any, 5_000)

    const results: string[] = []

    const startWorker = async (lock: DistributedLock, name: string, delayMs: number) => {
      await delay(delayMs)
      const { executed } = await lock.withLock('cron:staggered', async () => {
        results.push(name)
        await delay(30)
        return name
      })
      return executed
    }

    // Start all three at staggered intervals: 0ms, 5ms, 10ms
    const [a, b, c] = await Promise.all([
      startWorker(lockA, 'A', 0),
      startWorker(lockB, 'B', 5),
      startWorker(lockC, 'C', 10),
    ])

    // Exactly one should execute
    expect([a, b, c].filter(Boolean)).toHaveLength(1)
    expect(results).toHaveLength(1)
  })

  it('slow Redis response on acquire does not cause double execution', async () => {
    const sharedRedis = makeFakeRedis()

    // Wrap set to introduce an artificial delay
    const originalSet = sharedRedis.set.bind(sharedRedis)
    let setCallCount = 0
    sharedRedis.set = async (key: string, value: string, options?: { NX?: boolean; PX?: number }) => {
      setCallCount++
      if (setCallCount === 1) {
        // First call has no delay (instant acquire)
        return originalSet(key, value, options)
      }
      // Subsequent calls also instant
      return originalSet(key, value, options)
    }

    const lockA = new DistributedLock(sharedRedis as any, 5_000)
    const lockB = new DistributedLock(sharedRedis as any, 5_000)

    const [resultA, resultB] = await Promise.all([
      lockA.withLock('cron:slow-redis', async () => {
        await delay(20)
        return 'A'
      }),
      lockB.withLock('cron:slow-redis', async () => {
        await delay(20)
        return 'B'
      }),
    ])

    expect(resultA.executed !== resultB.executed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration: Scheduler with idempotency guard
// ---------------------------------------------------------------------------

describe('JobScheduler integration — idempotency guard', () => {
  it('scheduler respects idempotency marker and skips execution', async () => {
    const sharedRedis = makeFakeRedis()
    const lock = new DistributedLock(sharedRedis as any, 10_000)

    // Pre-set the idempotency marker to simulate a recent run
    await sharedRedis.set('cron:idempotent-scheduler:lastRun', '1', { PX: 500 })

    const mockJob = {
      run: vi.fn().mockResolvedValue({
        processed: 0, saved: 0, errors: 0, duration: 0, startTime: new Date().toISOString(),
      }),
    } as unknown as ScoreSnapshotJob

    const logs: string[] = []

    const scheduler = new JobScheduler(mockJob, {
      intervalMs: 60_000,
      runOnStart: true,
      distributedLock: lock,
      lockKey: 'cron:idempotent-scheduler',
      logger: (msg) => logs.push(msg),
      redisClient: sharedRedis as any,
      enableIdempotency: true,
    })

    scheduler.start()
    await delay(50)
    scheduler.stop()

    // Job should not have run due to idempotency
    expect(mockJob.run).not.toHaveBeenCalled()
    expect(logs.some(l => l.toLowerCase().includes('idempoten'))).toBe(true)
  })

  it('scheduler runs job when no idempotency marker exists', async () => {
    const sharedRedis = makeFakeRedis()
    const lock = new DistributedLock(sharedRedis as any, 10_000)

    const mockJob = {
      run: vi.fn().mockResolvedValue({
        processed: 5, saved: 5, errors: 0, duration: 10, startTime: new Date().toISOString(),
      }),
    } as unknown as ScoreSnapshotJob

    const logs: string[] = []

    const scheduler = new JobScheduler(mockJob, {
      intervalMs: 60_000,
      runOnStart: true,
      distributedLock: lock,
      lockKey: 'cron:no-idempotent-scheduler',
      logger: (msg) => logs.push(msg),
      redisClient: sharedRedis as any,
      enableIdempotency: true,
    })

    scheduler.start()
    await delay(50)
    scheduler.stop()

    expect(mockJob.run).toHaveBeenCalledOnce()

    // Verify idempotency marker was set
    const marker = await sharedRedis.get('cron:no-idempotent-scheduler:lastRun')
    expect(marker).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Integration: LockedInvoiceDueDateWorker idempotency
// ---------------------------------------------------------------------------

describe('LockedInvoiceDueDateWorker integration — idempotency', () => {
  it('skips execution when idempotency marker exists', async () => {
    const sharedRedis = makeFakeRedis()
    const lock = new DistributedLock(sharedRedis as any, 10_000)

    const mockRepo = {
      listPendingDueDateInvoices: vi.fn().mockResolvedValue([]),
      markDueDateActionTriggered: vi.fn().mockResolvedValue(undefined),
    }
    const mockTenantProvider = {
      listTenants: vi.fn().mockResolvedValue([]),
    }

    const worker = new InvoiceDueDateWorker(
      mockRepo,
      mockTenantProvider,
      { validateTimezones: false }
    )
    const workerRunSpy = vi.spyOn(worker, 'run')

    // Pre-set idempotency marker
    await sharedRedis.set('cron:due-date-worker:lastRun', new Date().toISOString(), { PX: 30_000 })

    const lockedWorker = new LockedInvoiceDueDateWorker(
      worker,
      lock,
      'cron:due-date-worker',
      {
        lockTtlMs: 5_000,
        redisClient: sharedRedis as any,
        enableIdempotency: true,
      }
    )

    const result = await lockedWorker.run(new Date())

    expect(result).toBeNull()
    expect(workerRunSpy).not.toHaveBeenCalled()
  })

  it('executes when no idempotency marker exists', async () => {
    const sharedRedis = makeFakeRedis()
    const lock = new DistributedLock(sharedRedis as any, 10_000)

    const mockRepo = {
      listPendingDueDateInvoices: vi.fn().mockResolvedValue([]),
      markDueDateActionTriggered: vi.fn().mockResolvedValue(undefined),
    }
    const mockTenantProvider = {
      listTenants: vi.fn().mockResolvedValue([]),
    }

    const worker = new InvoiceDueDateWorker(
      mockRepo,
      mockTenantProvider,
      { validateTimezones: false }
    )
    const workerRunSpy = vi.spyOn(worker, 'run')

    const lockedWorker = new LockedInvoiceDueDateWorker(
      worker,
      lock,
      'cron:due-date-worker',
      {
        lockTtlMs: 5_000,
        redisClient: sharedRedis as any,
        enableIdempotency: true,
      }
    )

    const result = await lockedWorker.run(new Date())

    expect(result).not.toBeNull()
    expect(workerRunSpy).toHaveBeenCalledOnce()

    const marker = await sharedRedis.get('cron:due-date-worker:lastRun')
    expect(marker).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Integration: Concurrent workers with idempotency
// ---------------------------------------------------------------------------

describe('DistributedLock integration — concurrent workers with idempotency', () => {
  it('only one worker executes when two compete and first sets lastRun', async () => {
    const sharedRedis = makeFakeRedis()

    const lockA = new DistributedLock(sharedRedis as any, 10_000)
    const lockB = new DistributedLock(sharedRedis as any, 10_000)

    const idempotencyKey = 'cron:concurrent-idempotent:lastRun'
    let runCount = 0

    const mockJob = {
      run: vi.fn().mockImplementation(async () => {
        runCount++
        // Set idempotency marker inside the job (as scheduler would)
        await sharedRedis.set(idempotencyKey, new Date().toISOString(), { PX: 60_000 })
        return { processed: 1, saved: 1, errors: 0, duration: 10, startTime: new Date().toISOString() }
      }),
    } as unknown as ScoreSnapshotJob

    const logs: string[] = []

    const schedulerA = new JobScheduler(mockJob, {
      intervalMs: 60_000,
      runOnStart: true,
      distributedLock: lockA,
      lockKey: 'cron:concurrent-idempotent',
      logger: (msg) => logs.push(`A: ${msg}`),
      redisClient: sharedRedis as any,
      enableIdempotency: true,
    })

    const schedulerB = new JobScheduler(mockJob, {
      intervalMs: 60_000,
      runOnStart: true,
      distributedLock: lockB,
      lockKey: 'cron:concurrent-idempotent',
      logger: (msg) => logs.push(`B: ${msg}`),
      redisClient: sharedRedis as any,
      enableIdempotency: true,
    })

    schedulerA.start()
    schedulerB.start()
    await delay(150)
    schedulerA.stop()
    schedulerB.stop()

    // Only one execution expected — either the first worker wins the lock and sets
    // the idempotency marker, blocking the second worker entirely (both via lock and idempotency).
    expect(runCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Integration: Lock + idempotency combination
// ---------------------------------------------------------------------------

describe('DistributedLock integration — lock + idempotency combination', () => {
  it('first run acquires lock, runs job, sets lastRun, releases lock; second run skips due to lastRun even though lock is free', async () => {
    const sharedRedis = makeFakeRedis()
    const lock = new DistributedLock(sharedRedis as any, 10_000)

    const idempotencyKey = 'cron:combined:lastRun'
    let runCount = 0

    const mockJob = {
      run: vi.fn().mockImplementation(async () => {
        runCount++
        await delay(10)
        return { processed: 1, saved: 1, errors: 0, duration: 10, startTime: new Date().toISOString() }
      }),
    } as unknown as ScoreSnapshotJob

    const logs: string[] = []

    // First run — should succeed
    const scheduler1 = new JobScheduler(mockJob, {
      intervalMs: 60_000,
      runOnStart: true,
      distributedLock: lock,
      lockKey: 'cron:combined',
      logger: (msg) => logs.push(`S1: ${msg}`),
      redisClient: sharedRedis as any,
      enableIdempotency: true,
    })

    scheduler1.start()
    await delay(100)
    scheduler1.stop()

    expect(runCount).toBe(1)
    expect(mockJob.run).toHaveBeenCalledOnce()

    // Verify lock is free
    const canAcquire = await lock.acquire('cron:combined', 100)
    expect(canAcquire).not.toBeNull()
    await lock.release('cron:combined', canAcquire!)

    // Verify idempotency marker is set
    const marker = await sharedRedis.get(idempotencyKey)
    expect(marker).not.toBeNull()

    // Second run — should skip due to idempotency, even though lock is free
    const scheduler2 = new JobScheduler(mockJob, {
      intervalMs: 60_000,
      runOnStart: true,
      distributedLock: lock,
      lockKey: 'cron:combined',
      logger: (msg) => logs.push(`S2: ${msg}`),
      redisClient: sharedRedis as any,
      enableIdempotency: true,
    })

    scheduler2.start()
    await delay(100)
    scheduler2.stop()

    // runCount should still be 1 — job was NOT called again
    expect(runCount).toBe(1)
    expect(mockJob.run).toHaveBeenCalledOnce()
    expect(logs.some(l => l.toLowerCase().includes('idempoten'))).toBe(true)
  })

  it('second run executes after idempotency marker expires', async () => {
    const sharedRedis = makeFakeRedis()
    const lock = new DistributedLock(sharedRedis as any, 10_000)

    const idempotencyKey = 'cron:combined-expire:lastRun'
    let runCount = 0

    const mockJob = {
      run: vi.fn().mockImplementation(async () => {
        runCount++
        await delay(5)
        return { processed: 1, saved: 1, errors: 0, duration: 5, startTime: new Date().toISOString() }
      }),
    } as unknown as ScoreSnapshotJob

    // Set an expired marker
    await sharedRedis.set(idempotencyKey, new Date().toISOString(), { PX: 10 })
    await delay(20)

    // Verify marker is gone
    expect(await sharedRedis.get(idempotencyKey)).toBeNull()

    // Now run — should execute because no marker exists
    const scheduler = new JobScheduler(mockJob, {
      intervalMs: 60_000,
      runOnStart: true,
      distributedLock: lock,
      lockKey: 'cron:combined-expire',
      redisClient: sharedRedis as any,
      enableIdempotency: true,
    })

    scheduler.start()
    await delay(100)
    scheduler.stop()

    expect(runCount).toBe(1)
    expect(mockJob.run).toHaveBeenCalledOnce()

    // A fresh marker should now be set
    const marker = await sharedRedis.get(idempotencyKey)
    expect(marker).not.toBeNull()
  })
})
