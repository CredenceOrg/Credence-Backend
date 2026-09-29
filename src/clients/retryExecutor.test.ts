import { describe, expect, it, vi } from 'vitest'
import { executeWithRetry, type ExtendedRetryPolicy } from './retryExecutor.js'
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
})
