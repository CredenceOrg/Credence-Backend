import { getBackoffDelayMs, type RetryPolicy, type RetryPolicyOverrides } from '../lib/retryPolicy.js'
import { type RetryObserver, noopRetryObserver } from '../observability/retryMetrics.js'
import { normalizeTransportError, isRetryableHttpStatus } from './httpErrors.js'
import { isRetryableRpcCode } from '../utils/retryClassifier.js'
import { logger } from '../utils/logger.js'

export interface ExtendedRetryPolicy extends RetryPolicy {
  retryableErrors?: string[]
  retryableStatusCodes?: number[]
  timeoutMs?: number
}

export interface ExtendedRetryPolicyOverrides extends RetryPolicyOverrides {
  retryableErrors?: string[]
  retryableStatusCodes?: number[]
  timeoutMs?: number
}

/**
 * Checks if the thrown error should trigger a retry.
 */
export function isErrorRetryable(
  error: any,
  config: {
    retryableErrors?: string[]
    retryableStatusCodes?: number[]
    providerName?: string
  } = {}
): boolean {
  if (error?.name === 'NonRetryableError') {
    return false
  }

  // 1. Check if the error message or code matches custom retryableErrors pattern
  if (config.retryableErrors && config.retryableErrors.length > 0) {
    const errorStr = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const errorCode = error?.code || error?.errorCode
    for (const pattern of config.retryableErrors) {
      if (
        (errorCode && String(errorCode).includes(pattern)) ||
        errorStr.includes(pattern)
      ) {
        return true
      }
    }
  }

  // 2. Check if it's a known transport / network / timeout error
  const transport = normalizeTransportError(error)
  if (transport !== null) {
    return true
  }

  // 3. Check HTTP status code
  const status = error?.status ?? error?.statusCode
  if (typeof status === 'number') {
    if (config.retryableStatusCodes && config.retryableStatusCodes.length > 0) {
      return config.retryableStatusCodes.includes(status)
    }
    // Default fallback: 408, 429, and >= 500
    return isRetryableHttpStatus(status)
  }

  // 4. Check RPC error code (e.g. for Soroban)
  const rpcCode = error?.rpcCode ?? error?.error?.code
  if (typeof rpcCode === 'number') {
    return isRetryableRpcCode(rpcCode)
  }

  return false
}

/**
 * Execute an operation with the given provider retry policy and observability hooks.
 */
export async function executeWithRetry<T>(
  provider: string,
  operation: (signal?: AbortSignal) => Promise<T>,
  options: {
    policy: ExtendedRetryPolicy
    retryObserver?: RetryObserver
    sleepFn?: (ms: number) => Promise<void>
    randomFn?: () => number
  }
): Promise<T> {
  const {
    policy,
    retryObserver = noopRetryObserver,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomFn = Math.random,
  } = options

  const maxAttempts = policy.maxAttempts
  const startMs = Date.now()
  let lastError: any = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    let timeoutId: any = null

    if (policy.timeoutMs !== undefined && policy.timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), policy.timeoutMs)
    }

    try {
      const result = await operation(controller.signal)
      
      if (timeoutId) {
        clearTimeout(timeoutId)
      }

      // Success hook
      retryObserver.onSuccess?.({
        provider,
        attempt,
        durationMs: Date.now() - startMs,
      })

      if (attempt > 1) {
        logger.info(
          `Outbound request succeeded provider=${provider} attempt=${attempt}/${maxAttempts} durationMs=${Date.now() - startMs}`
        )
      }

      return result
    } catch (error: any) {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }

      lastError = error

      // Check if we should retry
      const hasAttemptsRemaining = attempt < maxAttempts
      const shouldRetry = hasAttemptsRemaining && isErrorRetryable(error, {
        retryableErrors: policy.retryableErrors,
        retryableStatusCodes: policy.retryableStatusCodes,
        providerName: provider,
      })

      // Determine error code for metric/logging
      let errorCode = 'UNKNOWN'
      if (error instanceof Error) {
        const transport = normalizeTransportError(error)
        if (transport) {
          errorCode = transport.code
        } else if (error.name === 'AbortError' || error.message.includes('timeout')) {
          errorCode = 'TIMEOUT_ERROR'
        } else {
          errorCode = error.name || 'ERROR'
        }
      }
      const status = error?.status ?? error?.statusCode
      if (typeof status === 'number') {
        errorCode = `HTTP_${status}`
      }
      const rpcCode = error?.rpcCode ?? error?.error?.code
      if (typeof rpcCode === 'number') {
        errorCode = `RPC_${rpcCode}`
      }

      if (!shouldRetry) {
        retryObserver.onRetryExhausted?.({
          provider,
          attempts: attempt,
          errorCode,
        })
        throw error
      }

      const delay = getBackoffDelayMs(policy, attempt, randomFn)
      
      // Observability hook
      retryObserver.onRetryAttempt?.({
        provider,
        attempt,
        delayMs: delay,
        errorCode,
      })

      logger.info(
        `Retrying outbound request provider=${provider} attempt=${attempt + 1}/${maxAttempts} delayMs=${delay} error=${error.message || error}`
      )

      await sleepFn(delay)
    }
  }

  // If we loop out, we exhausted all retries
  let finalErrorCode = 'UNKNOWN'
  if (lastError instanceof Error) {
    const transport = normalizeTransportError(lastError)
    if (transport) {
      finalErrorCode = transport.code
    } else {
      finalErrorCode = lastError.name || 'ERROR'
    }
  }
  const status = lastError?.status ?? lastError?.statusCode
  if (typeof status === 'number') {
    finalErrorCode = `HTTP_${status}`
  }
  const rpcCode = lastError?.rpcCode ?? lastError?.error?.code
  if (typeof rpcCode === 'number') {
    finalErrorCode = `RPC_${rpcCode}`
  }

  retryObserver.onRetryExhausted?.({
    provider,
    attempts: maxAttempts,
    errorCode: finalErrorCode,
  })

  throw lastError
}

import { resolveProviderRetryPolicy, type ProviderRetryPolicies } from '../lib/retryPolicy.js'

export function resolveExtendedProviderRetryPolicy(
  provider: string,
  defaults: ExtendedRetryPolicy,
  options: {
    providerPolicies?: ProviderRetryPolicies
    overrides?: ExtendedRetryPolicyOverrides
  } = {}
): ExtendedRetryPolicy {
  const baseResolved = resolveProviderRetryPolicy(provider, defaults, options)

  const resolved: ExtendedRetryPolicy = {
    ...baseResolved,
    retryableErrors: options.overrides?.retryableErrors ?? (options.providerPolicies?.providers?.[provider] as any)?.retryableErrors ?? (options.providerPolicies?.default as any)?.retryableErrors ?? defaults.retryableErrors,
    retryableStatusCodes: options.overrides?.retryableStatusCodes ?? (options.providerPolicies?.providers?.[provider] as any)?.retryableStatusCodes ?? (options.providerPolicies?.default as any)?.retryableStatusCodes ?? defaults.retryableStatusCodes,
    timeoutMs: options.overrides?.timeoutMs ?? (options.providerPolicies?.providers?.[provider] as any)?.timeoutMs ?? (options.providerPolicies?.default as any)?.timeoutMs ?? defaults.timeoutMs,
  }

  return resolved
}

