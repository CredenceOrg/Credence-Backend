import { describe, it, expect } from 'vitest'
import {
  RETRY_POLICY_HARD_CAPS,
  getBackoffDelayMs,
  resolveProviderRetryPolicy,
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

  it('caps exponential growth at maxDelayMs', () => {
    const delay = getBackoffDelayMs(
      { ...defaultPolicy, maxDelayMs: 250 },
      4,
    )

    expect(delay).toBe(250)
  })
})

