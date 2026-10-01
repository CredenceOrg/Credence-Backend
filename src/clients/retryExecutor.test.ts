import { describe, expect, it, vi } from 'vitest'
import { executeWithRetry, type ExtendedRetryPolicy } from './retryExecutor.js'
import { executeWithRetry as executeWithRetryExample } from '../examples/retryExecutor.js'
import type { RetryObserver } from '../observability/retryMetrics.js'

const basePolicy: ExtendedRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 100,
  backoffMultiplier: 2,
  jitterStrategy: 'none',
}

function makePolicy(overrides: Partial<ExtendedRetryPolicy> = {}): ExtendedRetryPolicy {
  return { ...basePolicy, ...overrides }
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

function observer(): Required<Pick<RetryObserver, 'onRetryAttempt' | 'onRetryExhausted' | 'onSuccess'>> {
  return {
    onRetryAttempt: vi.fn(),
    onRetryExhausted: vi.fn(),
    onSuccess: vi.fn(),
  }
}

describe('executeWithRetry', () => {
  it('returns the first result without sleeping or retrying', async () => {
    const operation = vi.fn(async (signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(false)
      return 'ok'
    })
    const sleepFn = vi.fn(async () => {})
    const retryObserver = observer()

    await expect(
      executeWithRetry('test-provider', operation, {
        policy: makePolicy(),
        sleepFn,
        retryObserver,
      }),
    ).resolves.toBe('ok')

    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
    expect(retryObserver.onRetryAttempt).not.toHaveBeenCalled()
    expect(retryObserver.onRetryExhausted).not.toHaveBeenCalled()
    expect(retryObserver.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'test-provider', attempt: 1 }),
    )
  })

  it('recovers after a retryable failure and records the recovery attempt', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce('recovered')
    const sleepFn = vi.fn(async () => {})
    const retryObserver = observer()

    await expect(
      executeWithRetry('webhook', operation, {
        policy: makePolicy(),
        sleepFn,
        retryObserver,
      }),
    ).resolves.toBe('recovered')

    expect(operation).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalledWith(10)
    expect(retryObserver.onRetryAttempt).toHaveBeenCalledWith({
      provider: 'webhook',
      attempt: 1,
      delayMs: 10,
      errorCode: 'HTTP_503',
    })
    expect(retryObserver.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'webhook', attempt: 2 }),
    )
    expect(retryObserver.onRetryExhausted).not.toHaveBeenCalled()
  })

  it('uses the configured backoff and makes no attempt beyond exhaustion', async () => {
    const terminalError = httpError(503)
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(terminalError)
    const sleepFn = vi.fn(async () => {})
    const retryObserver = observer()

    await expect(
      executeWithRetry('soroban', operation, {
        policy: makePolicy({ maxAttempts: 3 }),
        sleepFn,
        retryObserver,
      }),
    ).rejects.toBe(terminalError)

    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleepFn.mock.calls.map(([delay]) => delay)).toEqual([10, 20])
    expect(retryObserver.onRetryAttempt).toHaveBeenCalledTimes(2)
    expect(retryObserver.onRetryExhausted).toHaveBeenCalledWith({
      provider: 'soroban',
      attempts: 3,
      errorCode: 'HTTP_503',
    })
  })

  it('treats one allowed attempt as the retry boundary', async () => {
    const error = httpError(503)
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error)
    const sleepFn = vi.fn(async () => {})
    const retryObserver = observer()

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 1 }),
        sleepFn,
        retryObserver,
      }),
    ).rejects.toBe(error)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
    expect(retryObserver.onRetryAttempt).not.toHaveBeenCalled()
    expect(retryObserver.onRetryExhausted).toHaveBeenCalledWith({
      provider: 'provider',
      attempts: 1,
      errorCode: 'HTTP_503',
    })
  })

  it('does not retry a terminal application error', async () => {
    const error = new Error('invalid request')
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error)
    const sleepFn = vi.fn(async () => {})
    const retryObserver = observer()

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 5 }),
        sleepFn,
        retryObserver,
      }),
    ).rejects.toBe(error)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
    expect(retryObserver.onRetryExhausted).toHaveBeenCalledWith({
      provider: 'provider',
      attempts: 1,
      errorCode: 'Error',
    })
  })

  it('does not retry a status excluded by an explicit status allowlist', async () => {
    const error = httpError(503)
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error)
    const retryObserver = observer()

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ retryableStatusCodes: [429] }),
        sleepFn: vi.fn(async () => {}),
        retryObserver,
      }),
    ).rejects.toBe(error)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(retryObserver.onRetryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 1, errorCode: 'HTTP_503' }),
    )
  })

  it('retries a matching custom error pattern', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('service busy'), { code: 'E_BUSY' }))
      .mockResolvedValueOnce('ok')

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ retryableErrors: ['E_BUSY'] }),
        sleepFn: vi.fn(async () => {}),
      }),
    ).resolves.toBe('ok')

    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('does not retry an explicitly non-retryable error', async () => {
    const error = Object.assign(new Error('provider rejected request'), {
      name: 'NonRetryableError',
      code: 'E_BUSY',
    })
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error)

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ retryableErrors: ['E_BUSY'] }),
        sleepFn: vi.fn(async () => {}),
      }),
    ).rejects.toBe(error)

    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('aborts a timed-out attempt and reports a retryable timeout failure', async () => {
    vi.useFakeTimers()
    try {
      const retryObserver = observer()
      const operation = vi.fn(
        (signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            )
          }),
      )
      const promise = executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 1, timeoutMs: 25 }),
        retryObserver,
        sleepFn: vi.fn(async () => {}),
      })
      const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })

      await vi.advanceTimersByTimeAsync(25)
      await rejection
      expect(operation).toHaveBeenCalledTimes(1)
      expect(retryObserver.onRetryExhausted).toHaveBeenCalledWith({
        provider: 'provider',
        attempts: 1,
        errorCode: 'TIMEOUT',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps independent concurrent executions isolated', async () => {
    const attempts = new Map<string, number>()
    const operation = (key: string) => async () => {
      const count = (attempts.get(key) ?? 0) + 1
      attempts.set(key, count)
      if (key === 'first' && count === 1) throw httpError(503)
      return `${key}-${count}`
    }
    const sleepFn = vi.fn(async () => {})

    await expect(
      Promise.all([
        executeWithRetry('first', operation('first'), {
          policy: makePolicy(),
          sleepFn,
        }),
        executeWithRetry('second', operation('second'), {
          policy: makePolicy(),
          sleepFn,
        }),
      ]),
    ).resolves.toEqual(['first-2', 'second-1'])

    expect(attempts).toEqual(new Map([
      ['first', 2],
      ['second', 1],
    ]))
  })

  it('rejects a zero-attempt policy without invoking the operation', async () => {
    const operation = vi.fn<() => Promise<string>>().mockResolvedValue('never')
    const sleepFn = vi.fn(async () => {})
    const retryObserver = observer()

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 0 }),
        sleepFn,
        retryObserver,
      }),
    ).rejects.toThrow(/maxAttempts/)

    expect(operation).not.toHaveBeenCalled()
    expect(sleepFn).not.toHaveBeenCalled()
    expect(retryObserver.onRetryAttempt).not.toHaveBeenCalled()
    expect(retryObserver.onRetryExhausted).not.toHaveBeenCalled()
    expect(retryObserver.onSuccess).not.toHaveBeenCalled()
  })

  it('rejects a negative-attempt policy without invoking the operation', async () => {
    const operation = vi.fn<() => Promise<string>>().mockResolvedValue('never')

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: -1 }),
        sleepFn: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/maxAttempts/)

    expect(operation).not.toHaveBeenCalled()
  })

  it('rejects a non-integer attempt policy without invoking the operation', async () => {
    const operation = vi.fn<() => Promise<string>>().mockResolvedValue('never')

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 2.5 }),
        sleepFn: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/maxAttempts/)

    expect(operation).not.toHaveBeenCalled()
  })

  it('rejects a negative base delay without invoking the operation', async () => {
    const operation = vi.fn<() => Promise<string>>().mockResolvedValue('never')

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ baseDelayMs: -1 }),
        sleepFn: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/baseDelayMs/)

    expect(operation).not.toHaveBeenCalled()
  })

  it('rejects a negative timeout without invoking the operation', async () => {
    const operation = vi.fn<() => Promise<string>>().mockResolvedValue('never')

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ timeoutMs: -1 }),
        sleepFn: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/timeoutMs/)

    expect(operation).not.toHaveBeenCalled()
  })

  it('clamps the backoff delay to maxDelayMs across many attempts', async () => {
    const error = httpError(503)
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error)
    const sleepFn = vi.fn(async () => {})

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({
          maxAttempts: 6,
          baseDelayMs: 10,
          maxDelayMs: 25,
          backoffMultiplier: 2,
        }),
        sleepFn,
      }),
    ).rejects.toBe(error)

    expect(operation).toHaveBeenCalledTimes(6)
    expect(sleepFn.mock.calls.map(([delay]) => delay)).toEqual([10, 20, 25, 25, 25])
  })

  it('honors a zero base delay without sleeping between attempts', async () => {
    const error = httpError(503)
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error)
    const sleepFn = vi.fn(async () => {})

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 3, baseDelayMs: 0 }),
        sleepFn,
      }),
    ).rejects.toBe(error)

    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleepFn.mock.calls.map(([delay]) => delay)).toEqual([0, 0])
  })

  it('honors a zero timeout as an immediate abort boundary', async () => {
    vi.useFakeTimers()
    try {
      const retryObserver = observer()
      const operation = vi.fn(
        (signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            )
          }),
      )
      const promise = executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 1, timeoutMs: 0 }),
        retryObserver,
        sleepFn: vi.fn(async () => {}),
      })
      const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })

      await vi.advanceTimersByTimeAsync(0)
      await rejection
      expect(operation).toHaveBeenCalledTimes(1)
      expect(retryObserver.onRetryExhausted).toHaveBeenCalledWith({
        provider: 'provider',
        attempts: 1,
        errorCode: 'TIMEOUT',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers after exhausting retries when the operation later succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce('late-success')
    const sleepFn = vi.fn(async () => {})
    const retryObserver = observer()

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 3 }),
        sleepFn,
        retryObserver,
      }),
    ).resolves.toBe('late-success')

    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleepFn.mock.calls.map(([delay]) => delay)).toEqual([10, 20])
    expect(retryObserver.onRetryAttempt).toHaveBeenCalledTimes(2)
    expect(retryObserver.onRetryExhausted).not.toHaveBeenCalled()
    expect(retryObserver.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'provider', attempt: 3 }),
    )
  })

  it('propagates the original error when the sleep function rejects', async () => {
    const error = httpError(503)
    const sleepError = new Error('sleep interrupted')
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error)
    const sleepFn = vi.fn(async () => {
      throw sleepError
    })

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 3 }),
        sleepFn,
      }),
    ).rejects.toBe(sleepError)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleepFn).toHaveBeenCalledTimes(1)
  })

  it('does not retry after the caller aborts via an external signal', async () => {
    const controller = new AbortController()
    const retryObserver = observer()
    const operation = vi.fn(async (signal?: AbortSignal) => {
      controller.abort()
      if (signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      throw httpError(503)
    })
    const sleepFn = vi.fn(async () => {})

    await expect(
      executeWithRetry('provider', operation, {
        policy: makePolicy({ maxAttempts: 5 }),
        signal: controller.signal,
        sleepFn,
        retryObserver,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
    expect(retryObserver.onRetryAttempt).not.toHaveBeenCalled()
  })

  it('exposes the example retry executor with the same recovery semantics', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce('example-ok')
    const sleepFn = vi.fn(async () => {})

    await expect(
      executeWithRetryExample('example', operation, {
        policy: makePolicy(),
        sleepFn,
      }),
    ).resolves.toBe('example-ok')

    expect(operation).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalledWith(10)
  })
})
