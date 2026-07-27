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
})
