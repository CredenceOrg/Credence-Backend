import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkerLeaseManager, OUTBOX_LEADER_LOCK_KEY } from './workerLeaseManager.js'

function createMockClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ pg_advisory_lock: true }] }),
    release: vi.fn(),
  }
}

function createMockPool(client?: ReturnType<typeof createMockClient>) {
  const c = client ?? createMockClient()
  return {
    connect: vi.fn().mockResolvedValue(c),
  }
}

describe('WorkerLeaseManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('exports a stable lock key constant', () => {
    expect(OUTBOX_LEADER_LOCK_KEY).toBe(53_81)
  })

  it('starts in standby state', () => {
    const pool = createMockPool()
    const mgr = new WorkerLeaseManager({ pool: pool as any })
    expect(mgr.currentState).toBe('standby')
  })

  it('acquires leadership on start and fires onStateChange', async () => {
    const client = createMockClient()
    const pool = createMockPool(client)
    const onStateChange = vi.fn()

    const mgr = new WorkerLeaseManager({ pool: pool as any })
    mgr.on({ onStateChange })

    await mgr.start()
    await mgr.stop()

    expect(onStateChange).toHaveBeenCalledWith('leader')
    expect(mgr.currentState).toBe('standby')
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_lock'),
      [OUTBOX_LEADER_LOCK_KEY],
    )
  })

  it('fires onAcquired when leadership is obtained', async () => {
    const pool = createMockPool()
    const onAcquired = vi.fn()

    const mgr = new WorkerLeaseManager({ pool: pool as any })
    mgr.on({ onAcquired })

    await mgr.start()
    await mgr.stop()

    expect(onAcquired).toHaveBeenCalledTimes(1)
  })

  it('releases the advisory lock on stop', async () => {
    const client = createMockClient()
    const pool = createMockPool(client)
    const onReleased = vi.fn()

    const mgr = new WorkerLeaseManager({ pool: pool as any })
    mgr.on({ onReleased })
    await mgr.start()

    await mgr.stop()

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      [OUTBOX_LEADER_LOCK_KEY],
    )
    expect(client.release).toHaveBeenCalled()
    expect(onReleased).toHaveBeenCalledTimes(1)
    expect(mgr.currentState).toBe('standby')
  })

  it('does not start twice', async () => {
    const pool = createMockPool()
    const mgr = new WorkerLeaseManager({ pool: pool as any })
    await mgr.start()
    await mgr.start()

    expect(pool.connect).toHaveBeenCalledTimes(1)
    await mgr.stop()
  })

  it('does nothing on stop if not started', async () => {
    const pool = createMockPool()
    const mgr = new WorkerLeaseManager({ pool: pool as any })
    await mgr.stop()

    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('retries on connection failure', async () => {
    const client = createMockClient()
    const pool = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValue(client),
    }
    const onError = vi.fn()

    const mgr = new WorkerLeaseManager({
      pool: pool as any,
      retryIntervalMs: 1000,
    })
    mgr.on({ onError })

    await mgr.start()

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection refused' }))
    expect(mgr.currentState).toBe('standby')

    // After retry timer fires
    await vi.advanceTimersByTimeAsync(1000)

    expect(mgr.currentState).toBe('leader')

    await mgr.stop()
  })

  it('retries on query failure', async () => {
    const client = createMockClient()
    client.query
      .mockRejectedValueOnce(new Error('query failed'))
      .mockResolvedValueOnce({ rows: [{ pg_advisory_lock: true }] })

    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    }
    const onError = vi.fn()

    const mgr = new WorkerLeaseManager({
      pool: pool as any,
      retryIntervalMs: 1000,
    })
    mgr.on({ onError })

    await mgr.start()

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'query failed' }))
    expect(mgr.currentState).toBe('standby')

    await vi.advanceTimersByTimeAsync(1000)

    expect(mgr.currentState).toBe('leader')

    await mgr.stop()
  })

  it('heartbeat detects connection loss and reverts to standby', async () => {
    const client = createMockClient()
    client.query
      .mockResolvedValueOnce({ rows: [{ pg_advisory_lock: true }] }) // acquire
      .mockRejectedValueOnce(new Error('connection lost')) // heartbeat SELECT 1

    const client2 = createMockClient()
    const pool = {
      connect: vi.fn()
        .mockResolvedValueOnce(client)
        .mockResolvedValueOnce(client2),
    }

    const onStateChange = vi.fn()
    const onReleased = vi.fn()

    const mgr = new WorkerLeaseManager({
      pool: pool as any,
      heartbeatIntervalMs: 5000,
      retryIntervalMs: 1000,
    })
    mgr.on({ onStateChange, onReleased })

    await mgr.start()
    expect(onStateChange).toHaveBeenCalledWith('leader')

    // Heartbeat fires
    await vi.advanceTimersByTimeAsync(5000)

    expect(onReleased).toHaveBeenCalled()
    expect(mgr.currentState).toBe('standby')

    // Retry fires and acquires
    await vi.advanceTimersByTimeAsync(1000)

    expect(onStateChange).toHaveBeenLastCalledWith('leader')

    await mgr.stop()
  })

  it('stop clears all timers', async () => {
    const pool = createMockPool()
    const mgr = new WorkerLeaseManager({
      pool: pool as any,
      heartbeatIntervalMs: 5000,
    })

    await mgr.start()
    await mgr.stop()

    // Advance past where timers would fire — no errors
    await vi.advanceTimersByTimeAsync(20_000)

    expect(mgr.currentState).toBe('standby')
  })

  it('uses custom lock key', async () => {
    const client = createMockClient()
    const pool = createMockPool(client)

    const mgr = new WorkerLeaseManager({ pool: pool as any, lockKey: 9999 })
    await mgr.start()

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_lock'),
      [9999],
    )

    await mgr.stop()
  })

  it('releaseLock is safe to call when client is null', async () => {
    const pool = createMockPool()
    const mgr = new WorkerLeaseManager({ pool: pool as any })

    // stop without start should not throw
    await mgr.stop()
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('isRunning() reflects publisher state via onStateChange', async () => {
    const pool = createMockPool()
    const mgr = new WorkerLeaseManager({ pool: pool as any })

    expect(mgr.currentState).toBe('standby')

    await mgr.start()
    expect(mgr.currentState).toBe('leader')

    await mgr.stop()
    expect(mgr.currentState).toBe('standby')
  })

  it('on() replaces previously registered handlers for the same key', async () => {
    const pool = createMockPool()
    const cb1 = vi.fn()
    const cb2 = vi.fn()

    const mgr = new WorkerLeaseManager({ pool: pool as any })
    mgr.on({ onAcquired: cb1 })
    mgr.on({ onAcquired: cb2 }) // replaces cb1

    await mgr.start()
    await mgr.stop()

    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).toHaveBeenCalledTimes(1)
  })

  it('on() allows registering different event keys', async () => {
    const pool = createMockPool()
    const onAcquired = vi.fn()
    const onReleased = vi.fn()

    const mgr = new WorkerLeaseManager({ pool: pool as any })
    mgr.on({ onAcquired })
    mgr.on({ onReleased })

    await mgr.start()
    await mgr.stop()

    expect(onAcquired).toHaveBeenCalledTimes(1)
    expect(onReleased).toHaveBeenCalledTimes(1)
  })

  it('state change does not fire when already in target state', async () => {
    const pool = createMockPool()
    const onStateChange = vi.fn()

    const mgr = new WorkerLeaseManager({ pool: pool as any })
    mgr.on({ onStateChange })

    await mgr.start()

    // Only one state change (standby → leader)
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenCalledWith('leader')

    await mgr.stop()

    // leader → standby
    expect(onStateChange).toHaveBeenCalledTimes(2)
    expect(onStateChange).toHaveBeenLastCalledWith('standby')
  })
})
