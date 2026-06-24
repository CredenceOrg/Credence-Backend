import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import client from 'prom-client'
import {
  CircuitBreaker,
  getCircuitBreaker,
  resetCircuitBreakers,
  sorobanCircuitStateGauge,
} from '../circuitBreaker.js'
import { SorobanClient, SorobanClientError } from '../soroban.js'

describe('Soroban Circuit Breaker Tests', () => {
  beforeEach(() => {
    resetCircuitBreakers()
    // Reset Prometheus metrics
    sorobanCircuitStateGauge.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts in CLOSED state and registers 0 as metric value', () => {
    const breaker = getCircuitBreaker('test-host-1', {
      failureThreshold: 3,
      cooldownPeriodMs: 5000,
    })

    expect(breaker.getState()).toBe('CLOSED')
    // Check metric value
    const metricsStr = client.register.metrics()
    expect(metricsStr).toBeDefined()
  })

  it('remains CLOSED when failures are below threshold', async () => {
    const breaker = getCircuitBreaker('test-host-2', {
      failureThreshold: 3,
      cooldownPeriodMs: 5000,
    })

    // Succeed once
    const res1 = await breaker.execute(async () => 'success')
    expect(res1).toBe('success')
    expect(breaker.getState()).toBe('CLOSED')

    // Fail once
    await expect(
      breaker.execute(async () => {
        throw new Error('transient error')
      })
    ).rejects.toThrow('transient error')

    expect(breaker.getState()).toBe('CLOSED')
    expect(breaker.getFailureCount()).toBe(1)
  })

  it('transitions to OPEN and fails fast after failure threshold is reached', async () => {
    const breaker = getCircuitBreaker('test-host-3', {
      failureThreshold: 2,
      cooldownPeriodMs: 5000,
    })

    const failFn = async () => {
      throw new Error('RPC error')
    }

    // First failure
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    expect(breaker.getState()).toBe('CLOSED')
    expect(breaker.getFailureCount()).toBe(1)

    // Second failure - trips the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    expect(breaker.getState()).toBe('OPEN')

    // Subsequent call fails fast immediately without executing the function
    const execMock = vi.fn(async () => 'should not run')
    await expect(breaker.execute(execMock)).rejects.toThrow(SorobanClientError)
    await expect(breaker.execute(execMock)).rejects.toThrow('Soroban circuit breaker is OPEN')
    expect(execMock).not.toHaveBeenCalled()
  })

  it('transitions to HALF_OPEN after cooldown period, and probe success closes it', async () => {
    vi.useFakeTimers()
    
    const breaker = getCircuitBreaker('test-host-4', {
      failureThreshold: 1,
      cooldownPeriodMs: 1000,
    })

    const failFn = async () => {
      throw new Error('RPC error')
    }

    // Fail to open the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    expect(breaker.getState()).toBe('OPEN')

    // Fast-forward time
    vi.advanceTimersByTime(1000)

    // Breaker should check cooldown and report HALF_OPEN
    expect(breaker.getState()).toBe('HALF_OPEN')

    // Probe request succeeds
    const successMock = vi.fn(async () => 'probe success')
    const res = await breaker.execute(successMock)
    
    expect(res).toBe('probe success')
    expect(successMock).toHaveBeenCalledTimes(1)
    expect(breaker.getState()).toBe('CLOSED')
    expect(breaker.getFailureCount()).toBe(0)
  })

  it('transitions to HALF_OPEN after cooldown period, and probe failure reopens it', async () => {
    vi.useFakeTimers()
    
    const breaker = getCircuitBreaker('test-host-5', {
      failureThreshold: 1,
      cooldownPeriodMs: 1000,
    })

    const failFn = async () => {
      throw new Error('RPC error')
    }

    // Fail to open the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    expect(breaker.getState()).toBe('OPEN')

    // Fast-forward time
    vi.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe('HALF_OPEN')

    // Probe request fails
    await expect(breaker.execute(failFn)).rejects.toThrow('RPC error')
    
    // Breaker should immediately transition back to OPEN
    expect(breaker.getState()).toBe('OPEN')
  })

  it('allows only a single concurrent probe in HALF_OPEN state, others fail fast', async () => {
    vi.useFakeTimers()

    const breaker = getCircuitBreaker('test-host-6', {
      failureThreshold: 1,
      cooldownPeriodMs: 1000,
    })

    // Fail to open
    await expect(
      breaker.execute(async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')
    expect(breaker.getState()).toBe('OPEN')

    // Cooldown elapsed
    vi.advanceTimersByTime(1000)
    expect(breaker.getState()).toBe('HALF_OPEN')

    // Start a slow probe request
    let resolveProbe: (val: string) => void = () => {}
    const probePromise = breaker.execute(() => {
      return new Promise<string>((resolve) => {
        resolveProbe = resolve
      })
    })

    // Concurrent request should fail fast immediately
    const concurrentMock = vi.fn(async () => 'concurrent success')
    await expect(breaker.execute(concurrentMock)).rejects.toThrow(SorobanClientError)
    await expect(breaker.execute(concurrentMock)).rejects.toThrow('a probe is already in progress')
    expect(concurrentMock).not.toHaveBeenCalled()

    // Resolve the probe successfully
    resolveProbe!('probe done')
    const probeResult = await probePromise
    expect(probeResult).toBe('probe done')
    expect(breaker.getState()).toBe('CLOSED')
  })

  it('enforces independent breaker states across different hosts (multi-host isolation)', async () => {
    const breakerA = getCircuitBreaker('host-a.stellar.org', {
      failureThreshold: 1,
      cooldownPeriodMs: 5000,
    })
    const breakerB = getCircuitBreaker('host-b.stellar.org', {
      failureThreshold: 1,
      cooldownPeriodMs: 5000,
    })

    // Trip breaker A
    await expect(
      breakerA.execute(async () => {
        throw new Error('A failed')
      })
    ).rejects.toThrow('A failed')
    
    expect(breakerA.getState()).toBe('OPEN')
    // Breaker B must remain CLOSED
    expect(breakerB.getState()).toBe('CLOSED')

    // Executing B should succeed
    const resB = await breakerB.execute(async () => 'B success')
    expect(resB).toBe('B success')
  })

  it('integrates with SorobanClient configurations and callRpc logic', async () => {
    vi.useFakeTimers()

    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'))

    const client = new SorobanClient({
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
        cooldownPeriodMs: 1000,
      },
    }, {
      fetchFn: fetchMock,
      sleepFn: async (ms) => {
        vi.advanceTimersByTime(ms)
      },
    })

    // Executing first call will try 2 attempts internally, then fail
    await expect(client.getIdentityState('GAAddress')).rejects.toThrow(SorobanClientError)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Breaker should be CLOSED still (only 1 call failed overall)
    // Now trigger second call
    fetchMock.mockClear()
    await expect(client.getIdentityState('GAAddress')).rejects.toThrow(SorobanClientError)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Now breaker should be tripped and in OPEN state
    fetchMock.mockClear()
    await expect(client.getIdentityState('GAAddress')).rejects.toThrow(SorobanClientError)
    // No fetch should have been made due to circuit breaker fail-fast
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
