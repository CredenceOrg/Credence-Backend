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

export interface TransportError {
  readonly code: TransportErrorCode
  readonly message: string
  /** Original thrown value for debugging. */
  readonly cause: unknown
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

function getNodeCode(err: unknown): string | undefined {
  if (err != null && typeof err === 'object' && 'code' in err) {
    const code = (err as Record<string, unknown>).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Public detectors
// ---------------------------------------------------------------------------

/**
 * Returns true if `err` is an AbortController abort signal (request timeout or
 * explicit cancel). Handles all known variants:
 * - `DOMException { name: 'AbortError' }` (browser + Node.js 18+)
 * - `Error { name: 'AbortError' }` (older Node.js / whatwg-fetch polyfill)
 * - `TypeError { cause: AbortError }` (undici wraps the abort inside TypeError)
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
  const msg = err.message.toLowerCase()
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
 * Returns `null` if the error is not transport-related (e.g. a real JSON
 * parse error or application-level error).
 *
 * Call this in `catch` blocks that wrap both transport I/O *and* body reads so
 * that transport failures are not silently re-classified as parse errors.
 */
export function normalizeTransportError(err: unknown): TransportError | null {
  if (isAbortError(err)) {
    const message = err instanceof Error ? err.message : 'Request aborted'
    return { code: 'TIMEOUT', message, cause: err }
  }

  if (!(err instanceof Error)) return null

  const code = getNodeCode(err)
  if (code) {
    if (RESET_CODES.has(code)) return { code: 'RESET', message: err.message, cause: err }
    if (REFUSED_CODES.has(code)) return { code: 'REFUSED', message: err.message, cause: err }
    if (TIMEOUT_CODES.has(code)) return { code: 'TIMEOUT', message: err.message, cause: err }
  }

  // Unwrap undici TypeError wrapper
  if (err.name === 'TypeError' && err.message.toLowerCase().includes('fetch failed')) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error) {
      const causeCode = getNodeCode(cause)
      if (causeCode) {
        if (RESET_CODES.has(causeCode)) return { code: 'RESET', message: cause.message, cause: err }
        if (REFUSED_CODES.has(causeCode)) return { code: 'REFUSED', message: cause.message, cause: err }
        if (TIMEOUT_CODES.has(causeCode)) return { code: 'TIMEOUT', message: cause.message, cause: err }
      }
    }
    return { code: 'NETWORK', message: err.message, cause: err }
  }

  const msg = err.message.toLowerCase()
  if (
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('connection reset') ||
    msg.includes('socket ended without sending a response') ||
    msg.includes('network request failed')
  ) {
    return { code: 'RESET', message: err.message, cause: err }
  }

  return null
}

/**
 * Returns true for HTTP status codes that are always safe to retry:
 * - 408 Request Timeout
 * - 429 Too Many Requests
 * - 5xx Server Errors
 *
 * 4xx codes other than 408/429 are NOT retried because they represent
 * client errors (bad request, auth failure) that will not resolve on retry.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/**
 * Returns true if the transport error code warrants a retry under the default
 * idempotent-safe policy. All transport codes are retried by default since they
 * indicate infrastructure failures, not application logic errors.
 */
export function isRetryableTransportCode(code: TransportErrorCode): boolean {
  // All four transport codes (TIMEOUT, RESET, REFUSED, NETWORK) are retriable.
  // Non-idempotent callers that need to suppress this must check explicitly.
  return code === 'TIMEOUT' || code === 'RESET' || code === 'REFUSED' || code === 'NETWORK'
}
