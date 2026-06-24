import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createDbProbe,
  createCacheProbe,
  createHorizonClientProbe,
  createHorizonListenerProbe,
  createOutboxPublisherProbe,
} from './probes.js'
import {
  resetWorkerHealthState,
  setHorizonListenerConfigured,
  setHorizonListenerRunning,
  recordHorizonListenerHeartbeat,
  setOutboxPublisherConfigured,
  setOutboxPublisherRunning,
  recordOutboxPublisherHeartbeat,
} from './runtimeState.js'

beforeEach(() => {
  resetWorkerHealthState()
  vi.useRealTimers()
})

// ─── DB probe ────────────────────────────────────────────────────────────────

describe('createDbProbe', () => {
  it('returns up and includes latencyMs when query succeeds', async () => {
    const probe = createDbProbe({ runQuery: async () => {} })!
    const result = await probe()
    expect(result.status).toBe('up')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns down with reason=connection_refused on query failure', async () => {
    const probe = createDbProbe({ runQuery: async () => { throw new Error('ECONNREFUSED') } })!
    const result = await probe()
    expect(result.status).toBe('down')
    expect(result.reason).toBe('connection_refused')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns down with reason=timeout when query hangs past CHECK_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    const probe = createDbProbe({
      runQuery: () => new Promise(() => {}), // never resolves
    })!
    const resultPromise = probe()
    vi.advanceTimersByTime(5001)
    const result = await resultPromise
    expect(result.status).toBe('down')
    expect(result.reason).toBe('timeout')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns undefined when DB_URL is not set and no runQuery injected', () => {
    const saved = process.env.DB_URL
    delete process.env.DB_URL
    const probe = createDbProbe()
    expect(probe).toBeUndefined()
    process.env.DB_URL = saved
  })
})

// ─── Redis probe ─────────────────────────────────────────────────────────────

describe('createCacheProbe', () => {
  it('returns up and includes latencyMs when ping succeeds', async () => {
    const probe = createCacheProbe({ ping: async () => 'PONG' })!
    const result = await probe()
    expect(result.status).toBe('up')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns down with reason=connection_refused on ping failure', async () => {
    const probe = createCacheProbe({ ping: async () => { throw new Error('ECONNREFUSED') } })!
    const result = await probe()
    expect(result.status).toBe('down')
    expect(result.reason).toBe('connection_refused')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns down with reason=timeout when ping hangs', async () => {
    vi.useFakeTimers()
    const probe = createCacheProbe({ ping: () => new Promise(() => {}) })!
    const resultPromise = probe()
    vi.advanceTimersByTime(5001)
    const result = await resultPromise
    expect(result.status).toBe('down')
    expect(result.reason).toBe('timeout')
  })
})

// ─── Horizon client probe (circuit breaker) ──────────────────────────────────

describe('createHorizonClientProbe', () => {
  it('returns up with circuitState=CLOSED and latencyMs', async () => {
    const probe = createHorizonClientProbe({ getState: () => 'CLOSED' })!
    const result = await probe()
    expect(result.status).toBe('up')
    expect(result.details?.circuitState).toBe('CLOSED')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns up with circuitState=HALF_OPEN', async () => {
    const probe = createHorizonClientProbe({ getState: () => 'HALF_OPEN' })!
    const result = await probe()
    expect(result.status).toBe('up')
    expect(result.details?.circuitState).toBe('HALF_OPEN')
  })

  it('returns down with reason=circuit_open when breaker is OPEN', async () => {
    const probe = createHorizonClientProbe({ getState: () => 'OPEN' })!
    const result = await probe()
    expect(result.status).toBe('down')
    expect(result.reason).toBe('circuit_open')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns down with reason=unreachable when getState throws', async () => {
    const probe = createHorizonClientProbe({ getState: () => { throw new Error('boom') } })!
    const result = await probe()
    expect(result.status).toBe('down')
    expect(result.reason).toBe('unreachable')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns undefined when HORIZON_URL is not set and no getState injected', () => {
    const saved = process.env.HORIZON_URL
    delete process.env.HORIZON_URL
    const probe = createHorizonClientProbe()
    expect(probe).toBeUndefined()
    process.env.HORIZON_URL = saved
  })
})

// ─── Horizon listener probe ──────────────────────────────────────────────────

describe('createHorizonListenerProbe', () => {
  it('returns not_configured when listener not configured', async () => {
    const probe = createHorizonListenerProbe()
    const result = await probe()
    expect(result.status).toBe('not_configured')
  })

  it('returns down with not_running when configured but not running', async () => {
    setHorizonListenerConfigured(true)
    const probe = createHorizonListenerProbe()
    const result = await probe()
    expect(result.status).toBe('down')
    expect(result.reason).toBe('not_running')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns down with no_heartbeat when running but no heartbeat yet', async () => {
    setHorizonListenerConfigured(true)
    setHorizonListenerRunning(true)
    const probe = createHorizonListenerProbe()
    const result = await probe()
    expect(result.status).toBe('down')
    expect(result.reason).toBe('no_heartbeat')
  })

  it('returns down with stale_heartbeat when heartbeat is old', async () => {
    setHorizonListenerConfigured(true)
    setHorizonListenerRunning(true)
    // Use fake timers so the heartbeat is deterministically older than the
    // (zero) staleness tolerance, rather than relying on sub-millisecond wall
    // clock timing.
    vi.useFakeTimers()
    try {
      recordHorizonListenerHeartbeat()
      vi.advanceTimersByTime(1)
      const probe = createHorizonListenerProbe(0)
      const result = await probe()
      expect(result.status).toBe('down')
      expect(result.reason).toBe('stale_heartbeat')
      expect(typeof result.latencyMs).toBe('number')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns up with latencyMs and heartbeatAgeMs when healthy', async () => {
    setHorizonListenerConfigured(true)
    setHorizonListenerRunning(true)
    recordHorizonListenerHeartbeat()
    const probe = createHorizonListenerProbe(60_000)
    const result = await probe()
    expect(result.status).toBe('up')
    expect(typeof result.latencyMs).toBe('number')
    expect(typeof result.details?.heartbeatAgeMs).toBe('number')
  })
})

// ─── Outbox publisher probe ──────────────────────────────────────────────────

describe('createOutboxPublisherProbe', () => {
  it('returns not_configured when outbox not configured', async () => {
    const probe = createOutboxPublisherProbe()
    const result = await probe()
    expect(result.status).toBe('not_configured')
  })

  it('returns down with not_running when configured but not running', async () => {
    setOutboxPublisherConfigured(true)
    const probe = createOutboxPublisherProbe()
    const result = await probe()
    expect(result.status).toBe('down')
    expect(result.reason).toBe('not_running')
    expect(typeof result.latencyMs).toBe('number')
  })

  it('returns up with latencyMs when healthy', async () => {
    setOutboxPublisherConfigured(true)
    setOutboxPublisherRunning(true)
    recordOutboxPublisherHeartbeat()
    const probe = createOutboxPublisherProbe(60_000)
    const result = await probe()
    expect(result.status).toBe('up')
    expect(typeof result.latencyMs).toBe('number')
  })
})

// ─── Partial outage / slow-but-not-down edge cases ───────────────────────────

describe('partial outage: postgres down, redis up → 503', () => {
  it('all checks run in parallel regardless of one failing', async () => {
    let redisChecked = false
    const dbProbe = createDbProbe({ runQuery: async () => { throw new Error('ECONNREFUSED') } })!
    const redisProbe = createCacheProbe({ ping: async () => { redisChecked = true; return 'PONG' } })!
    const { runHealthChecks } = await import('./checks.js')
    const result = await runHealthChecks({ postgres: dbProbe, redis: redisProbe })
    expect(result.status).toBe('unhealthy')
    expect(redisChecked).toBe(true)
    expect(result.dependencies.postgres.status).toBe('down')
    expect(result.dependencies.redis.status).toBe('up')
  })
})

describe('slow dependency: bounded by CHECK_TIMEOUT_MS', () => {
  it('probe returns down (timeout) before CHECK_TIMEOUT_MS + 100ms', async () => {
    vi.useFakeTimers()
    const probe = createDbProbe({ runQuery: () => new Promise(() => {}) })!
    const resultPromise = probe()
    vi.advanceTimersByTime(5001)
    const result = await resultPromise
    expect(result.status).toBe('down')
    expect(result.reason).toBe('timeout')
  })
})
