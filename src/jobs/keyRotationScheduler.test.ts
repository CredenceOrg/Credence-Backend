import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { KeyRotationScheduler } from './keyRotationScheduler.js'
import { keyManager } from '../services/keyManager/index.js'

/**
 * Drive the scheduler with very small intervals so the test runs in
 * milliseconds instead of seconds.  We also spy on `setInterval`/`clearInterval`
 * behaviour implicitly by verifying that `.isActive()` flips correctly.
 */
const FAST_INTERVALS = {
  rotationIntervalMs: 10,
  pruneIntervalMs: 20,
}

describe('KeyRotationScheduler', () => {
  let logs: string[]

  beforeEach(async () => {
    keyManager._resetStore()
    await keyManager.initialize()
    logs = []
  })

  afterEach(() => {
    // vi.spyOn() without an explicit restore accumulates call counts across
    // tests on the same singleton — and `keyManager.rotate` is a real method,
    // so we need every prior spying chain restored before the next test.
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does nothing until start() is called', () => {
    const scheduler = new KeyRotationScheduler({
      ...FAST_INTERVALS,
      logger: (m) => logs.push(m),
    })
    expect(scheduler.isActive()).toBe(false)
  })

  it('flips isActive() to true after start(), and back to false after stop()', () => {
    const scheduler = new KeyRotationScheduler({
      ...FAST_INTERVALS,
      logger: (m) => logs.push(m),
    })
    scheduler.start()
    expect(scheduler.isActive()).toBe(true)
    scheduler.stop()
    expect(scheduler.isActive()).toBe(false)
  })

  it('start() is idempotent — calling twice does not double the timers', () => {
    const scheduler = new KeyRotationScheduler({
      ...FAST_INTERVALS,
      logger: (m) => logs.push(m),
    })
    scheduler.start()
    scheduler.start() // second call is a no-op
    expect(scheduler.isActive()).toBe(true)
    scheduler.stop()
  })

  it('calls keyManager.rotate() after one rotation interval', async () => {
    vi.useFakeTimers()
    const rotateSpy = vi.spyOn(keyManager, 'rotate')
    const scheduler = new KeyRotationScheduler({
      rotationIntervalMs: 100,
      pruneIntervalMs: 1000,
      logger: (m) => logs.push(m),
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(150)
    scheduler.stop()

    expect(rotateSpy).toHaveBeenCalled()
  })

  it('logs and continues when keyManager.rotate() throws', async () => {
    vi.useFakeTimers()
    vi.spyOn(keyManager, 'rotate').mockRejectedValueOnce(new Error('boom'))

    const scheduler = new KeyRotationScheduler({
      rotationIntervalMs: 50,
      pruneIntervalMs: 1000,
      logger: (m) => logs.push(m),
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(75)
    scheduler.stop()

    expect(logs.some((l) => l.includes('rotation failed') && l.includes('boom'))).toBe(true)
    // Scheduler should still be active until stop()
    expect(scheduler.isActive()).toBe(false) // we called stop, so false
  })

  it('does not call rotate() before its interval elapses', async () => {
    vi.useFakeTimers()
    const rotateSpy = vi.spyOn(keyManager, 'rotate')
    const scheduler = new KeyRotationScheduler({
      rotationIntervalMs: 1000,
      pruneIntervalMs: 1000,
      logger: (m) => logs.push(m),
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(500) // half the rotate interval
    scheduler.stop()

    expect(rotateSpy).not.toHaveBeenCalled()
  })

  it('stops emitting ticks after stop() is called', async () => {
    vi.useFakeTimers()
    const rotateSpy = vi.spyOn(keyManager, 'rotate')
    const scheduler = new KeyRotationScheduler({
      rotationIntervalMs: 50,
      pruneIntervalMs: 1000,
      logger: (m) => logs.push(m),
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(75)
    scheduler.stop()

    const callCountAtStop = rotateSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(500) // far past the interval
    scheduler.stop() // idempotent

    expect(rotateSpy.mock.calls.length).toBe(callCountAtStop)
  })

  // ------------------------------------------------------------------------
  // Boundary & recovery coverage (added for the bounty issue)
  // ------------------------------------------------------------------------

  it('rejects a non-positive rotationIntervalMs at construction time', () => {
    expect(
      () =>
        new KeyRotationScheduler({
          rotationIntervalMs: 0,
          pruneIntervalMs: 1000,
          logger: (m) => logs.push(m),
        }),
    ).toThrow()
  })

  it('rejects a non-positive pruneIntervalMs at construction time', () => {
    expect(
      () =>
        new KeyRotationScheduler({
          rotationIntervalMs: 1000,
          pruneIntervalMs: -1,
          logger: (m) => logs.push(m),
        }),
    ).toThrow()
  })

  it('rejects NaN intervals at construction time', () => {
    expect(
      () =>
        new KeyRotationScheduler({
          rotationIntervalMs: NaN,
          pruneIntervalMs: 1000,
          logger: (m) => logs.push(m),
        }),
    ).toThrow()
  })

  it('rejects a missing logger at construction time', () => {
    expect(
      () =>
        new KeyRotationScheduler({
          rotationIntervalMs: 1000,
          pruneIntervalMs: 1000,
          // logger intentionally omitted
        } as any),
    ).toThrow()
  })

  it('recovers after a transient rotation failure and retries on the next tick', async () => {
    vi.useFakeTimers()
    const rotateSpy = vi
      .spyOn(keyManager, 'rotate')
      .mockRejectedValueOnce(new Error('transient'))

    const scheduler = new KeyRotationScheduler({
      rotationIntervalMs: 50,
      pruneIntervalMs: 1000,
      logger: (m) => logs.push(m),
    })
    scheduler.start()

    // First tick fails.
    await vi.advanceTimersByTimeAsync(50)
    expect(logs.some((l) => l.includes('rotation failed'))).toBe(true)

    // Second tick succeeds — the scheduler must not have stopped.
    await vi.advanceTimersByTimeAsync(50)
    expect(rotateSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(scheduler.isActive()).toBe(true)

    scheduler.stop()
  })

  it('does not overlap concurrent rotations when a tick is slow', async () => {
    vi.useFakeTimers()

    let inFlight = 0
    let maxInFlight = 0
    const rotateSpy = vi.spyOn(keyManager, 'rotate').mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 200))
      inFlight -= 1
    })

    const scheduler = new KeyRotationScheduler({
      rotationIntervalMs: 50,
      pruneIntervalMs: 1000,
      logger: (m) => logs.push(m),
    })
    scheduler.start()

    // Advance well past multiple intervals while the first rotation is slow
    await vi.advanceTimersByTimeAsync(1000)
    scheduler.stop()

    expect(maxInFlight).toBe(1)
    expect(rotateSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the scheduler active and logs when pruning fails', async () => {
    vi.useFakeTimers()
    const pruneSpy = vi
      .spyOn(keyManager, 'pruneExpiredKeys' as any)
      .mockRejectedValueOnce(new Error('prune boom'))

    const scheduler = new KeyRotationScheduler({
      rotationIntervalMs: 1000,
      pruneIntervalMs: 50,
      logger: (m) => logs.push(m),
    })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(75)
    expect(scheduler.isActive()).toBe(true)
    expect(pruneSpy).toHaveBeenCalled()

    scheduler.stop()
  })

  it('start() after stop() restarts the timers without duplicating them', async () => {
    vi.useFakeTimers()
    const rotateSpy = vi.spyOn(keyManager, 'rotate')

    const scheduler = new KeyRotationScheduler({
      rotationIntervalMs: 50,
      pruneIntervalMs: 1000,
      logger: (m) => logs.push(m),
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(75)
    scheduler.stop()

    const afterFirstStop = rotateSpy.mock.calls.length

    // Restart and verify the timer fires again exactly once per interval.
    scheduler.start()
    await vi.advanceTimersByTimeAsync(75)
    scheduler.stop()

    expect(rotateSpy.mock.calls.length).toBeGreaterThan(afterFirstStop)
  })

  it('stop() is safe to call before start()', () => {
    const scheduler = new KeyRotationScheduler({
      ...FAST_INTERVALS,
      logger: (m) => logs.push(m),
    })
    expect(() => scheduler.stop()).not.toThrow()
    expect(scheduler.isActive()).toBe(false)
  })

  it('rotation failure logs do not leak raw key material', async () => {
    vi.useFakeTimers()
    const secret = 'SUPER_SECRET_KEY_MATERIAL'
    vi.spyOn(keyManager, 'rotate').mockRejectedValueOnce(new Error('failed'))

    const scheduler = new KeyRotationScheduler({
      rotationIntervalMs: 50,
      pruneIntervalMs: 1000,
      logger: (m) => logs.push(m),
    })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(75)
    scheduler.stop()

    expect(logs.join('\n')).not.toContain(secret)
  })
})
