import { createHmac } from 'crypto'
import {
  getBackoffDelayMs,
  resolveProviderRetryPolicy,
  type ProviderRetryPolicies,
  type RetryJitterStrategy,
  type RetryPolicyOverrides,
} from '../../lib/retryPolicy.js'
import { logger } from '../../utils/logger.js'
import type { WebhookConfig, WebhookPayload, WebhookDeliveryResult } from './types.js'

/**
 * Options for webhook delivery.
 */
export interface DeliveryOptions {
  /** Maximum retry attempts (default: 3). */
  maxRetries?: number
  /** Initial retry delay in ms (default: 1000). */
  initialDelay?: number
  /** Backoff multiplier (default: 2). */
  backoffMultiplier?: number
  /** Maximum backoff delay in ms (default: 10000). */
  maxDelayMs?: number
  /** Delay jitter strategy (default: none). */
  jitterStrategy?: RetryJitterStrategy
  /** Request timeout in ms (default: 5000). */
  timeout?: number
  /** Provider-aware retry policy overrides. */
  retryPolicy?: RetryPolicyOverrides
  /** Global retry policy map keyed by provider. */
  retryPolicies?: ProviderRetryPolicies
  /** Provider label for logging/policy lookup. Defaults to webhook. */
  provider?: string
  /** Internal/test hook for custom timing behavior. */
  sleepFn?: (ms: number) => Promise<void>
  /** Internal/test hook for deterministic jitter. */
  randomFn?: () => number
  /** Internal/test hook for injected fetch implementation. */
  fetchFn?: typeof fetch
}

const DEFAULT_WEBHOOK_RETRY = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
  jitterStrategy: 'none',
} as const

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 */
export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

/**
 * Deliver webhook with retry and exponential backoff.
 */
export async function deliverWebhook(
  webhook: WebhookConfig,
  payload: WebhookPayload,
  options: DeliveryOptions = {}
): Promise<WebhookDeliveryResult> {
  const {
    maxRetries,
    initialDelay,
    backoffMultiplier,
    maxDelayMs,
    jitterStrategy,
    timeout = 5000,
    retryPolicy,
    retryPolicies,
    provider = 'webhook',
    sleepFn = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    randomFn = Math.random,
    fetchFn = fetch,
  } = options

  const legacyOverrides: RetryPolicyOverrides = {
    maxAttempts: maxRetries !== undefined ? maxRetries + 1 : undefined,
    baseDelayMs: initialDelay,
    maxDelayMs,
    backoffMultiplier,
    jitterStrategy,
  }

  const policy = resolveProviderRetryPolicy(provider, DEFAULT_WEBHOOK_RETRY, {
    providerPolicies: retryPolicies,
    overrides: {
      ...legacyOverrides,
      ...(retryPolicy ?? {}),
    },
  })

  const payloadStr = JSON.stringify(payload)
  
  // SUPPORT DUAL SIGNATURES DURING GRACE PERIOD
  const signatures: string[] = [signPayload(payloadStr, webhook.secret)]
  
  if (webhook.previousSecret) {
    const now = Date.now()
    const rotatedAt = webhook.secretUpdatedAt.getTime()
    if (now - rotatedAt < GRACE_PERIOD_MS) {
      signatures.push(signPayload(payloadStr, webhook.previousSecret))
    }
  }

  const signatureHeader = signatures.join(',')

  let attempts = 0
  let lastError: string | undefined
  let lastStatusCode: number | undefined
  let lastResponseBodySnippet: string | undefined

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    attempts = attempt
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetchFn(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signatureHeader,
          'X-Webhook-Event': payload.event,
        },
        body: payloadStr,
        signal: controller.signal,
      })

      if (response.ok) {
        return {
          webhookId: webhook.id,
          success: true,
          statusCode: response.status,
          attempts,
        }
      }

      lastStatusCode = response.status
      lastError = `HTTP ${response.status}`

      // Don't retry on 4xx errors (client errors)
      if (response.status >= 400 && response.status < 500) {
        break
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Unknown error'
    } finally {
      clearTimeout(timeoutId)
    }

    if (attempt < policy.maxAttempts) {
      const delay = getBackoffDelayMs(policy, attempt, randomFn)
      logger.info(
        `Retrying outbound request provider=${provider} attempt=${attempt + 1}/${policy.maxAttempts} delayMs=${delay} webhookId=${webhook.id} error=${lastError ?? 'unknown'}`,
      )
      await sleepFn(delay)
    }
  }

  return {
    webhookId: webhook.id,
    success: false,
    error: lastError,
    attempts,
    statusCode: lastStatusCode,
    responseBodySnippet: lastResponseBodySnippet,
  }
}
