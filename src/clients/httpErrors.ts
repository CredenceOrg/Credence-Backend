/**
 * Centralized HTTP transport error normalization and retry classification.
 *
 * Shared by all outbound HTTP clients (SorobanClient, deliverWebhook) so that
 * timeout, connection-reset, and other transport failures are detected and
 * classified consistently, preventing any single client from silently swallowing
 * retriable errors.
 */

/** Structured transport error codes, independent of any client-specific error hierarchy. */
export type TransportErrorCode = 'TIMEOUT' | 'RESET' | 'REFUSED' | 'NETWORK'

/**
 * TransportError wraps low-level network failures. 
 * Upgraded to a Class to enforce serialization invariants and prevent sensitive
 * data (like original causes or stacks) from leaking into diagnostic outputs.
 */
export class TransportError extends Error {
  public readonly code: TransportErrorCode
  public readonly cause: unknown

  constructor(code: TransportErrorCode, message: string, cause: unknown) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    this.cause = cause
    // Maintains proper stack trace for V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TransportError)
    }
  }

  /**
   * Invariant: Never expose potentially sensitive `cause` or `stack` trace
   * data in serialized output. Ensures logging/metrics are diagnosable but safe.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    }
  }
}

// ---------------------------------------------------------------------------
// Node.js syscall error code sets
// ---------------------------------------------------------------------------

/** Peer closed or reset the connection mid-stream. */
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ENOTCONN'])

/** Server actively refused the connection. */
const REFUSED_CODES = new Set(['ECONNREFUSED'])

/** OS-level connection timeout (distinct from AbortController-driven request timeout). */
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED'])

/** Safely extract a Node.js error code, guarding against throwing getters. */
function getNodeCode(err: unknown): string | undefined {
  if (err != null && typeof err === 'object') {
    try {
      const code = (err as Record<string, unknown>).code
      return typeof code === 'string' ? code : undefined
    } catch {
      // Protect against throwing getters in malicious/malformed error objects
      return undefined
    }
  }
  return undefined
}

/** Safely stringify and bound an error message to prevent CPU exhaustion on huge payloads. */
function getBoundedMessage(err: Error, limit = 1000): string {
  try {
    return String(err.message || '').slice(0, limit).toLowerCase()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Public detectors
// ---------------------------------------------------------------------------

/**
 * Returns true if `err` is an AbortController abort signal (request timeout or
 * explicit cancel). Handles all known variants.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  // Unwrap one level of cause-chain (undici / Node.js fetch wrapping)
  if (err instanceof Error && err.cause != null && isAbortError(err.cause)) return true
  return false
}

/**
 * Returns true if `err` is a Node.js transport-layer network error that is
 * NOT an abort. Covers ECONNRESET, EPIPE, socket-hang-up heuristics, and
 * undici's "fetch failed" TypeError wrapper.
 */
export function isNetworkError(err: unknown): boolean {
  if (isAbortError(err)) return false // timeout is its own category
  if (!(err instanceof Error)) return false

  const code = getNodeCode(err)
  if (code && (RESET_CODES.has(code) || REFUSED_CODES.has(code) || TIMEOUT_CODES.has(code))) {
    return true
  }

  // undici wraps transport errors as: TypeError("fetch failed") { cause: Error { code: ... } }
  if (err.name === 'TypeError' && err.message.toLowerCase().includes('fetch failed')) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error) {
      const causeCode = getNodeCode(cause)
      if (
        causeCode &&
        (RESET_CODES.has(causeCode) || REFUSED_CODES.has(causeCode) || TIMEOUT_CODES.has(causeCode))
      ) {
        return true
      }
    }
    return true // generic undici transport failure
  }

  // String heuristics for older libraries (node-fetch, got, axios)
  const msg = getBoundedMessage(err)
  return (
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('connection reset') ||
    msg.includes('socket ended without sending a response') ||
    msg.includes('network request failed')
  )
}

/**
 * Attempt to normalize any thrown value into a `TransportError`.
 * Returns `null` if the error is not transport-related.
 */
export function normalizeTransportError(err: unknown): TransportError | null {
  if (isAbortError(err)) {
    const message = err instanceof Error ? err.message : 'Request aborted'
    return new TransportError('TIMEOUT', message, err)
  }

  if (!(err instanceof Error)) return null

  const code = getNodeCode(err)
  if (code) {
    if (RESET_CODES.has(code)) return new TransportError('RESET', err.message, err)
    if (REFUSED_CODES.has(code)) return new TransportError('REFUSED', err.message, err)
    if (TIMEOUT_CODES.has(code)) return new TransportError('TIMEOUT', err.message, err)
  }

  // Unwrap undici TypeError wrapper
  if (err.name === 'TypeError' && err.message.toLowerCase().includes('fetch failed')) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error) {
      const causeCode = getNodeCode(cause)
      if (causeCode) {
        if (RESET_CODES.has(causeCode)) return new TransportError('RESET', cause.message, err)
        if (REFUSED_CODES.has(causeCode)) return new TransportError('REFUSED', cause.message, err)
        if (TIMEOUT_CODES.has(causeCode)) return new TransportError('TIMEOUT', cause.message, err)
      }
    }
    return new TransportError('NETWORK', err.message, err)
  }

  const msg = getBoundedMessage(err)
  if (
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('connection reset') ||
    msg.includes('socket ended without sending a response') ||
    msg.includes('network request failed')
  ) {
    return new TransportError('RESET', err.message, err)
  }

  return null
}

/**
 * Returns true for HTTP status codes that are always safe to retry.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/**
 * Returns true if the transport error code warrants a retry under the default
 * idempotent-safe policy.
 */
export function isRetryableTransportCode(code: TransportErrorCode): boolean {
  return code === 'TIMEOUT' || code === 'RESET' || code === 'REFUSED' || code === 'NETWORK'
}

/**
 * Returns true if `err` is a permission/authorization failure (HTTP 401/403 or
 * Node.js EACCES/EPERM). Never retried.
 */
export function isPermissionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = getNodeCode(err)
  if (code === 'EACCES' || code === 'EPERM') return true
  const status = getHttpStatus(err)
  return status === 401 || status === 403
}

/**
 * Returns true if `err` represents a stale/expired state (HTTP 409/410/412).
 * Stale errors require state re-read before retry.
 */
export function isStaleError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const status = getHttpStatus(err)
  if (status === 409 || status === 410 || status === 412) return true
  
  const msg = getBoundedMessage(err)
  return msg.includes('stale') || msg.includes('expired') || msg.includes('precondition failed')
}

/**
 * Best-effort extraction of an HTTP status code from an arbitrary error value,
 * guarded against circular references and throwing getters.
 */
export function getHttpStatus(err: unknown): number | undefined {
  if (err == null || typeof err !== 'object') return undefined
  try {
    const rec = err as Record<string, unknown>
    const direct = rec.status ?? rec.statusCode
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct
    
    const response = rec.response
    if (response != null && typeof response === 'object') {
      const nested = (response as Record<string, unknown>).status
      if (typeof nested === 'number' && Number.isFinite(nested)) return nested
    }
  } catch {
    // Failsafe for proxy objects or throwing getters
  }
  return undefined
}

/**
 * Classifies an error into a recovery decision. 
 *
 * Invariants:
 * - Permission errors are never retried.
 * - Stale errors require a re-read before retry (never blind retry).
 * - Transport errors are retried per `isRetryableTransportCode`.
 * - Unknown errors are not retried (fail closed).
 */
export type RecoveryDecision =
  | { readonly action: 'retry'; readonly reason: TransportErrorCode | 'HTTP_STATUS' }
  | { readonly action: 'reread'; readonly reason: 'STALE' }
  | { readonly action: 'fail'; readonly reason: 'PERMISSION' | 'UNKNOWN' }

export function classifyRecovery(err: unknown): RecoveryDecision {
  if (isPermissionError(err)) return { action: 'fail', reason: 'PERMISSION' }
  if (isStaleError(err)) return { action: 'reread', reason: 'STALE' }

  const transport = normalizeTransportError(err)
  if (transport && isRetryableTransportCode(transport.code)) {
    return { action: 'retry', reason: transport.code }
  }

  const status = getHttpStatus(err)
  if (status !== undefined && isRetryableHttpStatus(status)) {
    return { action: 'retry', reason: 'HTTP_STATUS' }
  }

  return { action: 'fail', reason: 'UNKNOWN' }
}