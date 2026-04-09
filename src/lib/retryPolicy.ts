export type RetryJitterStrategy = 'none' | 'full' | 'equal'

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
  jitterStrategy: RetryJitterStrategy
}

export type RetryPolicyOverrides = Partial<RetryPolicy>

export interface ProviderRetryPolicies {
  default?: RetryPolicyOverrides
  providers?: Record<string, RetryPolicyOverrides | undefined>
}

export const RETRY_POLICY_HARD_CAPS = {
  maxAttempts: 10,
  baseDelayMs: 60_000,
  maxDelayMs: 300_000,
  backoffMultiplier: 10,
} as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function sanitizeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return value
}

function definedOnly(overrides: RetryPolicyOverrides | undefined): RetryPolicyOverrides {
  if (!overrides) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as RetryPolicyOverrides
}

export function enforceRetryPolicyCaps(policy: RetryPolicy): RetryPolicy {
  const boundedBaseDelay = clamp(
    sanitizeNumber(policy.baseDelayMs, 1),
    1,
    RETRY_POLICY_HARD_CAPS.baseDelayMs,
  )

  return {
    maxAttempts: clamp(
      sanitizeNumber(Math.floor(policy.maxAttempts), 1),
      1,
      RETRY_POLICY_HARD_CAPS.maxAttempts,
    ),
    baseDelayMs: boundedBaseDelay,
    maxDelayMs: clamp(
      sanitizeNumber(policy.maxDelayMs, boundedBaseDelay),
      boundedBaseDelay,
      RETRY_POLICY_HARD_CAPS.maxDelayMs,
    ),
    backoffMultiplier: clamp(
      sanitizeNumber(policy.backoffMultiplier, 1),
      1,
      RETRY_POLICY_HARD_CAPS.backoffMultiplier,
    ),
    jitterStrategy: policy.jitterStrategy,
  }
}

export function resolveProviderRetryPolicy(
  provider: string,
  defaults: RetryPolicy,
  options: {
    providerPolicies?: ProviderRetryPolicies
    overrides?: RetryPolicyOverrides
  } = {},
): RetryPolicy {
  const resolved: RetryPolicy = {
    ...defaults,
    ...definedOnly(options.providerPolicies?.default),
    ...definedOnly(options.providerPolicies?.providers?.[provider]),
    ...definedOnly(options.overrides),
  }

  return enforceRetryPolicyCaps(resolved)
}

export function getBackoffDelayMs(
  policy: RetryPolicy,
  attempt: number,
  randomFn: () => number = Math.random,
): number {
  const boundedAttempt = Math.max(1, Math.floor(attempt))
  const exponentialDelay =
    policy.baseDelayMs * Math.pow(policy.backoffMultiplier, Math.max(0, boundedAttempt - 1))
  const cappedDelay = Math.min(exponentialDelay, policy.maxDelayMs)

  if (policy.jitterStrategy === 'full') {
    return Math.floor(randomFn() * cappedDelay)
  }

  if (policy.jitterStrategy === 'equal') {
    const half = cappedDelay / 2
    return Math.floor(half + randomFn() * half)
  }

  return Math.floor(cappedDelay)
}

