import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  RETRY_POLICY_HARD_CAPS,
  getBackoffDelayMs,
  resolveProviderRetryPolicy,
  type RetryJitterStrategy,
  type RetryPolicy,
} from './retryPolicy.js'

const defaultPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  backoffMultiplier: 2,
  jitterStrategy: 'none',
}

describe('resolveProviderRetryPolicy', () => {
  it('resolves provider overrides over defaults and global overrides', () => {
    const policy = resolveProviderRetryPolicy('soroban', defaultPolicy, {
      providerPolicies: {
        default: {
          baseDelayMs: 150,
        },
        providers: {
          soroban: {
            maxAttempts: 5,
            jitterStrategy: 'full',
          },
        },
      },
      overrides: {
        maxDelayMs: 700,
      },
    })

    expect(policy).toEqual({
      maxAttempts: 5,
      baseDelayMs: 150,
      maxDelayMs: 700,
      backoffMultiplier: 2,
      jitterStrategy: 'full',
    })
  })

  it('enforces hard caps to prevent unbounded retries', () => {
    const policy = resolveProviderRetryPolicy('webhook', defaultPolicy, {
      overrides: {
        maxAttempts: 999,
        baseDelayMs: 9999999,
        maxDelayMs: 9999999,
        backoffMultiplier: 999,
      },
    })

    expect(policy.maxAttempts).toBe(RETRY_POLICY_HARD_CAPS.maxAttempts)
    expect(policy.baseDelayMs).toBe(RETRY_POLICY_HARD_CAPS.baseDelayMs)
    expect(policy.maxDelayMs).toBe(RETRY_POLICY_HARD_CAPS.maxDelayMs)
    expect(policy.backoffMultiplier).toBe(RETRY_POLICY_HARD_CAPS.backoffMultiplier)
  })
})

describe('getBackoffDelayMs', () => {
  it('returns deterministic exponential backoff without jitter', () => {
    expect(getBackoffDelayMs(defaultPolicy, 1)).toBe(100)
    expect(getBackoffDelayMs(defaultPolicy, 2)).toBe(200)
    expect(getBackoffDelayMs(defaultPolicy, 3)).toBe(400)
  })

  it('applies full jitter', () => {
    const delay = getBackoffDelayMs(
      { ...defaultPolicy, jitterStrategy: 'full' },
      2,
      () => 0.5,
    )

    expect(delay).toBe(100)
  })

  it('applies equal jitter', () => {
    const delay = getBackoffDelayMs(
      { ...defaultPolicy, jitterStrategy: 'equal' },
      2,
      () => 0.5,
    )

    expect(delay).toBe(150)
  })

  it('applies decorrelated jitter', () => {
    const delay = getBackoffDelayMs(
      { ...defaultPolicy, jitterStrategy: 'decorrelated' },
      2,
      () => 0.5,
      200,
    )

    expect(delay).toBe(200)
  })

  it('decorrelated jitter defaults previousDelayMs to baseDelayMs', () => {
    const delay = getBackoffDelayMs(
      { ...defaultPolicy, jitterStrategy: 'decorrelated' },
      1,
      () => 0,
    )

    expect(delay).toBe(100)
  })

  it('caps exponential growth at maxDelayMs', () => {
    const delay = getBackoffDelayMs(
      { ...defaultPolicy, maxDelayMs: 250 },
      4,
    )

    expect(delay).toBe(250)
  })

  describe('fast-check property tests', () => {
    const strategies: RetryJitterStrategy[] = ['none', 'full', 'equal', 'decorrelated']

    it('all strategies produce delays <= maxDelayMs', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...strategies),
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 50, max: 200 }),
          fc.integer({ min: 200, max: 1000 }),
          fc.double({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
          (strategy, attempt, baseDelayMs, maxDelayMs, rngValue) => {
            const policy: RetryPolicy = {
              maxAttempts: 10,
              baseDelayMs,
              maxDelayMs,
              backoffMultiplier: 2,
              jitterStrategy: strategy,
            }
            const delay = getBackoffDelayMs(policy, attempt, () => rngValue, baseDelayMs)
            expect(delay).toBeGreaterThanOrEqual(0)
            expect(delay).toBeLessThanOrEqual(maxDelayMs)
          },
        ),
      )
    })

    it('full jitter delay ∈ [0, cappedDelay]', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.integer({ min: 50, max: 500 }),
          fc.integer({ min: 500, max: 2000 }),
          fc.double({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
          (attempt, baseDelayMs, maxDelayMs, rngValue) => {
            const policy: RetryPolicy = {
              maxAttempts: 10,
              baseDelayMs,
              maxDelayMs,
              backoffMultiplier: 2,
              jitterStrategy: 'full',
            }
            const cappedDelay = Math.min(
              maxDelayMs,
              baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
            )
            const delay = getBackoffDelayMs(policy, attempt, () => rngValue)
            expect(delay).toBeGreaterThanOrEqual(0)
            expect(delay).toBeLessThanOrEqual(cappedDelay)
          },
        ),
      )
    })

    it('equal jitter delay ∈ [cappedDelay/2, cappedDelay]', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.integer({ min: 50, max: 500 }),
          fc.integer({ min: 500, max: 2000 }),
          fc.double({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
          (attempt, baseDelayMs, maxDelayMs, rngValue) => {
            const policy: RetryPolicy = {
              maxAttempts: 10,
              baseDelayMs,
              maxDelayMs,
              backoffMultiplier: 2,
              jitterStrategy: 'equal',
            }
            const cappedDelay = Math.min(
              maxDelayMs,
              baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
            )
            const delay = getBackoffDelayMs(policy, attempt, () => rngValue)
            expect(delay).toBeGreaterThanOrEqual(Math.floor(cappedDelay / 2))
            expect(delay).toBeLessThanOrEqual(cappedDelay)
          },
        ),
      )
    })

    it('decorrelated jitter delay ∈ [baseDelayMs, cappedDelay]', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.integer({ min: 50, max: 200 }),
          fc.integer({ min: 500, max: 2000 }),
          fc.double({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
          (attempt, baseDelayMs, maxDelayMs, rngValue) => {
            const policy: RetryPolicy = {
              maxAttempts: 10,
              baseDelayMs,
              maxDelayMs,
              backoffMultiplier: 2,
              jitterStrategy: 'decorrelated',
            }
            const cappedDelay = Math.min(
              maxDelayMs,
              baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
            )
            const delay = getBackoffDelayMs(policy, attempt, () => rngValue, baseDelayMs)
            expect(delay).toBeGreaterThanOrEqual(baseDelayMs)
            expect(delay).toBeLessThanOrEqual(cappedDelay)
          },
        ),
      )
    })

    it('all strategies respect jitterStrategy: none as deterministic cap', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 50, max: 500 }),
          fc.integer({ min: 500, max: 2000 }),
          (attempt, baseDelayMs, maxDelayMs) => {
            const policy: RetryPolicy = {
              maxAttempts: 10,
              baseDelayMs,
              maxDelayMs,
              backoffMultiplier: 2,
              jitterStrategy: 'none',
            }
            const cappedDelay = Math.min(
              maxDelayMs,
              baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
            )
            const delay = getBackoffDelayMs(policy, attempt)
            expect(delay).toBe(Math.floor(cappedDelay))
          },
        ),
      )
    })
  })
})

