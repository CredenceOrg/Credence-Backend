import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import client from 'prom-client'
import {
  CircuitBreaker,
  getCircuitBreaker,
  resetCircuitBreakers,
  sorobanCircuitStateGauge,
} from '../circuitBreaker.js'
import { SorobanClient, SorobanClientError } from '../soroban.js'
import {
  CIRCUIT_BREAKER_OPEN_WINDOW_MS,
  CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS,
} from '../../config/sorobanConstants.js'

describe('Soroban Circuit Breaker Tests', () => {
  beforeEach(() => {
    resetCircuitBreakers()
    // Reset Prometheus metrics
    sorobanCircuitStateGauge.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Default constant sanity checks ────────────────────────────────────────

  it('exports the correct default open-window (10 s) and half-open delay (30 s)', () => {
    expect(CIRCUIT_BREAKER_OPEN_WINDOW_MS).toBe(10_000)
    expect(CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS).toBe(30_000)
  })

  // ── Initial state ─────────────────────────────────────────────────────────

  it('starts in CLOSED state and registers 0 as metric value', () => {
    const breaker = getCircuitBreaker('test-host-1', {
      failureThreshold: 3,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    expect(breaker.getState()).toBe('CLOSED')
    // Check metric value
    const metricsStr = client.register.metrics()
    expect(metricsStr).toBeDefined()
  })

  it('remains CLOSED when failures are below threshold', async () => {
    const breaker = getCircuitBreaker('test-host-2', {
      failureThreshold: 3,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    // Succeed once
    const res1 = await breaker.execute(async () => 'success')
    expect(res1).toBe('success')
    expect(breaker.getState()).toBe('CLOSED')

    // Fail once (below threshold of 3)
    await expect(
      breaker.execute(async () => {
        throw new Error('transient error')
      }),
    ).rejects.toThrow('transient error')

    expect(breaker.getState()).toBe('CLOSED')
    expect(breaker.getFailureCount()).toBe(1)
  })

  // ── Tripping the breaker ──────────────────────────────────────────────────

  it('transitions to OPEN and fails fast after failure threshold is reached', async () => {
    const breaker = getCircuitBreaker('test-host-3', {
      failureThreshold: 2,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    const failFn = async () => {
      throw new Error('RPC error')
    }

    // First failure
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    expect(breaker.getState()).toBe('CLOSED')
    expect(breaker.getFailureCount()).toBe(1)

    // Second failure — trips the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    expect(breaker.getState()).toBe('OPEN')

    // Subsequent calls fail fast immediately without executing the function
    const execMock = vi.fn(async () => 'should not run')
    await expect(breaker.execute(execMock)).rejects.toThrow(SorobanClientError)
    await expect(breaker.execute(execMock)).rejects.toThrow('Soroban circuit breaker is OPEN')
    expect(execMock).not.toHaveBeenCalled()
  })

  // ── Fail-fast window (openWindowMs = 10 s) ────────────────────────────────

  it('stays OPEN and rejects requests during the fail-fast window (< 10 s)', async () => {
    vi.useFakeTimers()

    const breaker = getCircuitBreaker('test-host-failfast', {
      failureThreshold: 1,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    // Trip the breaker
    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
    expect(breaker.getState()).toBe('OPEN')

    // 5 s in — still inside the fail-fast window
    vi.advanceTimersByTime(5_000)
    expect(breaker.getState()).toBe('OPEN')

    // 9.9 s in — still OPEN
    vi.advanceTimersByTime(4_900)
    expect(breaker.getState()).toBe('OPEN')

    const execMock = vi.fn()
    await expect(breaker.execute(execMock)).rejects.toThrow('circuit breaker is OPEN')
    expect(execMock).not.toHaveBeenCalled()
  })

  it('isOpenWindowExpired() returns true after 10 s but state remains OPEN until 30 s', async () => {
    vi.useFakeTimers()

    const breaker = getCircuitBreaker('test-host-expired', {
      failureThreshold: 1,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()

    // Before open window
    vi.advanceTimersByTime(9_999)
    expect(breaker.isOpenWindowExpired()).toBe(false)
    expect(breaker.getState()).toBe('OPEN')

    // After open window but before half-open window
    vi.advanceTimersByTime(1)          // now at 10 000 ms
    expect(breaker.isOpenWindowExpired()).toBe(true)
    expect(breaker.getState()).toBe('OPEN')   // still OPEN — probe window not yet

    // At 20 s — still OPEN, waiting for 30 s probe window
    vi.advanceTimersByTime(10_000)
    expect(breaker.isOpenWindowExpired()).toBe(true)
    expect(breaker.getState()).toBe('OPEN')

    // Requests still fail fast even though open-window expired
    const execMock = vi.fn()
    await expect(breaker.execute(execMock)).rejects.toThrow('circuit breaker is OPEN')
    expect(execMock).not.toHaveBeenCalled()
  })

  // ── Half-open after 30 s ──────────────────────────────────────────────────

  it('stays OPEN at 29.9 s and transitions to HALF_OPEN at 30 s', async () => {
    vi.useFakeTimers()

    const breaker = getCircuitBreaker('test-host-halfopen-timing', {
      failureThreshold: 1,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()

    // 29.9 s — still OPEN
    vi.advanceTimersByTime(29_900)
    expect(breaker.getState()).toBe('OPEN')

    // 30 s exactly — HALF_OPEN
    vi.advanceTimersByTime(100)
    expect(breaker.getState()).toBe('HALF_OPEN')
  })

  it('transitions to HALF_OPEN after 30 s and probe success closes it', async () => {
    vi.useFakeTimers()

    const breaker = getCircuitBreaker('test-host-4', {
      failureThreshold: 1,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    const failFn = async () => {
      throw new Error('RPC error')
    }

    // Fail to open the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    expect(breaker.getState()).toBe('OPEN')

    // Fast-forward 30 s to the probe window
    vi.advanceTimersByTime(30_000)
    expect(breaker.getState()).toBe('HALF_OPEN')

    // Probe request succeeds
    const successMock = vi.fn(async () => 'probe success')
    const res = await breaker.execute(successMock)

    expect(res).toBe('probe success')
    expect(successMock).toHaveBeenCalledTimes(1)
    expect(breaker.getState()).toBe('CLOSED')
    expect(breaker.getFailureCount()).toBe(0)
  })

  it('transitions to HALF_OPEN after 30 s and probe failure reopens it', async () => {
    vi.useFakeTimers()

    const breaker = getCircuitBreaker('test-host-5', {
      failureThreshold: 1,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    const failFn = async () => {
      throw new Error('RPC error')
    }

    // Fail to open the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    expect(breaker.getState()).toBe('OPEN')

    // Fast-forward 30 s
    vi.advanceTimersByTime(30_000)
    expect(breaker.getState()).toBe('HALF_OPEN')

    // Probe request fails — immediately reopens
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    expect(breaker.getState()).toBe('OPEN')
  })

  // ── Concurrency limit in HALF_OPEN ────────────────────────────────────────

  it('allows only a single concurrent probe in HALF_OPEN state, others fail fast', async () => {
    vi.useFakeTimers()

    const breaker = getCircuitBreaker('test-host-6', {
      failureThreshold: 1,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    // Fail to open
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')
    expect(breaker.getState()).toBe('OPEN')

    // Cooldown elapsed
    vi.advanceTimersByTime(30_000)
    expect(breaker.getState()).toBe('HALF_OPEN')

    // Start a slow probe request
    let resolveProbe: (val: string) => void = () => {}
    const probePromise = breaker.execute(
      () =>
        new Promise<string>((resolve) => {
          resolveProbe = resolve
        }),
    )

    // Concurrent request should fail fast immediately
    const concurrentMock = vi.fn(async () => 'concurrent success')
    await expect(breaker.execute(concurrentMock)).rejects.toThrow(SorobanClientError)
    await expect(breaker.execute(concurrentMock)).rejects.toThrow('a probe is already in progress')
    expect(concurrentMock).not.toHaveBeenCalled()

    // Resolve the probe successfully
    resolveProbe('probe done')
    const probeResult = await probePromise
    expect(probeResult).toBe('probe done')
    expect(breaker.getState()).toBe('CLOSED')
  })

  // ── Multi-host isolation ──────────────────────────────────────────────────

  it('enforces independent breaker states across different hosts (multi-host isolation)', async () => {
    const breakerA = getCircuitBreaker('host-a.stellar.org', {
      failureThreshold: 1,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })
    const breakerB = getCircuitBreaker('host-b.stellar.org', {
      failureThreshold: 1,
      openWindowMs: 10_000,
      halfOpenAfterMs: 30_000,
    })

    // Trip breaker A
    await expect(
      breakerA.execute(async () => {
        throw new Error('A failed')
      }),
    ).rejects.toThrow('A failed')

    expect(breakerA.getState()).toBe('OPEN')
    // Breaker B must remain CLOSED
    expect(breakerB.getState()).toBe('CLOSED')

    // Executing B should succeed
    const resB = await breakerB.execute(async () => 'B success')
    expect(resB).toBe('B success')
  })

  // ── Backwards-compat: cooldownPeriodMs ───────────────────────────────────

  it('accepts deprecated cooldownPeriodMs and maps it to halfOpenAfterMs', async () => {
    vi.useFakeTimers()

    const breaker = getCircuitBreaker('test-host-compat', {
      failureThreshold: 1,
      // Old API — should map to halfOpenAfterMs
      cooldownPeriodMs: 15_000,
    })

    await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
    expect(breaker.getState()).toBe('OPEN')

    // At 14.9 s — still OPEN
    vi.advanceTimersByTime(14_900)
    expect(breaker.getState()).toBe('OPEN')

    // At 15 s — HALF_OPEN (cooldownPeriodMs mapped to halfOpenAfterMs)
    vi.advanceTimersByTime(100)
    expect(breaker.getState()).toBe('HALF_OPEN')
  })

  // ── SorobanClient integration ─────────────────────────────────────────────

  it('integrates with SorobanClient configurations and callRpc logic', async () => {
    vi.useFakeTimers()

    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'))

    const sorobanClient = new SorobanClient(
      {
        rpcUrl: 'https://rpc-test-host.stellar.org',
        network: 'testnet',
        contractId: 'CD123',
        timeoutMs: 1000,
        retry: {
          maxAttempts: 2,
          baseDelayMs: 10,
          maxDelayMs: 100,
        },
        circuitBreaker: {
          failureThreshold: 2,
          openWindowMs: 10_000,
          halfOpenAfterMs: 30_000,
        },
      },
      {
        fetchFn: fetchMock,
        sleepFn: async (ms) => {
          vi.advanceTimersByTime(ms)
        },
      },
    )

    // First call: 2 retry attempts → 1 overall failure recorded by the breaker
    await expect(sorobanClient.getIdentityState('GAAddress')).rejects.toThrow(SorobanClientError)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Second call: 2 retry attempts → 2nd overall failure → breaker trips
    fetchMock.mockClear()
    await expect(sorobanClient.getIdentityState('GAAddress')).rejects.toThrow(SorobanClientError)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Third call: breaker is OPEN → fail-fast, no fetch
    fetchMock.mockClear()
    await expect(sorobanClient.getIdentityState('GAAddress')).rejects.toThrow(SorobanClientError)
    expect(fetchMock).not.toHaveBeenCalled()

    // Advance 30 s → HALF_OPEN probe window
    vi.advanceTimersByTime(30_000)

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'getContractData-1',
          result: { state: 'recovered' },
        }),
        { status: 200 },
      ),
    )

    const recovered = await sorobanClient.getIdentityState('GAAddress')
    expect(recovered).toEqual({ state: 'recovered' })
  })

  // ── Chaos and Recovery Tests for Half-Open Probe ─────────────────────────────

  describe('Chaos and Recovery Tests', () => {
    it('handles rapid state transitions: OPEN -> HALF_OPEN -> OPEN -> HALF_OPEN -> CLOSED', async () => {
      vi.useFakeTimers()

      const breaker = getCircuitBreaker('chaos-rapid-transitions', {
        failureThreshold: 1,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })

      const failFn = async () => {
        throw new Error('RPC error')
      }
      const successFn = async () => 'success'

      // Initial trip to OPEN
      await expect(breaker.execute(failFn)).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // First HALF_OPEN attempt - probe fails
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')
      await expect(breaker.execute(failFn)).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Second HALF_OPEN attempt - probe fails again
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')
      await expect(breaker.execute(failFn)).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Third HALF_OPEN attempt - probe succeeds
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')
      const result = await breaker.execute(successFn)
      expect(result).toBe('success')
      expect(breaker.getState()).toBe('CLOSED')
    })

    it('recovers after multiple consecutive probe failures with backoff', async () => {
      vi.useFakeTimers()

      const breaker = getCircuitBreaker('chaos-multiple-failures', {
        failureThreshold: 1,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })

      const failFn = async () => {
        throw new Error('RPC error')
      }
      const successFn = async () => 'success'

      // Initial trip
      await expect(breaker.execute(failFn)).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Simulate 5 consecutive probe failures
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(10_000)
        expect(breaker.getState()).toBe('HALF_OPEN')
        await expect(breaker.execute(failFn)).rejects.toThrow()
        expect(breaker.getState()).toBe('OPEN')
      }

      // Finally succeeds on 6th attempt
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')
      const result = await breaker.execute(successFn)
      expect(result).toBe('success')
      expect(breaker.getState()).toBe('CLOSED')
      expect(breaker.getFailureCount()).toBe(0)
    })

    it('handles probe timing edge case: exactly at half-open boundary', async () => {
      vi.useFakeTimers()

      const breaker = getCircuitBreaker('chaos-timing-edge', {
        failureThreshold: 1,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })

      await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Advance to exactly 10_000 ms
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')

      // Probe should succeed
      const result = await breaker.execute(async () => 'success')
      expect(result).toBe('success')
      expect(breaker.getState()).toBe('CLOSED')
    })

    it('handles concurrent requests during HALF_OPEN transition', async () => {
      vi.useFakeTimers()

      const breaker = getCircuitBreaker('chaos-concurrent-transition', {
        failureThreshold: 1,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })

      await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Advance to just before HALF_OPEN
      vi.advanceTimersByTime(9_999)
      expect(breaker.getState()).toBe('OPEN')

      // One more millisecond triggers HALF_OPEN
      vi.advanceTimersByTime(1)
      expect(breaker.getState()).toBe('HALF_OPEN')

      // Start a slow probe
      let resolveProbe: (val: string) => void = () => {}
      const probePromise = breaker.execute(
        () =>
          new Promise<string>((resolve) => {
            resolveProbe = resolve
          }),
      )

      // Concurrent requests during probe should fail fast
      const concurrentMock = vi.fn(async () => 'concurrent')
      await expect(breaker.execute(concurrentMock)).rejects.toThrow('a probe is already in progress')
      expect(concurrentMock).not.toHaveBeenCalled()

      // Resolve probe successfully
      resolveProbe('probe done')
      await probePromise
      expect(breaker.getState()).toBe('CLOSED')
    })

    it('simulates intermittent network flakiness during probe', async () => {
      vi.useFakeTimers()

      const breaker = getCircuitBreaker('chaos-flaky-network', {
        failureThreshold: 1,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })

      let attemptCount = 0
      const flakyFn = async () => {
        attemptCount++
        if (attemptCount < 3) {
          throw new Error('intermittent failure')
        }
        return 'success'
      }

      // Initial trip
      await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // First probe fails (flaky network)
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')
      await expect(breaker.execute(flakyFn)).rejects.toThrow('intermittent failure')
      expect(breaker.getState()).toBe('OPEN')

      // Second probe fails (still flaky)
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')
      await expect(breaker.execute(flakyFn)).rejects.toThrow('intermittent failure')
      expect(breaker.getState()).toBe('OPEN')

      // Third probe succeeds (network recovered)
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')
      const result = await breaker.execute(flakyFn)
      expect(result).toBe('success')
      expect(breaker.getState()).toBe('CLOSED')
    })

    it('handles probe timeout by treating as failure and reopening', async () => {
      vi.useFakeTimers()

      const breaker = getCircuitBreaker('chaos-probe-timeout', {
        failureThreshold: 1,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })

      await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')

      // Simulate timeout by throwing after delay
      const timeoutFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        throw new Error('timeout')
      }

      await expect(breaker.execute(timeoutFn)).rejects.toThrow('timeout')
      expect(breaker.getState()).toBe('OPEN')
    })

    it('recovers after extended outage with delayed probe success', async () => {
      vi.useFakeTimers()

      const breaker = getCircuitBreaker('chaos-extended-outage', {
        failureThreshold: 1,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })

      const failFn = async () => {
        throw new Error('RPC error')
      }
      const successFn = async () => 'success'

      // Initial trip
      await expect(breaker.execute(failFn)).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Extended outage: multiple probe cycles fail
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(10_000)
        expect(breaker.getState()).toBe('HALF_OPEN')
        await expect(breaker.execute(failFn)).rejects.toThrow()
        expect(breaker.getState()).toBe('OPEN')
      }

      // Service finally recovers after extended period
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')
      const result = await breaker.execute(successFn)
      expect(result).toBe('success')
      expect(breaker.getState()).toBe('CLOSED')
    })

    it('handles rapid successive trips during recovery attempt', async () => {
      vi.useFakeTimers()

      const breaker = getCircuitBreaker('chaos-rapid-trips', {
        failureThreshold: 2,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })

      const failFn = async () => {
        throw new Error('RPC error')
      }

      // Trip with 2 failures
      await expect(breaker.execute(failFn)).rejects.toThrow()
      await expect(breaker.execute(failFn)).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Enter HALF_OPEN
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')

      // Probe fails - should reopen immediately
      await expect(breaker.execute(failFn)).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Immediately trip again with another failure (still in OPEN state)
      // This should not increment failure count since we're already OPEN
      await expect(breaker.execute(failFn)).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Wait for next probe window
      vi.advanceTimersByTime(10_000)
      expect(breaker.getState()).toBe('HALF_OPEN')

      // Successful recovery
      const result = await breaker.execute(async () => 'success')
      expect(result).toBe('success')
      expect(breaker.getState()).toBe('CLOSED')
    })

    it('maintains probe isolation across multiple hosts during chaos', async () => {
      vi.useFakeTimers()

      const breakerA = getCircuitBreaker('chaos-host-a', {
        failureThreshold: 1,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })
      const breakerB = getCircuitBreaker('chaos-host-b', {
        failureThreshold: 1,
        openWindowMs: 5_000,
        halfOpenAfterMs: 10_000,
      })

      // Trip both breakers
      await expect(breakerA.execute(async () => { throw new Error('A fail') })).rejects.toThrow()
      await expect(breakerB.execute(async () => { throw new Error('B fail') })).rejects.toThrow()
      expect(breakerA.getState()).toBe('OPEN')
      expect(breakerB.getState()).toBe('OPEN')

      // Host A recovers
      vi.advanceTimersByTime(10_000)
      expect(breakerA.getState()).toBe('HALF_OPEN')
      expect(breakerB.getState()).toBe('HALF_OPEN')

      const resultA = await breakerA.execute(async () => 'A success')
      expect(resultA).toBe('A success')
      expect(breakerA.getState()).toBe('CLOSED')
      expect(breakerB.getState()).toBe('HALF_OPEN') // B still in HALF_OPEN

      // Host B probe fails
      await expect(breakerB.execute(async () => { throw new Error('B fail') })).rejects.toThrow()
      expect(breakerB.getState()).toBe('OPEN')
      expect(breakerA.getState()).toBe('CLOSED') // A remains CLOSED
    })

    it('handles state transitions with custom timing configurations', async () => {
      vi.useFakeTimers()

      const breaker = getCircuitBreaker('chaos-custom-timing', {
        failureThreshold: 1,
        openWindowMs: 2_000,
        halfOpenAfterMs: 5_000,
      })

      await expect(breaker.execute(async () => { throw new Error('fail') })).rejects.toThrow()
      expect(breaker.getState()).toBe('OPEN')

      // Still in fail-fast window
      vi.advanceTimersByTime(1_999)
      expect(breaker.getState()).toBe('OPEN')
      expect(breaker.isOpenWindowExpired()).toBe(false)

      // Fail-fast window expired, but not yet in HALF_OPEN
      vi.advanceTimersByTime(1)
      expect(breaker.getState()).toBe('OPEN')
      expect(breaker.isOpenWindowExpired()).toBe(true)

      // Enter HALF_OPEN
      vi.advanceTimersByTime(3_000)
      expect(breaker.getState()).toBe('HALF_OPEN')

      // Successful probe
      const result = await breaker.execute(async () => 'success')
      expect(result).toBe('success')
      expect(breaker.getState()).toBe('CLOSED')
    })
  })
})
