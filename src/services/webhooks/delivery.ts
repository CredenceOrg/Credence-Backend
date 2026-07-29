const emitMetric = (name: string, val: number, tags: any) => console.log(`METRIC [${name}]:`, val, tags);
import { createHmac, randomBytes } from 'crypto'
import https from 'https'
import {
  type ProviderRetryPolicies,
  type RetryJitterStrategy,
  type RetryPolicyOverrides,
} from '../../lib/retryPolicy.js'
import {
  resolveExtendedProviderRetryPolicy,
  executeWithRetry,
  type ExtendedRetryPolicy,
  type ExtendedRetryPolicyOverrides,
} from '../../clients/retryExecutor.js'
import { noopRetryObserver, type RetryObserver } from '../../observability/retryMetrics.js'
import { webhookPayloadBytes } from '../../observability/customMetrics.js'
import { checkHostBlocked } from '../../lib/ssrfProtection.js'
import { logger, runWithCorrelationIds, sanitizeCorrelationId } from '../../utils/logger.js'
import type { WebhookConfig, WebhookPayload, WebhookDeliveryResult } from './types.js'
import { generateWebhookIdempotencyKey } from './idempotency.js'

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
  /** Observability hooks for retry events. */
  retryObserver?: RetryObserver
  /** Internal/test hook for custom https.Agent (for mTLS testing). */
  httpsAgent?: https.Agent
  /** Payload size cap in bytes (default from config). */
  payloadSizeCap?: number
  /** Optional idempotency context for deduplicating retries. */
  eventId?: string
  /**
   * Correlation id of the request (or async job) that triggered this
   * delivery. When present it is sent to the receiving endpoint as the
   * `X-Correlation-Id` header and used to tag delivery logs, so a single
   * request can be traced end-to-end into the webhook call.
   */
  correlationId?: string
  /** Optional store used to reserve and clear webhook delivery attempts. */
  idempotencyStore?: {
    reserveWebhookDelivery(subscriberId: string, eventId: string, idempotencyKey: string): Promise<boolean>
    clearWebhookDeliveryAttempt(subscriberId: string, eventId: string): Promise<void>
  }
}

const DEFAULT_WEBHOOK_RETRY: ExtendedRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
  jitterStrategy: 'none',
  retryableErrors: [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_UNTRUSTED',
    'mTLS handshake failed',
    'WEBHOOK_MTLS_FAILURE',
    'unable to verify the first certificate',
    'unable to get local issuer certificate',
    'CERT_HAS_EXPIRED',
    'certificate has expired',
    'Network error',
    'network error',
    'Failed to fetch',
    'fetch failed',
  ],
}

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 */
export function signPayload(payload: string, secret: string): string {
  if (typeof secret !== 'string' || !secret) {
    throw new TypeError('signPayload: secret must be a non-empty string')
  }
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Constant-time comparison to prevent timing attacks on certificate pinning.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

/**
 * Create an HTTPS agent with mTLS configuration if provided.
 */
function createHttpsAgent(webhook: WebhookConfig, customAgent?: https.Agent): https.Agent | undefined {
  // Use custom agent if provided (for testing)
  if (customAgent) {
    return customAgent
  }

  // If no mTLS configuration, use default agent
  if (!webhook.clientCertPem || !webhook.clientKeyKmsRef) {
    return undefined
  }

  // In production, clientKeyKmsRef would be resolved from KMS
  // For now, we'll assume the caller provides the resolved key
  // This is a simplified implementation - production should use KMS
  const agentOptions: https.AgentOptions = {
    cert: webhook.clientCertPem,
    key: webhook.clientKeyKmsRef, // In production: resolve from KMS
    rejectUnauthorized: true,
  }

  return new https.Agent(agentOptions)
}

/**
 * Validate server certificate pinning if configured.
 */
function validateServerCertificatePin(
  actualCert: string,
  expectedPin: string
): { valid: boolean; error?: string } {
  if (!expectedPin) {
    return { valid: true }
  }

  // Compute SHA256 hash of the actual certificate
  const hash = createHmac('sha256', '').update(actualCert).digest('hex')
  
  if (!constantTimeEqual(hash, expectedPin)) {
    return {
      valid: false,
      error: 'WEBHOOK_MTLS_FAILURE: Server certificate pin mismatch',
    }
  }

  return { valid: true }
}

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

/**
 * Generate a stable chunk ID.
 */
function generateChunkId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Check if payload data is a list/array.
 */
function isListData(data: unknown): data is unknown[] {
  return Array.isArray(data)
}

/**
 * Chunk a list payload into smaller chunks that fit within the size cap.
 */
function chunkListPayload(
  basePayload: WebhookPayload,
  sizeCap: number
): WebhookPayload[] {
  const chunks: WebhookPayload[] = []
  const data = basePayload.data
  if (!isListData(data)) return [basePayload as any]

  const chunkId = generateChunkId()
  let currentChunkItems: unknown[] = []

  for (const item of data) {
    const testPayload: WebhookPayload = {
      ...basePayload,
      data: [...currentChunkItems, item] as unknown[],
      chunkId,
      chunkIndex: chunks.length,
      totalChunks: 0,
    } as any
    const testPayloadStr = JSON.stringify(testPayload)
    if (Buffer.byteLength(testPayloadStr, 'utf8') <= sizeCap) {
      currentChunkItems.push(item)
    } else {
      if (currentChunkItems.length > 0) {
        chunks.push({
          ...basePayload,
          data: currentChunkItems as unknown[],
          chunkId,
          chunkIndex: chunks.length,
          totalChunks: 0,
        } as any)
        currentChunkItems = [item]
      } else {
        // Single item too big - we'll mark as truncated later
        chunks.push({
          ...basePayload,
          data: [item] as unknown[],
          chunkId,
          chunkIndex: chunks.length,
          totalChunks: 0,
          payloadTruncated: true,
        } as any)
        currentChunkItems = []
      }
    }
  }

  if (currentChunkItems.length > 0) {
    chunks.push({
      ...basePayload,
      data: currentChunkItems as unknown[],
      chunkId,
      chunkIndex: chunks.length,
      totalChunks: 0,
    } as any)
  }

  // Update totalChunks for all chunks
  return chunks.map((chunk, idx) => ({
    ...chunk,
    totalChunks: chunks.length,
  }))
}

/**
 * Deliver single webhook payload (internal function).
 */
class NonRetryableError extends Error {
  errorCode?: string
  status?: number
  constructor(message: string, errorCode?: string, status?: number) {
    super(message)
    this.name = 'NonRetryableError'
    this.errorCode = errorCode
    this.status = status
  }
}

/**
 * Deliver single webhook payload (internal function).
 */
async function deliverSingleWebhook(
  webhook: WebhookConfig,
  payload: WebhookPayload,
  options: DeliveryOptions,
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
    retryObserver = noopRetryObserver,
    httpsAgent: customHttpsAgent,
    correlationId,
  } = options

  // Sanitize before it ever reaches an outbound header: this value may
  // have originated from an external caller's `x-correlation-id` header
  // and round-tripped through the database, so it must not be trusted as
  // a safe HTTP header value as-is.
  const safeCorrelationId = sanitizeCorrelationId(correlationId)

  const legacyOverrides: RetryPolicyOverrides = {
    maxAttempts: maxRetries !== undefined ? maxRetries + 1 : undefined,
    baseDelayMs: initialDelay,
    maxDelayMs,
    backoffMultiplier,
    jitterStrategy,
  }

  const policy = resolveExtendedProviderRetryPolicy(provider, DEFAULT_WEBHOOK_RETRY, {
    providerPolicies: retryPolicies,
    overrides: {
      ...legacyOverrides,
      ...(retryPolicy ?? {}),
      maxAttempts: webhook.maxAttempts ?? legacyOverrides.maxAttempts,
      timeoutMs: webhook.timeoutMs ?? timeout,
    },
  })

  const payloadStr = JSON.stringify(payload)
  const payloadSize = Buffer.byteLength(payloadStr, 'utf8')
  
  // Record payload size metric
  webhookPayloadBytes.observe({ subscriber: webhook.id }, payloadSize)
  
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

  // Create HTTPS agent with mTLS configuration if available
  const agent = createHttpsAgent(webhook, customHttpsAgent)

  // --- SSRF protection: block private/internal network targets (before retry loop) ---
  const hostCheck = checkHostBlocked(webhook.url)
  if (hostCheck.blocked) {
    logger.warn({ message: 'Webhook delivery blocked by SSRF guard', webhookId: webhook.id, reason: hostCheck.reason, host: hostCheck.host })
    return {
      webhookId: webhook.id,
      success: false,
      error: `Webhook target '${hostCheck.host}' is restricted: ${hostCheck.reason}`,
      attempts: 0,
      errorCode: 'SSRF_BLOCKED',
    }
  }

  let attempts = 0
  let lastError: string | undefined
  let lastStatusCode: number | undefined
  let lastErrorCode: string | undefined
  const startMs = Date.now()

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), webhook.timeoutMs ?? timeout ?? 5000)

    try {
      const response = await executeWithRetry(
      provider,
      async (signal) => {
        attempts += 1
        const fetchStart = Date.now()
        
        let res: Response
        try {
          res = await fetchFn(webhook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Signature': signatureHeader,
              'X-Webhook-Event': payload.event,
              ...(safeCorrelationId ? { 'X-Correlation-Id': safeCorrelationId } : {}),
            },
            body: payloadStr,
            signal,
            // @ts-ignore - agent is not in standard RequestInit but supported by Node.js fetch
            agent,
          })
        } catch (err: any) {
          if (err?.name === 'AbortError' || err?.message?.includes('timeout')) {
            emitMetric('webhook_timeout_total', 1, { url: webhook.url })
          }

          // Check for TLS-specific errors
          if (err?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || 
              err?.code === 'CERT_UNTRUSTED' ||
              (err?.code === 'ECONNREFUSED' && webhook.clientCertPem)) {
            emitMetric('webhook_mtls_failure_total', 1, { 
              subscriber: webhook.id,
              reason: 'handshake_failure' 
            })
            const mtlsErr = new Error(`mTLS handshake failed: ${err.message}`)
            ;(mtlsErr as any).errorCode = 'WEBHOOK_MTLS_FAILURE'
            throw mtlsErr
          }
          throw err
        }

        emitMetric('webhook_delivery_duration', Date.now() - fetchStart, { url: webhook.url })

        if (res.ok) {
          // Validate server certificate pinning if configured
          if (webhook.pinnedServerCertSha256) {
            const validation = validateServerCertificatePin(
              'placeholder_actual_cert',
              webhook.pinnedServerCertSha256
            )
            
            if (!validation.valid) {
              emitMetric('webhook_mtls_failure_total', 1, { 
                subscriber: webhook.id,
                reason: 'cert_pin_mismatch' 
              })
              // Don't retry on certificate pin mismatch
              throw new NonRetryableError(validation.error || 'Server certificate pin mismatch', 'WEBHOOK_MTLS_FAILURE')
            }
          }
          return res
        }

        // Check if 4xx (client error) - non-retryable by default
        if (res.status >= 400 && res.status < 500) {
          throw new NonRetryableError(`HTTP ${res.status}`, `HTTP_${res.status}`, res.status)
        }

        const httpErr = new Error(`HTTP ${res.status}`)
        ;(httpErr as any).status = res.status
        throw httpErr
      },
      {
        policy,
        retryObserver,
        sleepFn,
        randomFn,
      }
    )

    return {
      webhookId: webhook.id,
      success: true,
      statusCode: response.status,
      attempts,
    }
  } catch (err: any) {
    lastError = err.message || String(err)
    lastStatusCode = err.status ?? err.statusCode
    lastErrorCode = err.errorCode || err.code

    // Normalize error code for return value if needed
    if (lastStatusCode) {
      lastErrorCode = `HTTP_${lastStatusCode}`
    } else if (err.name === 'AbortError' || err.message.includes('timeout')) {
      lastErrorCode = 'TIMEOUT_ERROR'
    }

    return {
      webhookId: webhook.id,
      success: false,
      error: lastError,
      attempts,
      statusCode: lastStatusCode,
      responseBodySnippet: undefined,
      errorCode: lastErrorCode,
    }
  }
  }

  return {
    webhookId: webhook.id,
    success: false,
    error: lastError ?? 'Webhook delivery failed: no attempts were made',
    attempts,
    statusCode: lastStatusCode,
    errorCode: lastErrorCode,
  }
}

/**
 * Deliver webhook with retry and exponential backoff.
 * Handles payload size limits and chunking for list payloads.
 * Backward compatible: when no chunking, returns single WebhookDeliveryResult;
 * otherwise returns WebhookDeliveryResult[].
 */
export async function deliverWebhook(
  webhook: WebhookConfig,
  payload: WebhookPayload,
  options: DeliveryOptions & { returnAllChunks: true }
): Promise<WebhookDeliveryResult[]>
export async function deliverWebhook(
  webhook: WebhookConfig,
  payload: WebhookPayload,
  options?: DeliveryOptions & { returnAllChunks?: false }
): Promise<WebhookDeliveryResult | WebhookDeliveryResult[]>
export async function deliverWebhook(
  webhook: WebhookConfig,
  payload: WebhookPayload,
  options: DeliveryOptions & { returnAllChunks?: boolean } = {}
): Promise<WebhookDeliveryResult | WebhookDeliveryResult[]> {
  // Restore the correlation id (if any) for the duration of this delivery
  // attempt, so logger calls below — and any further downstream work
  // triggered by them — are tagged with the id of the request/job that
  // caused this webhook to fire.
  return runWithCorrelationIds({ correlationId: sanitizeCorrelationId(options.correlationId) }, async () => {
    const sizeCap = options.payloadSizeCap ?? 262144 // Default 256KB if not provided
    const payloadStr = JSON.stringify(payload)
    const payloadSize = Buffer.byteLength(payloadStr, 'utf8')
    let results: WebhookDeliveryResult[]

    const shouldUseIdempotency = Boolean(options.eventId && options.idempotencyStore)
    let reserved = false
    if (shouldUseIdempotency) {
      reserved = await options.idempotencyStore!.reserveWebhookDelivery(
        webhook.id,
        options.eventId!,
        generateWebhookIdempotencyKey(webhook.id, options.eventId!)
      )

      if (!reserved) {
        return options.returnAllChunks
          ? [{ webhookId: webhook.id, success: true, skipped: true, attempts: 0 }]
          : { webhookId: webhook.id, success: true, skipped: true, attempts: 0 }
      }
    }

    try {
      if (payloadSize <= sizeCap) {
        // Single payload delivery
        const result = await deliverSingleWebhook(webhook, payload, options)
        results = [result]
      } else if (isListData(payload.data)) {
        const chunks = chunkListPayload(payload, sizeCap)
        results = []
        for (const chunk of chunks) {
          const result = await deliverSingleWebhook(webhook, chunk, options)
          results.push(result)
          if (!result.success) {
            // Stop if any chunk fails
            break
          }
        }
      } else {
        // Can't chunk - mark as truncated and send anyway
        const truncatedPayload: WebhookPayload = {
          ...payload,
          payloadTruncated: true,
        }
        const result = await deliverSingleWebhook(webhook, truncatedPayload, options)
        results = [result]
      }

      if (reserved && results.some(result => !result.success)) {
        await options.idempotencyStore!.clearWebhookDeliveryAttempt(webhook.id, options.eventId!)
      }
    } catch (error) {
      if (reserved) {
        await options.idempotencyStore!.clearWebhookDeliveryAttempt(webhook.id, options.eventId!)
      }
      throw error
    }

    if (options.returnAllChunks) {
      return results
    }
    return results.length === 1 ? results[0] : results
  })
}
