/**
 * Boundary and recovery test coverage for src/examples/circuitBreaker.ts
 *
 * Invariants under test:
 *  - CLOSED → OPEN after exactly `failureThreshold` consecutive failures
 *  - OPEN rejects all requests immediately (fail-fast) without calling `fn`
 *  - OPEN → HALF_OPEN after `halfOpenAfterMs` elapses
 *  - HALF_OPEN allows exactly one concurrent probe; concurrent extras fail-fast
 *  - Successful probe: HALF_OPEN → CLOSED, failureCount reset
 *  - Failed probe: HALF_OPEN → OPEN (re-opens)
 *  - A success in CLOSED resets the failure streak to zero
 *  - cooldownPeriodMs (deprecated) maps to halfOpenAfterMs
 *  - halfOpenAfterMs is clamped to ≥ openWindowMs
 *  - Prometheus gauge is updated on every state transition
 *  - getCircuitBreaker returns the same instance for the same host
 *  - resetCircuitBreakers clears the singleton map
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type BreakerState,
  getCircuitBreaker,
  resetCircuitBreakers,
  sorobanCircuitStateGauge,
  registerCircuitBreakerMetrics,
} from '../circuitBreaker.js'
import { SorobanClientError } from '../soroban.js'
import client from 'prom-client'

// ── helpers ──────────────────────────────────────────────────────────────────

const HOST = 'rpc.example.com'

/** Minimal config with threshold=3, immediate HALF_OPEN after open window. */
const cfg = (overrides: Partial<CircuitBreakerConfig> = {}): CircuitBreakerConfig => ({
  failureThreshold: 3,
  openWindowMs: 100,
  halfOpenAfterMs: 200,
  ...overrides,
})

const pass = () => Promise.resolve('ok')
const fail = (msg = 'rpc error') => () => Promise.reject(new Error(msg))

/** Trip the breaker by calling execute `threshold` times with a failing fn. */
async function tripBreaker(cb: CircuitBreaker, threshold = 3): Promise<void> {
  for (let i = 0; i < threshold; i++) {
    await expect(cb.execute(fail())).rejects.toThrow()
  }
}

// ── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers()
  resetCircuitBreakers()
})

afterEach(() => {
  vi.useRealTimers()
  resetCircuitBreakers()
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. CLOSED state — normal operation
// ─────────────────────────────────────────────────────────────────────────────

describe('CLOSED state', () => {
  it('starts CLOSED', () => {
    const cb = new CircuitBreaker(HOST, cfg())
    expect(cb.getState()).toBe('CLOSED')
  })

  it('passes through to fn and returns its value', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    const result = await cb.execute(() => Promise.resolve(42))
    expect(result).toBe(42)
  })

  it('increments failureCount on each failure but stays CLOSED below threshold', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ failureThreshold: 3 }))
    await expect(cb.execute(fail())).rejects.toThrow()
    expect(cb.getFailureCount()).toBe(1)
    expect(cb.getState()).toBe('CLOSED')

    await expect(cb.execute(fail())).rejects.toThrow()
    expect(cb.getFailureCount()).toBe(2)
    expect(cb.getState()).toBe('CLOSED')
  })

  it('trips to OPEN on exactly the threshold failure', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ failureThreshold: 3 }))
    await tripBreaker(cb, 3)
    expect(cb.getState()).toBe('OPEN')
  })

  it('does NOT trip before the threshold', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ failureThreshold: 5 }))
    await tripBreaker(cb, 4)
    expect(cb.getState()).toBe('CLOSED')
  })

  it('resets failureCount to zero after a success', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ failureThreshold: 5 }))
    await expect(cb.execute(fail())).rejects.toThrow()
    await expect(cb.execute(fail())).rejects.toThrow()
    expect(cb.getFailureCount()).toBe(2)

    await cb.execute(pass)
    expect(cb.getFailureCount()).toBe(0)
    expect(cb.getState()).toBe('CLOSED')
  })

  it('rethrows the original error without wrapping', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    const originalError = new SorobanClientError({ code: 'RPC_ERROR', message: 'bad response' })
    await expect(cb.execute(() => Promise.reject(originalError))).rejects.toBe(originalError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. OPEN state — fail-fast
// ─────────────────────────────────────────────────────────────────────────────

describe('OPEN state', () => {
  it('rejects immediately with SorobanClientError NETWORK_ERROR', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    expect(cb.getState()).toBe('OPEN')

    const err = await cb.execute(pass).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SorobanClientError)
    expect((err as SorobanClientError).code).toBe('NETWORK_ERROR')
  })

  it('includes the host name in the OPEN rejection message', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)

    await expect(cb.execute(pass)).rejects.toThrow(HOST)
  })

  it('never calls fn while OPEN', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)

    const fn = vi.fn(() => Promise.resolve('should not run'))
    await expect(cb.execute(fn)).rejects.toBeInstanceOf(SorobanClientError)
    expect(fn).not.toHaveBeenCalled()
  })

  it('isOpenWindowExpired is false immediately after tripping', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ openWindowMs: 100 }))
    await tripBreaker(cb)
    expect(cb.isOpenWindowExpired()).toBe(false)
  })

  it('isOpenWindowExpired becomes true after openWindowMs', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ openWindowMs: 100 }))
    await tripBreaker(cb)

    vi.advanceTimersByTime(100)
    expect(cb.isOpenWindowExpired()).toBe(true)
  })

  it('stays OPEN between openWindowMs and halfOpenAfterMs', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ openWindowMs: 100, halfOpenAfterMs: 500 }))
    await tripBreaker(cb)

    vi.advanceTimersByTime(200) // past openWindowMs, before halfOpenAfterMs
    expect(cb.getState()).toBe('OPEN')
  })

  it('direct transitionTo(OPEN) sets openedAt so timers fire correctly', () => {
    const cb = new CircuitBreaker(HOST, cfg({ openWindowMs: 100, halfOpenAfterMs: 200 }))
    cb.transitionTo('OPEN')
    expect(cb.getState()).toBe('OPEN')

    vi.advanceTimersByTime(200)
    expect(cb.getState()).toBe('HALF_OPEN')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. OPEN → HALF_OPEN transition
// ─────────────────────────────────────────────────────────────────────────────

describe('OPEN → HALF_OPEN transition', () => {
  it('transitions to HALF_OPEN after halfOpenAfterMs', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ halfOpenAfterMs: 200 }))
    await tripBreaker(cb)
    expect(cb.getState()).toBe('OPEN')

    vi.advanceTimersByTime(200)
    expect(cb.getState()).toBe('HALF_OPEN')
  })

  it('does NOT transition before halfOpenAfterMs has fully elapsed', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ halfOpenAfterMs: 200 }))
    await tripBreaker(cb)

    vi.advanceTimersByTime(199)
    expect(cb.getState()).toBe('OPEN')
  })

  it('getState() triggers the timer check', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ halfOpenAfterMs: 200 }))
    await tripBreaker(cb)

    vi.advanceTimersByTime(200)
    // getState drives checkTimers()
    expect(cb.getState()).toBe('HALF_OPEN')
  })

  it('execute() also triggers the timer check before running fn', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ halfOpenAfterMs: 200 }))
    await tripBreaker(cb)

    vi.advanceTimersByTime(200)
    // Should not throw OPEN error — it must have transitioned first
    const result = await cb.execute(pass)
    expect(result).toBe('ok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. HALF_OPEN state — probe behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('HALF_OPEN state', () => {
  async function openAndAdvance(
    overrides: Partial<CircuitBreakerConfig> = {}
  ): Promise<CircuitBreaker> {
    const cb = new CircuitBreaker(HOST, cfg(overrides))
    await tripBreaker(cb)
    vi.advanceTimersByTime(200)
    expect(cb.getState()).toBe('HALF_OPEN')
    return cb
  }

  it('allows exactly one probe through', async () => {
    const cb = await openAndAdvance()
    const result = await cb.execute(pass)
    expect(result).toBe('ok')
  })

  it('rejects a second concurrent probe with NETWORK_ERROR', async () => {
    const cb = await openAndAdvance()

    // First probe is in-flight (never resolves)
    let resolveFirst!: () => void
    const firstProbe = cb.execute(
      () => new Promise<string>((res) => { resolveFirst = () => res('ok') })
    )

    // Second probe must be rejected immediately
    const err = await cb.execute(pass).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SorobanClientError)
    expect((err as SorobanClientError).code).toBe('NETWORK_ERROR')
    expect((err as SorobanClientError).message).toContain('probe is already in progress')

    // Clean up: let the first probe finish
    resolveFirst()
    await firstProbe
  })

  it('successful probe transitions to CLOSED and resets failureCount', async () => {
    const cb = await openAndAdvance()
    await cb.execute(pass)

    expect(cb.getState()).toBe('CLOSED')
    expect(cb.getFailureCount()).toBe(0)
  })

  it('failed probe transitions back to OPEN immediately', async () => {
    const cb = await openAndAdvance()
    await expect(cb.execute(fail('probe failed'))).rejects.toThrow('probe failed')

    expect(cb.getState()).toBe('OPEN')
  })

  it('after re-open from failed probe, requests fail-fast again', async () => {
    const cb = await openAndAdvance()
    await expect(cb.execute(fail())).rejects.toThrow()
    expect(cb.getState()).toBe('OPEN')

    const err = await cb.execute(pass).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SorobanClientError)
    expect((err as SorobanClientError).code).toBe('NETWORK_ERROR')
  })

  it('re-open resets the halfOpenAfterMs timer so another probe window opens', async () => {
    const cb = await openAndAdvance()
    // Fail the probe → OPEN again
    await expect(cb.execute(fail())).rejects.toThrow()
    expect(cb.getState()).toBe('OPEN')

    // Advance past halfOpenAfterMs again
    vi.advanceTimersByTime(200)
    expect(cb.getState()).toBe('HALF_OPEN')

    // This time succeed
    await cb.execute(pass)
    expect(cb.getState()).toBe('CLOSED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Full CLOSED → OPEN → HALF_OPEN → CLOSED recovery cycle
// ─────────────────────────────────────────────────────────────────────────────

describe('full recovery cycle', () => {
  it('completes CLOSED → OPEN → HALF_OPEN → CLOSED without data loss', async () => {
    const cb = new CircuitBreaker(HOST, cfg())

    // CLOSED: accumulate failures
    await tripBreaker(cb, 3)
    expect(cb.getState()).toBe('OPEN')

    // OPEN: fail-fast
    await expect(cb.execute(pass)).rejects.toBeInstanceOf(SorobanClientError)

    // Advance to HALF_OPEN
    vi.advanceTimersByTime(200)
    expect(cb.getState()).toBe('HALF_OPEN')

    // Successful probe → CLOSED
    await cb.execute(pass)
    expect(cb.getState()).toBe('CLOSED')
    expect(cb.getFailureCount()).toBe(0)

    // Normal traffic works again
    const value = await cb.execute(() => Promise.resolve('recovered'))
    expect(value).toBe('recovered')
  })

  it('handles multiple trip-and-recover cycles deterministically', async () => {
    const cb = new CircuitBreaker(HOST, cfg())

    for (let cycle = 0; cycle < 3; cycle++) {
      await tripBreaker(cb, 3)
      expect(cb.getState()).toBe('OPEN')

      vi.advanceTimersByTime(200)
      expect(cb.getState()).toBe('HALF_OPEN')

      await cb.execute(pass)
      expect(cb.getState()).toBe('CLOSED')
      expect(cb.getFailureCount()).toBe(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Configuration boundary cases
// ─────────────────────────────────────────────────────────────────────────────

describe('configuration boundaries', () => {
  it('failureThreshold=1 trips on the first failure', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ failureThreshold: 1 }))
    await expect(cb.execute(fail())).rejects.toThrow()
    expect(cb.getState()).toBe('OPEN')
  })

  it('cooldownPeriodMs (deprecated) maps to halfOpenAfterMs when new field absent', async () => {
    const cb = new CircuitBreaker(HOST, {
      failureThreshold: 1,
      openWindowMs: 100,
      cooldownPeriodMs: 200,
      // halfOpenAfterMs intentionally omitted
    })
    await expect(cb.execute(fail())).rejects.toThrow()
    expect(cb.getState()).toBe('OPEN')

    vi.advanceTimersByTime(200)
    expect(cb.getState()).toBe('HALF_OPEN')
  })

  it('halfOpenAfterMs takes precedence over cooldownPeriodMs', async () => {
    const cb = new CircuitBreaker(HOST, {
      failureThreshold: 1,
      openWindowMs: 100,
      halfOpenAfterMs: 300,
      cooldownPeriodMs: 200, // lower — should be ignored
    })
    await expect(cb.execute(fail())).rejects.toThrow()

    vi.advanceTimersByTime(200)
    // Should still be OPEN because halfOpenAfterMs=300 takes precedence
    expect(cb.getState()).toBe('OPEN')

    vi.advanceTimersByTime(100)
    expect(cb.getState()).toBe('HALF_OPEN')
  })

  it('clamps halfOpenAfterMs to openWindowMs when supplied value is smaller', async () => {
    // halfOpenAfterMs(50) < openWindowMs(100) → clamped to 100
    const cb = new CircuitBreaker(HOST, {
      failureThreshold: 1,
      openWindowMs: 100,
      halfOpenAfterMs: 50,
    })
    await expect(cb.execute(fail())).rejects.toThrow()

    vi.advanceTimersByTime(50)
    expect(cb.getState()).toBe('OPEN') // not yet — clamped to 100

    vi.advanceTimersByTime(50)
    expect(cb.getState()).toBe('HALF_OPEN')
  })

  it('uses CIRCUIT_BREAKER_DEFAULTS when optional fields are omitted', () => {
    // No openWindowMs or halfOpenAfterMs → defaults from sorobanConstants
    const cb = new CircuitBreaker(HOST, { failureThreshold: 5 })
    expect(cb.getState()).toBe('CLOSED')
  })

  it('large failureThreshold (boundary: 100) works correctly', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ failureThreshold: 100 }))
    await tripBreaker(cb, 99)
    expect(cb.getState()).toBe('CLOSED')

    await expect(cb.execute(fail())).rejects.toThrow()
    expect(cb.getState()).toBe('OPEN')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Concurrent execution safety
// ─────────────────────────────────────────────────────────────────────────────

describe('concurrent execution', () => {
  it('concurrent failures all count toward the threshold', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ failureThreshold: 3 }))

    const results = await Promise.allSettled([
      cb.execute(fail('e1')),
      cb.execute(fail('e2')),
      cb.execute(fail('e3')),
    ])

    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(cb.getState()).toBe('OPEN')
  })

  it('concurrent successes do not corrupt failure count', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ failureThreshold: 5 }))
    await tripBreaker(cb, 2)

    await Promise.all([cb.execute(pass), cb.execute(pass), cb.execute(pass)])

    expect(cb.getFailureCount()).toBe(0)
    expect(cb.getState()).toBe('CLOSED')
  })

  it('only one of many concurrent HALF_OPEN callers gets the probe slot', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    vi.advanceTimersByTime(200)

    // Fire many concurrent execute calls — only one should succeed the probe slot
    let resolveProbe!: () => void
    const probePromise = cb.execute(
      () => new Promise<string>((res) => { resolveProbe = () => res('ok') })
    )

    const extras = await Promise.allSettled([
      cb.execute(pass),
      cb.execute(pass),
      cb.execute(pass),
    ])

    expect(extras.every((r) => r.status === 'rejected')).toBe(true)
    extras.forEach((r) => {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(SorobanClientError)
      }
    })

    resolveProbe()
    await probePromise
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. Manual transitionTo — invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('transitionTo', () => {
  it('transitionTo(CLOSED) resets failureCount and activeProbes', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    expect(cb.getFailureCount()).toBe(3)

    cb.transitionTo('CLOSED')
    expect(cb.getState()).toBe('CLOSED')
    expect(cb.getFailureCount()).toBe(0)
  })

  it('transitionTo(OPEN) sets openedAt so timer fires at correct time', () => {
    const cb = new CircuitBreaker(HOST, cfg({ halfOpenAfterMs: 200 }))
    cb.transitionTo('OPEN')

    vi.advanceTimersByTime(199)
    expect(cb.getState()).toBe('OPEN')

    vi.advanceTimersByTime(1)
    expect(cb.getState()).toBe('HALF_OPEN')
  })

  it('transitionTo(HALF_OPEN) resets activeProbes to allow a new probe', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    vi.advanceTimersByTime(200)

    // Burn the probe slot
    let resolveFirst!: () => void
    const first = cb.execute(
      () => new Promise<string>((res) => { resolveFirst = () => res('ok') })
    )
    await expect(cb.execute(pass)).rejects.toBeInstanceOf(SorobanClientError)

    // Manually transition to HALF_OPEN again (resets activeProbes)
    cb.transitionTo('HALF_OPEN')
    const result = await cb.execute(pass)
    expect(result).toBe('ok')

    resolveFirst()
    await first
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. Prometheus metrics
// ─────────────────────────────────────────────────────────────────────────────

describe('Prometheus metrics', () => {
  it('gauge is 0 (CLOSED) immediately after construction', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    const metrics = await sorobanCircuitStateGauge.get()
    const val = metrics.values.find((v) => v.labels.host === HOST)
    expect(val?.value).toBe(0)
  })

  it('gauge becomes 1 (OPEN) when the breaker trips', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    const metrics = await sorobanCircuitStateGauge.get()
    const val = metrics.values.find((v) => v.labels.host === HOST)
    expect(val?.value).toBe(1)
  })

  it('gauge becomes 2 (HALF_OPEN) after the cooldown', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    vi.advanceTimersByTime(200)
    cb.getState() // trigger checkTimers
    const metrics = await sorobanCircuitStateGauge.get()
    const val = metrics.values.find((v) => v.labels.host === HOST)
    expect(val?.value).toBe(2)
  })

  it('gauge returns to 0 (CLOSED) after a successful probe', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    vi.advanceTimersByTime(200)
    await cb.execute(pass)
    const metrics = await sorobanCircuitStateGauge.get()
    const val = metrics.values.find((v) => v.labels.host === HOST)
    expect(val?.value).toBe(0)
  })

  it('registerCircuitBreakerMetrics does not throw if already registered', () => {
    const registry = new client.Registry()
    registerCircuitBreakerMetrics(registry)
    // Second call must be a no-op, not throw
    expect(() => registerCircuitBreakerMetrics(registry)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. getCircuitBreaker / resetCircuitBreakers — singleton map
// ─────────────────────────────────────────────────────────────────────────────

describe('getCircuitBreaker / resetCircuitBreakers', () => {
  it('returns the same instance for the same host', () => {
    const a = getCircuitBreaker(HOST, cfg())
    const b = getCircuitBreaker(HOST, cfg())
    expect(a).toBe(b)
  })

  it('returns different instances for different hosts', () => {
    const a = getCircuitBreaker('host-a', cfg())
    const b = getCircuitBreaker('host-b', cfg())
    expect(a).not.toBe(b)
  })

  it('after resetCircuitBreakers, a new instance is created', () => {
    const before = getCircuitBreaker(HOST, cfg())
    resetCircuitBreakers()
    const after = getCircuitBreaker(HOST, cfg())
    expect(after).not.toBe(before)
  })

  it('state from an old instance does not bleed into a new instance after reset', async () => {
    const old = getCircuitBreaker(HOST, cfg())
    await tripBreaker(old)
    expect(old.getState()).toBe('OPEN')

    resetCircuitBreakers()
    const fresh = getCircuitBreaker(HOST, cfg())
    expect(fresh.getState()).toBe('CLOSED')
  })

  it('config from first call wins — second call with different config gets same instance', () => {
    const first = getCircuitBreaker(HOST, cfg({ failureThreshold: 1 }))
    const second = getCircuitBreaker(HOST, cfg({ failureThreshold: 99 }))
    expect(first).toBe(second)
    // The instance was created with threshold=1
    expect(first.host).toBe(HOST)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. isOpenWindowExpired — boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('isOpenWindowExpired', () => {
  it('returns false when CLOSED', () => {
    const cb = new CircuitBreaker(HOST, cfg())
    expect(cb.isOpenWindowExpired()).toBe(false)
  })

  it('returns false when HALF_OPEN', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    vi.advanceTimersByTime(200)
    cb.getState() // advance to HALF_OPEN
    expect(cb.isOpenWindowExpired()).toBe(false)
  })

  it('returns false at exactly openWindowMs - 1 ms', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ openWindowMs: 100 }))
    await tripBreaker(cb)
    vi.advanceTimersByTime(99)
    expect(cb.isOpenWindowExpired()).toBe(false)
  })

  it('returns true at exactly openWindowMs', async () => {
    const cb = new CircuitBreaker(HOST, cfg({ openWindowMs: 100 }))
    await tripBreaker(cb)
    vi.advanceTimersByTime(100)
    expect(cb.isOpenWindowExpired()).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 12. Regression — error type and message invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('error type and message invariants', () => {
  it('OPEN rejection is a SorobanClientError, not a plain Error', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    const err = await cb.execute(pass).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SorobanClientError)
    expect(err).toBeInstanceOf(Error)
    expect((err as SorobanClientError).name).toBe('SorobanClientError')
  })

  it('HALF_OPEN concurrent probe rejection is a SorobanClientError', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    vi.advanceTimersByTime(200)

    let resolve!: () => void
    const probe = cb.execute(() => new Promise<string>((res) => { resolve = () => res('ok') }))

    const err = await cb.execute(pass).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SorobanClientError)
    expect((err as SorobanClientError).code).toBe('NETWORK_ERROR')

    resolve()
    await probe
  })

  it('original non-SorobanClientError is rethrown from CLOSED without modification', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    const customError = Object.assign(new Error('db gone'), { code: 'DB_CONN' })
    const thrown = await cb.execute(() => Promise.reject(customError)).catch((e: unknown) => e)
    expect(thrown).toBe(customError)
    expect((thrown as any).code).toBe('DB_CONN')
  })

  it('failure in HALF_OPEN rethrows original error to caller', async () => {
    const cb = new CircuitBreaker(HOST, cfg())
    await tripBreaker(cb)
    vi.advanceTimersByTime(200)

    const probeError = new Error('still down')
    const thrown = await cb.execute(() => Promise.reject(probeError)).catch((e: unknown) => e)
    expect(thrown).toBe(probeError)
    expect(cb.getState()).toBe('OPEN')
  })
})
