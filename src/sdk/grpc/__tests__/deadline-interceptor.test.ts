import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createDeadlineInterceptor,
  GRPC_DEADLINE_REMAINING_KEY,
  isDeadlineExceededError,
} from '../interceptors.js'
import { SdkRequestTimeoutCredenceError } from '../../errors.generated.js'
import { tracingContext } from '../../../utils/logger.js'
import type { TimeoutMetricsCollector } from '../../../observability/timeoutMetrics.js'

// ---------------------------------------------------------------------------
// Mock @connectrpc/connect so the tests compile without the actual package.
// ---------------------------------------------------------------------------
const { MockConnectError } = vi.hoisted(() => {
  class MockConnectError extends Error {
    code: number
    details: unknown[] = []
    rawMessage: string
    rawBytes: undefined
    constructor(message: string, code: number) {
      super(message)
      this.name = 'ConnectError'
      this.code = code
      this.rawMessage = message
    }
  }
  return { MockConnectError }
})

vi.mock('@connectrpc/connect', () => ({
  ConnectError: MockConnectError,
  Code: { DeadlineExceeded: 4, Canceled: 1, Unknown: 2 },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReq(overrides: Record<string, unknown> = {}) {
  const controller = new AbortController()
  return {
    stream: false as const,
    service: { typeName: 'credence.v1.TestService', methods: {} },
    method: { name: 'TestMethod', I: {} as any, O: {} as any, kind: 'unary' as const },
    signal: controller.signal,
    header: new Headers(),
    message: {},
    requestMethod: 'POST' as const,
    url: 'http://localhost:50051/credence.v1.TestService/TestMethod',
    ...overrides,
  }
}

/** Returns a mock next that rejects when the request signal aborts. */
function createSignalAwareNext(resolveAfterMs?: number) {
  return vi.fn().mockImplementation((req: any) => {
    return new Promise((resolve, reject) => {
      if (req.signal.aborted) {
        reject(new DOMException('The operation was aborted', 'AbortError'))
        return
      }
      const onAbort = (): void => {
        reject(new DOMException('The operation was aborted', 'AbortError'))
      }
      req.signal.addEventListener('abort', onAbort, { once: true })
      if (resolveAfterMs === undefined) return // hang until signal aborts
      setTimeout(() => {
        req.signal.removeEventListener('abort', onAbort)
        resolve({})
      }, resolveAfterMs)
    })
  })
}

/** Returns a mock next that resolves immediately (call succeeds). */
function createSuccessNext() {
  return vi.fn().mockResolvedValue({})
}

function createMetricsMock(): TimeoutMetricsCollector {
  return { onTimeout: vi.fn() }
}

class AbortError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'AbortError'
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDeadlineInterceptor', () => {
  let collector: ReturnType<typeof createMetricsMock>

  beforeEach(() => {
    collector = createMetricsMock()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // Budget selection
  // -----------------------------------------------------------------------

  it('uses per-method timeout when method is listed in the map', async () => {
    const interceptor = createDeadlineInterceptor(
      { 'credence.v1.TestService/TestMethod': 5_000, '*': 10_000 },
      collector,
    )
    const next = createSuccessNext()
    const req = createReq()
    await expect(interceptor(next)(req)).resolves.toEqual({})
    expect(next).toHaveBeenCalledTimes(1)
    expect(collector.onTimeout).not.toHaveBeenCalled()
  })

  it('falls back to the wildcard key when method is not in the map', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 8_000 }, collector)
    const next = createSuccessNext()
    const req = createReq()
    await expect(interceptor(next)(req)).resolves.toEqual({})
    expect(collector.onTimeout).not.toHaveBeenCalled()
  })

  it('falls back to GRPC_DEFAULT_TIMEOUT_MS when no match exists', async () => {
    const interceptor = createDeadlineInterceptor({}, collector)
    const next = createSuccessNext()
    const req = createReq()
    await expect(interceptor(next)(req)).resolves.toEqual({})
    expect(collector.onTimeout).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Caller-remaining deadline propagation (tracingContext)
  // -----------------------------------------------------------------------

  it('takes the minimum of configured budget and caller-remaining deadline', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    const next = createSuccessNext()
    const ctx = new Map<string, string>().set(GRPC_DEADLINE_REMAINING_KEY, '500')

    await tracingContext.run(ctx, () => interceptor(next)(createReq()))
    expect(next).toHaveBeenCalledTimes(1)
    expect(collector.onTimeout).not.toHaveBeenCalled()
  })

  it('ignores caller-remaining when tracingContext has no deadline key', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    const next = createSuccessNext()
    await tracingContext.run(new Map(), () => interceptor(next)(createReq()))
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('ignores NaN or negative caller-remaining values', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    const next = createSuccessNext()

    await tracingContext.run(
      new Map().set(GRPC_DEADLINE_REMAINING_KEY, 'not-a-number'),
      () => interceptor(next)(createReq()),
    )
    expect(next).toHaveBeenCalledTimes(1)

    await tracingContext.run(
      new Map().set(GRPC_DEADLINE_REMAINING_KEY, '-1'),
      () => interceptor(next)(createReq()),
    )
    expect(next).toHaveBeenCalledTimes(2)
  })

  // -----------------------------------------------------------------------
  // Fast-fail on already-expired deadlines
  // -----------------------------------------------------------------------

  it('throws SdkRequestTimeoutCredenceError when effective timeout is <= 0', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 0 }, collector)
    const next = createSuccessNext()
    const req = createReq()

    await expect(interceptor(next)(req)).rejects.toThrow(SdkRequestTimeoutCredenceError)
    expect(next).not.toHaveBeenCalled()
  })

  it('throws SdkRequestTimeoutCredenceError when effective timeout is negative', async () => {
    const interceptor = createDeadlineInterceptor({ '*': -1 }, collector)
    const next = createSuccessNext()
    const req = createReq()

    await expect(interceptor(next)(req)).rejects.toThrow(SdkRequestTimeoutCredenceError)
    expect(next).not.toHaveBeenCalled()
  })

  it('throws SdkRequestTimeoutCredenceError when parent signal is already aborted', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    const next = createSuccessNext()
    const parentController = new AbortController()
    parentController.abort()
    const req = createReq({ signal: parentController.signal })

    await expect(interceptor(next)(req)).rejects.toThrow(SdkRequestTimeoutCredenceError)
    expect(next).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Timeout firing (timer exceeds budget)
  // -----------------------------------------------------------------------

  it('throws SdkRequestTimeoutCredenceError when call exceeds the timeout budget', async () => {
    vi.useRealTimers()

    const interceptor = createDeadlineInterceptor({ '*': 50 }, collector)
    const next = createSignalAwareNext() // hangs until signal aborts
    const req = createReq()

    const promise = interceptor(next)(req)

    await expect(promise).rejects.toThrow(SdkRequestTimeoutCredenceError)
    expect(next).toHaveBeenCalledTimes(1)
    expect(collector.onTimeout).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('emits a timeout metric when the budget is exceeded', async () => {
    vi.useRealTimers()

    const interceptor = createDeadlineInterceptor({ '*': 50 }, collector)
    const next = createSignalAwareNext() // hangs until signal aborts
    const req = createReq()

    await expect(interceptor(next)(req)).rejects.toThrow()
    expect(collector.onTimeout).toHaveBeenCalledTimes(1)

    const event = collector.onTimeout.mock.calls[0][0]
    expect(event).toMatchObject({
      serviceType: 'grpc',
      reasonCode: 'GRPC_TIMEOUT',
      operation: 'credence.v1.TestService/TestMethod',
      timeoutMs: 50,
    })
  }, 10_000)

  it('does NOT emit a metric on successful call', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    await expect(interceptor(createSuccessNext())(createReq())).resolves.toEqual({})
    expect(collector.onTimeout).not.toHaveBeenCalled()
  })

  it('does not throw when no metrics collector is provided', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 })
    await expect(interceptor(createSuccessNext())(createReq())).resolves.toEqual({})
  })

  // -----------------------------------------------------------------------
  // Server-side DEADLINE_EXCEEDED
  // -----------------------------------------------------------------------

  it('wraps a ConnectError with Code.DeadlineExceeded as SdkRequestTimeoutCredenceError', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    const deadlineError = new MockConnectError('upstream timed out', 4)
    const next = vi.fn().mockRejectedValue(deadlineError)
    const req = createReq()

    await expect(interceptor(next)(req)).rejects.toThrow(SdkRequestTimeoutCredenceError)
    expect(collector.onTimeout).toHaveBeenCalledTimes(1)
  })

  it('passes through non-deadline ConnectErrors', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    const unknownError = new MockConnectError('internal error', 2)
    const next = vi.fn().mockRejectedValue(unknownError)
    const req = createReq()

    await expect(interceptor(next)(req)).rejects.toThrow(MockConnectError)
    await expect(interceptor(next)(req)).rejects.not.toThrow(SdkRequestTimeoutCredenceError)
  })

  it('passes through non-Connect errors', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    const next = vi.fn().mockRejectedValue(new Error('network failure'))
    const req = createReq()

    await expect(interceptor(next)(req)).rejects.toThrow('network failure')
    expect(collector.onTimeout).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Signal composition
  // -----------------------------------------------------------------------

  it('aborts the composed signal when parent signal aborts', async () => {
    vi.useRealTimers()
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    const parentController = new AbortController()
    const req = createReq({ signal: parentController.signal })
    let interceptedSignal: AbortSignal | undefined
    const next = vi.fn().mockImplementation((r: any) => {
      interceptedSignal = r.signal
      return new Promise((_, reject) => {
        const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'))
        r.signal.addEventListener('abort', onAbort, { once: true })
      })
    })

    const promise = interceptor(next)(req)
    parentController.abort()
    await expect(promise).rejects.toThrow()
    expect(interceptedSignal?.aborted).toBe(true)
  }, 10_000)

  it('cleans up timer and listener after successful call', async () => {
    const interceptor = createDeadlineInterceptor({ '*': 10_000 }, collector)
    const next = createSuccessNext()
    await interceptor(next)(createReq())

    // After resolution, the timer should not fire
    // If cleanup works, collector.onTimeout should NOT be called after advancement
    vi.advanceTimersByTime(20_000)
    expect(collector.onTimeout).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // isDeadlineExceededError
  // -----------------------------------------------------------------------

  it('isDeadlineExceededError detects ConnectError with DeadlineExceeded', () => {
    expect(isDeadlineExceededError(new MockConnectError('too slow', 4))).toBe(true)
    expect(isDeadlineExceededError(new MockConnectError('bad', 2))).toBe(false)
    expect(isDeadlineExceededError(new AbortError('aborted'))).toBe(true)
    expect(isDeadlineExceededError(new Error('generic'))).toBe(false)
    expect(isDeadlineExceededError(null)).toBe(false)
    expect(isDeadlineExceededError('string')).toBe(false)
  })
})
