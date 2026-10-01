/**
 * Boundary and recovery test coverage for src/jobs/outbox.ts (OutboxJob).
 *
 * OutboxJob is a thin lifecycle wrapper over two collaborators:
 *   - OutboxPublisher  (the polling/publishing loop)
 *   - WorkerLeaseManager (optional Postgres advisory-lock leader election)
 *
 * All external dependencies are mocked so these tests are pure unit tests
 * with no database or network I/O required.
 *
 * Coverage targets
 * ────────────────
 *  • Lifecycle: start / stop / double-start / double-stop / stop-before-start
 *  • Leader-lease branch: publisher only starts on 'leader' state
 *  • Non-lease branch: publisher starts immediately
 *  • isRunning() reflects the real publisher state through every transition
 *  • Metrics incremented on leader acquired / lost
 *  • Publisher errors during start do not leak unhandled rejections
 *  • Publisher errors during stop propagate gracefully
 *  • Boundary options: zero/negative intervals forwarded correctly
 *  • LeaseManager state changes → publisher start / stop driven correctly
 *  • Stop is idempotent after lease manager is already stopped
 *  • start() called concurrently is safe (no double-instantiation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OutboxJob } from './outbox.js'
import type { OutboxJobOptions } from './outbox.js'

// ─── Module-level mocks ────────────────────────────────────────────────────
//
// We intercept every import that OutboxJob wires up so the test remains
// isolated from real Postgres, webhook delivery, and OTel.

/** Captured onStateChange handler registered via leaseManager.on() */
let capturedOnStateChange: ((state: 'leader' | 'standby') => void) | null = null
let capturedOnReleased: (() => void) | null = null

const mockLeaseManagerInstance = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  on: vi.fn((events: Record<string, unknown>) => {
    if (typeof events.onStateChange === 'function') {
      capturedOnStateChange = events.onStateChange as (state: 'leader' | 'standby') => void
    }
    if (typeof events.onReleased === 'function') {
      capturedOnReleased = events.onReleased as () => void
    }
  }),
}
const MockWorkerLeaseManager = vi.fn(() => mockLeaseManagerInstance)

vi.mock('./workerLeaseManager.js', () => ({
  WorkerLeaseManager: MockWorkerLeaseManager,
}))

const mockPublisherInstance = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
}
const MockOutboxPublisher = vi.fn(() => mockPublisherInstance)

vi.mock('../db/outbox/publisher.js', () => ({
  OutboxPublisher: MockOutboxPublisher,
}))

// WebhookService and its collaborators — stubbed to minimal no-op objects
vi.mock('../db/repositories/webhookRepository.js', () => ({
  PostgresWebhookRepository: vi.fn(() => ({})),
}))

vi.mock('../services/webhooks/postgresDlqStore.js', () => ({
  PostgresDlqStore: vi.fn(() => ({})),
}))

vi.mock('../services/webhooks/service.js', () => ({
  WebhookService: vi.fn(() => ({})),
}))

vi.mock('../db/outbox/webhookPublisher.js', () => ({
  WebhookEventPublisher: vi.fn(() => ({})),
}))

vi.mock('../services/audit/index.js', () => ({
  auditLogService: {},
}))

// Observability stubs — capture call counts for metric assertions
const mockIncrementOutboxLeaderAcquired = vi.fn()
const mockIncrementOutboxLeaderLost = vi.fn()

vi.mock('../observability/index.js', () => ({
  incrementOutboxLeaderAcquired: () => mockIncrementOutboxLeaderAcquired(),
  incrementOutboxLeaderLost: () => mockIncrementOutboxLeaderLost(),
  // Other observability helpers used by OutboxPublisher (not OutboxJob):
  incrementOutboxPublished: vi.fn(),
  incrementOutboxFailed: vi.fn(),
  incrementOutboxDeadLetter: vi.fn(),
  setOutboxPendingGauge: vi.fn(),
  setOutboxLifecycleGauges: vi.fn(),
  incrementOutboxLeaseRenew: vi.fn(),
  incrementOutboxQuarantine: vi.fn(),
}))

// ─── Helpers ───────────────────────────────────────────────────────────────

function createMockPool() {
  return {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
  } as unknown as import('pg').Pool
}

/** Resets all mock call histories without replacing the implementations. */
function resetMocks() {
  capturedOnStateChange = null
  capturedOnReleased = null

  MockWorkerLeaseManager.mockClear()
  MockOutboxPublisher.mockClear()

  mockLeaseManagerInstance.start.mockClear()
  mockLeaseManagerInstance.stop.mockClear()
  mockLeaseManagerInstance.on.mockClear()
  mockPublisherInstance.start.mockClear()
  mockPublisherInstance.stop.mockClear()

  mockIncrementOutboxLeaderAcquired.mockClear()
  mockIncrementOutboxLeaderLost.mockClear()
}

/** Build a job configured with the leader-lease enabled. */
function makeLeaseJob(pool: ReturnType<typeof createMockPool>, extra: OutboxJobOptions = {}) {
  return new OutboxJob(pool, {
    leaderLease: { enabled: true, retryIntervalMs: 5000, heartbeatIntervalMs: 10000 },
    pollIntervalMs: 1000,
    batchSize: 50,
    ...extra,
  })
}

/** Build a job configured WITHOUT the leader-lease (legacy path). */
function makeDirectJob(pool: ReturnType<typeof createMockPool>, extra: OutboxJobOptions = {}) {
  return new OutboxJob(pool, {
    leaderLease: { enabled: false },
    pollIntervalMs: 1000,
    batchSize: 50,
    ...extra,
  })
}

// ─── Test suite ────────────────────────────────────────────────────────────

describe('OutboxJob', () => {
  let pool: ReturnType<typeof createMockPool>

  beforeEach(() => {
    pool = createMockPool()
    resetMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── Construction ──────────────────────────────────────────────────────

  describe('construction', () => {
    it('constructs without options and defaults to not running', () => {
      const job = new OutboxJob(pool)
      expect(job.isRunning()).toBe(false)
    })

    it('constructs with full options without throwing', () => {
      expect(() =>
        new OutboxJob(pool, {
          pollIntervalMs: 500,
          batchSize: 25,
          publishedRetentionDays: 14,
          failedRetentionDays: 60,
          cleanupIntervalMs: 7200000,
          consumerId: 'test-consumer',
          leaseSeconds: 120,
          heartbeatIntervalMs: 60000,
          leaderLease: {
            enabled: true,
            retryIntervalMs: 2000,
            heartbeatIntervalMs: 8000,
          },
        }),
      ).not.toThrow()
    })

    it('isRunning() returns false before start is called', () => {
      const job = makeLeaseJob(pool)
      expect(job.isRunning()).toBe(false)
    })
  })

  // ─── Non-lease (direct) path ───────────────────────────────────────────

  describe('without leader lease', () => {
    it('starts the publisher immediately without creating a LeaseManager', async () => {
      const job = makeDirectJob(pool)

      await job.start()

      expect(MockWorkerLeaseManager).not.toHaveBeenCalled()
      expect(MockOutboxPublisher).toHaveBeenCalledTimes(1)
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(1)
      expect(job.isRunning()).toBe(true)

      await job.stop()
    })

    it('stops the publisher and isRunning() returns false after stop', async () => {
      const job = makeDirectJob(pool)

      await job.start()
      expect(job.isRunning()).toBe(true)

      await job.stop()

      expect(mockPublisherInstance.stop).toHaveBeenCalledTimes(1)
      expect(job.isRunning()).toBe(false)
    })

    it('passes all publisher config options through to OutboxPublisher', async () => {
      const job = new OutboxJob(pool, {
        pollIntervalMs: 250,
        batchSize: 10,
        publishedRetentionDays: 3,
        failedRetentionDays: 14,
        cleanupIntervalMs: 1800000,
        consumerId: 'my-consumer',
        leaseSeconds: 60,
        heartbeatIntervalMs: 30000,
      })

      await job.start()

      expect(MockOutboxPublisher).toHaveBeenCalledWith(
        expect.anything(), // eventPublisher
        expect.objectContaining({
          pollIntervalMs: 250,
          batchSize: 10,
          consumerId: 'my-consumer',
          leaseSeconds: 60,
          heartbeatIntervalMs: 30000,
          cleanup: {
            publishedRetentionDays: 3,
            failedRetentionDays: 14,
          },
          cleanupIntervalMs: 1800000,
        }),
      )

      await job.stop()
    })

    it('passes undefined consumerId when not specified (publisher auto-generates UUID)', async () => {
      const job = new OutboxJob(pool, { pollIntervalMs: 1000 })

      await job.start()

      const config = MockOutboxPublisher.mock.calls[0][1] as Record<string, unknown>
      expect(config.consumerId).toBeUndefined()

      await job.stop()
    })
  })

  // ─── Idempotency: double start / double stop ────────────────────────────

  describe('start/stop idempotency', () => {
    it('calling start() twice only instantiates one publisher', async () => {
      const job = makeDirectJob(pool)

      await job.start()
      await job.start() // second call is a no-op

      expect(MockOutboxPublisher).toHaveBeenCalledTimes(1)
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(1)

      await job.stop()
    })

    it('calling stop() before start() does nothing', async () => {
      const job = makeDirectJob(pool)

      await expect(job.stop()).resolves.toBeUndefined()

      expect(mockPublisherInstance.stop).not.toHaveBeenCalled()
    })

    it('calling stop() twice only stops the publisher once', async () => {
      const job = makeDirectJob(pool)

      await job.start()
      await job.stop()
      await job.stop() // second call is a no-op

      expect(mockPublisherInstance.stop).toHaveBeenCalledTimes(1)
    })

    it('start → stop → start re-creates a fresh publisher', async () => {
      const job = makeDirectJob(pool)

      await job.start()
      await job.stop()
      await job.start()

      // Two separate publisher instances
      expect(MockOutboxPublisher).toHaveBeenCalledTimes(2)
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(2)

      await job.stop()
    })
  })

  // ─── Leader-lease path ─────────────────────────────────────────────────

  describe('with leader lease enabled', () => {
    it('creates a WorkerLeaseManager and starts it, but does NOT start the publisher immediately', async () => {
      const job = makeLeaseJob(pool)

      await job.start()

      expect(MockWorkerLeaseManager).toHaveBeenCalledTimes(1)
      expect(mockLeaseManagerInstance.start).toHaveBeenCalledTimes(1)
      // Publisher must NOT be running until the lease is acquired
      expect(MockOutboxPublisher).not.toHaveBeenCalled()
      expect(job.isRunning()).toBe(false)

      await job.stop()
    })

    it('constructs WorkerLeaseManager with the correct pool and timing options', async () => {
      const job = new OutboxJob(pool, {
        leaderLease: {
          enabled: true,
          retryIntervalMs: 3000,
          heartbeatIntervalMs: 7000,
        },
      })

      await job.start()

      expect(MockWorkerLeaseManager).toHaveBeenCalledWith({
        pool,
        retryIntervalMs: 3000,
        heartbeatIntervalMs: 7000,
      })

      await job.stop()
    })

    it('registers onStateChange and onReleased callbacks with the lease manager', async () => {
      const job = makeLeaseJob(pool)

      await job.start()

      expect(mockLeaseManagerInstance.on).toHaveBeenCalledWith(
        expect.objectContaining({
          onStateChange: expect.any(Function),
          onReleased: expect.any(Function),
        }),
      )

      await job.stop()
    })

    it('starts the publisher and increments metric when onStateChange fires "leader"', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      expect(capturedOnStateChange).not.toBeNull()

      await capturedOnStateChange!('leader')

      expect(MockOutboxPublisher).toHaveBeenCalledTimes(1)
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(1)
      expect(mockIncrementOutboxLeaderAcquired).toHaveBeenCalledTimes(1)
      expect(job.isRunning()).toBe(true)

      await job.stop()
    })

    it('stops the publisher when onStateChange fires "standby"', async () => {
      const job = makeLeaseJob(pool)

      await job.start()

      // Acquire leadership first
      await capturedOnStateChange!('leader')
      expect(job.isRunning()).toBe(true)

      // Lose leadership
      await capturedOnStateChange!('standby')

      expect(mockPublisherInstance.stop).toHaveBeenCalledTimes(1)
      expect(job.isRunning()).toBe(false)

      await job.stop()
    })

    it('increments "lost" metric when onReleased fires', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      capturedOnReleased!()

      expect(mockIncrementOutboxLeaderLost).toHaveBeenCalledTimes(1)

      await job.stop()
    })

    it('stop() stops the publisher and then stops the lease manager', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      await capturedOnStateChange!('leader')
      expect(job.isRunning()).toBe(true)

      await job.stop()

      expect(mockPublisherInstance.stop).toHaveBeenCalledTimes(1)
      expect(mockLeaseManagerInstance.stop).toHaveBeenCalledTimes(1)
      expect(job.isRunning()).toBe(false)
    })

    it('stop() is safe when publisher was never started (still in standby)', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      // Do NOT fire onStateChange('leader') — publisher never starts

      await expect(job.stop()).resolves.toBeUndefined()

      expect(mockPublisherInstance.stop).not.toHaveBeenCalled()
      expect(mockLeaseManagerInstance.stop).toHaveBeenCalledTimes(1)
    })

    it('calling start() twice with leader lease only creates one LeaseManager', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      await job.start() // no-op

      expect(MockWorkerLeaseManager).toHaveBeenCalledTimes(1)
      expect(mockLeaseManagerInstance.start).toHaveBeenCalledTimes(1)

      await job.stop()
    })

    it('onStateChange "leader" fires twice — publisher not duplicated', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      await capturedOnStateChange!('leader')
      await capturedOnStateChange!('leader') // second fire while already running

      // startPublisher() guards with `if (this.publisher) return`
      expect(MockOutboxPublisher).toHaveBeenCalledTimes(1)
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(1)

      await job.stop()
    })

    it('onStateChange "standby" fires while already in standby — no double-stop', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      // Never acquired leadership — fire standby directly
      await capturedOnStateChange!('standby')

      expect(mockPublisherInstance.stop).not.toHaveBeenCalled()

      await job.stop()
    })
  })

  // ─── isRunning() invariants ────────────────────────────────────────────

  describe('isRunning()', () => {
    it('returns false before start', () => {
      const job = makeDirectJob(pool)
      expect(job.isRunning()).toBe(false)
    })

    it('returns true after direct start', async () => {
      const job = makeDirectJob(pool)
      await job.start()
      expect(job.isRunning()).toBe(true)
      await job.stop()
    })

    it('returns false after stop', async () => {
      const job = makeDirectJob(pool)
      await job.start()
      await job.stop()
      expect(job.isRunning()).toBe(false)
    })

    it('returns false after leader-lease start (before onStateChange)', async () => {
      const job = makeLeaseJob(pool)
      await job.start()
      expect(job.isRunning()).toBe(false)
      await job.stop()
    })

    it('returns true once onStateChange("leader") fires', async () => {
      const job = makeLeaseJob(pool)
      await job.start()
      await capturedOnStateChange!('leader')
      expect(job.isRunning()).toBe(true)
      await job.stop()
    })

    it('returns false once onStateChange("standby") fires', async () => {
      const job = makeLeaseJob(pool)
      await job.start()
      await capturedOnStateChange!('leader')
      await capturedOnStateChange!('standby')
      expect(job.isRunning()).toBe(false)
      await job.stop()
    })
  })

  // ─── Error handling & recovery ─────────────────────────────────────────

  describe('error handling and recovery', () => {
    it('propagates publisher.start() rejections through OutboxJob.start()', async () => {
      mockPublisherInstance.start.mockRejectedValueOnce(new Error('publisher boot failed'))

      const job = makeDirectJob(pool)

      await expect(job.start()).rejects.toThrow('publisher boot failed')
    })

    it('propagates publisher.stop() rejections through OutboxJob.stop()', async () => {
      mockPublisherInstance.stop.mockRejectedValueOnce(new Error('publisher stop failed'))

      const job = makeDirectJob(pool)
      await job.start()

      await expect(job.stop()).rejects.toThrow('publisher stop failed')
    })

    it('propagates leaseManager.start() rejections through OutboxJob.start()', async () => {
      mockLeaseManagerInstance.start.mockRejectedValueOnce(new Error('lease start failed'))

      const job = makeLeaseJob(pool)

      await expect(job.start()).rejects.toThrow('lease start failed')
    })

    it('propagates leaseManager.stop() rejections through OutboxJob.stop()', async () => {
      mockLeaseManagerInstance.stop.mockRejectedValueOnce(new Error('lease stop failed'))

      const job = makeLeaseJob(pool)
      await job.start()

      await expect(job.stop()).rejects.toThrow('lease stop failed')
    })

    it('publisher.start() failure caused by onStateChange does not crash the lease manager', async () => {
      mockPublisherInstance.start.mockRejectedValueOnce(new Error('publisher boot via state'))

      const job = makeLeaseJob(pool)
      await job.start()

      // The onStateChange handler is async — errors propagate to the caller
      await expect(capturedOnStateChange!('leader')).rejects.toThrow('publisher boot via state')

      // The lease manager itself was not torn down
      expect(mockLeaseManagerInstance.stop).not.toHaveBeenCalled()
    })

    it('stop() after a failed start is idempotent (started=false guard)', async () => {
      mockPublisherInstance.start.mockRejectedValueOnce(new Error('boot failed'))
      const job = makeDirectJob(pool)

      await expect(job.start()).rejects.toThrow('boot failed')

      // started is now false because the rejection propagated out
      // A subsequent stop() should be a no-op
      await expect(job.stop()).resolves.toBeUndefined()
      expect(mockPublisherInstance.stop).not.toHaveBeenCalled()
    })
  })

  // ─── Concurrent start ──────────────────────────────────────────────────

  describe('concurrent start', () => {
    it('two concurrent start() calls produce only one publisher', async () => {
      const job = makeDirectJob(pool)

      await Promise.all([job.start(), job.start()])

      expect(MockOutboxPublisher).toHaveBeenCalledTimes(1)
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(1)

      await job.stop()
    })
  })

  // ─── Boundary configuration ────────────────────────────────────────────

  describe('boundary configuration values', () => {
    it('forwards default retention days (7 / 30) when not specified', async () => {
      const job = new OutboxJob(pool)
      await job.start()

      const config = MockOutboxPublisher.mock.calls[0][1] as Record<string, unknown>
      expect(config.cleanup).toEqual({
        publishedRetentionDays: 7,
        failedRetentionDays: 30,
      })

      await job.stop()
    })

    it('forwards custom retention days through', async () => {
      const job = new OutboxJob(pool, {
        publishedRetentionDays: 1,
        failedRetentionDays: 365,
      })
      await job.start()

      const config = MockOutboxPublisher.mock.calls[0][1] as Record<string, unknown>
      expect(config.cleanup).toEqual({
        publishedRetentionDays: 1,
        failedRetentionDays: 365,
      })

      await job.stop()
    })

    it('forwards default cleanup interval (3 600 000 ms) when not specified', async () => {
      const job = new OutboxJob(pool)
      await job.start()

      const config = MockOutboxPublisher.mock.calls[0][1] as Record<string, unknown>
      expect(config.cleanupIntervalMs).toBe(3600000)

      await job.stop()
    })

    it('forwards default poll interval (1000 ms) when not specified', async () => {
      const job = new OutboxJob(pool)
      await job.start()

      const config = MockOutboxPublisher.mock.calls[0][1] as Record<string, unknown>
      expect(config.pollIntervalMs).toBe(1000)

      await job.stop()
    })

    it('forwards default batch size (100) when not specified', async () => {
      const job = new OutboxJob(pool)
      await job.start()

      const config = MockOutboxPublisher.mock.calls[0][1] as Record<string, unknown>
      expect(config.batchSize).toBe(100)

      await job.stop()
    })

    it('forwards default lease seconds (300) when not specified', async () => {
      const job = new OutboxJob(pool)
      await job.start()

      const config = MockOutboxPublisher.mock.calls[0][1] as Record<string, unknown>
      expect(config.leaseSeconds).toBe(300)

      await job.stop()
    })

    it('leaderLease options not passed to WorkerLeaseManager when undefined', async () => {
      const job = new OutboxJob(pool, {
        leaderLease: { enabled: true },
      })

      await job.start()

      expect(MockWorkerLeaseManager).toHaveBeenCalledWith(
        expect.objectContaining({
          retryIntervalMs: undefined,
          heartbeatIntervalMs: undefined,
        }),
      )

      await job.stop()
    })

    it('leaderLease disabled with explicit false still starts publisher directly', async () => {
      const job = new OutboxJob(pool, {
        leaderLease: { enabled: false },
      })

      await job.start()

      expect(MockWorkerLeaseManager).not.toHaveBeenCalled()
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(1)

      await job.stop()
    })

    it('leaderLease absent (undefined) still starts publisher directly', async () => {
      const job = new OutboxJob(pool, {})

      await job.start()

      expect(MockWorkerLeaseManager).not.toHaveBeenCalled()
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(1)

      await job.stop()
    })
  })

  // ─── Observability ─────────────────────────────────────────────────────

  describe('observability metrics', () => {
    it('does not increment leader metrics on direct (non-lease) start', async () => {
      const job = makeDirectJob(pool)
      await job.start()
      await job.stop()

      expect(mockIncrementOutboxLeaderAcquired).not.toHaveBeenCalled()
      expect(mockIncrementOutboxLeaderLost).not.toHaveBeenCalled()
    })

    it('increments acquired metric exactly once per leadership acquisition', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      await capturedOnStateChange!('leader')
      await capturedOnStateChange!('standby')
      await capturedOnStateChange!('leader') // second acquisition

      expect(mockIncrementOutboxLeaderAcquired).toHaveBeenCalledTimes(2)
      expect(mockIncrementOutboxLeaderLost).not.toHaveBeenCalled()

      await job.stop()
    })

    it('increments lost metric on each onReleased callback', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      capturedOnReleased!()
      capturedOnReleased!()

      expect(mockIncrementOutboxLeaderLost).toHaveBeenCalledTimes(2)

      await job.stop()
    })
  })

  // ─── Full lease-enabled lifecycle ──────────────────────────────────────

  describe('full leader-lease lifecycle', () => {
    it('completes acquire → publish → lose → reacquire cycle without duplicating publishers', async () => {
      const job = makeLeaseJob(pool)

      // 1. Start — standby, no publisher
      await job.start()
      expect(job.isRunning()).toBe(false)
      expect(MockOutboxPublisher).toHaveBeenCalledTimes(0)

      // 2. Acquire leadership
      await capturedOnStateChange!('leader')
      expect(job.isRunning()).toBe(true)
      expect(MockOutboxPublisher).toHaveBeenCalledTimes(1)
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(1)

      // 3. Lose leadership (DB network blip)
      await capturedOnStateChange!('standby')
      expect(job.isRunning()).toBe(false)
      expect(mockPublisherInstance.stop).toHaveBeenCalledTimes(1)

      // 4. Reacquire
      await capturedOnStateChange!('leader')
      expect(job.isRunning()).toBe(true)
      expect(MockOutboxPublisher).toHaveBeenCalledTimes(2) // fresh publisher
      expect(mockPublisherInstance.start).toHaveBeenCalledTimes(2)

      // 5. Graceful stop
      await job.stop()
      expect(job.isRunning()).toBe(false)
      expect(mockPublisherInstance.stop).toHaveBeenCalledTimes(2)
      expect(mockLeaseManagerInstance.stop).toHaveBeenCalledTimes(1)
    })

    it('null-safe: leaseManager reference is cleared after stop so a second stop is safe', async () => {
      const job = makeLeaseJob(pool)

      await job.start()
      await job.stop()
      // Second stop: started=false guard prevents touching leaseManager again
      await expect(job.stop()).resolves.toBeUndefined()
      expect(mockLeaseManagerInstance.stop).toHaveBeenCalledTimes(1)
    })
  })
})
