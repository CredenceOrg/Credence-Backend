

/**
 * Centralized HTTP transport error normalization and retry classification.
 *
 * Shared by all outbound HTTP clients (SorobanClient, deliverWebhook) so that
 * timeout, connection-reset, and other transport failures are detected and
 * classified consistently, preventing any single client from silently swallowing
 * retriable errors.
 */

/** Maximum depth to walk a `cause` chain before giving up (cycle/DoS guard). */
const MAX_CAUSE_DEPTH = 8

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

/** Permission / authorization syscall codes. Never retried. */
const PERMISSION_CODES = new Set(['EACCES', 'EPERM'])

/**
 * Returns true if `code` is a recognized transport syscall code. Kept in one
 * place so `isNetworkError` and `normalizeTransportError` cannot drift apart.
 */
function isTransportCode(code: string): boolean {
  return RESET_CODES.has(code) || REFUSED_CODES.has(code) || TIMEOUT_CODES.has(code)
}

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
 *
 * The `cause` chain is walked to a bounded depth so a cyclic or adversarially
 * deep chain cannot cause unbounded recursion. Non-Error causes are ignored.
 */
export function isAbortError(err: unknown): boolean {
  return isAbortErrorAtDepth(err, 0)
}

function isAbortErrorAtDepth(err: unknown, depth: number): boolean {
  if (depth > MAX_CAUSE_DEPTH) return false
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  // Unwrap one level of cause-chain (undici / Node.js fetch wrapping)
  if (err instanceof Error && err.cause != null && isAbortErrorAtDepth(err.cause, depth + 1)) {
    return true
  }
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
  if (isPermissionError(err)) return false // permission is its own category

  const code = getNodeCode(err)
  if (code && isTransportCode(code)) {
    return true
  }

  // undici wraps transport errors as: TypeError("fetch failed") { cause: Error { code: ... } }
  if (err.name === 'TypeError' && err.message.toLowerCase().includes('fetch failed')) {
    const cause = (err as Error & { cause?: unknown }).cause
    if (cause instanceof Error) {
      const causeCode = getNodeCode(cause)
      if (causeCode && isTransportCode(causeCode)) {
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
 *
 * Returns `null` for permission errors so they are never misclassified as
 * retriable transport failures (permission is handled by `isPermissionError`).
 * The undici `cause` chain is walked to a bounded depth.
 */
export function normalizeTransportError(err: unknown): TransportError | null {
  if (isAbortError(err)) {
    const message = err instanceof Error ? err.message : 'Request aborted'
    return { code: 'TIMEOUT', message, cause: err }
  }

  if (!(err instanceof Error)) return null

  if (isPermissionError(err)) return null

  const code = getNodeCode(err)
  if (code) {
    if (RESET_CODES.has(code)) return { code: 'RESET', message: err.message, cause: err }
    if (REFUSED_CODES.has(code)) return { code: 'REFUSED', message: err.message, cause: err }
    if (TIMEOUT_CODES.has(code)) return { code: 'TIMEOUT', message: err.message, cause: err }
  }

  // Unwrap undici TypeError wrapper
  if (err.name === 'TypeError' && err.message.toLowerCase().includes('fetch failed')) {
    const cause = (err as Error & { cause?: unknown }).cause
    const nested = normalizeCauseChain(cause, 0)
    if (nested) {
      return { code: nested.code, message: nested.message, cause: err }
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
 * Walks a `cause` chain looking for a recognized transport syscall code.
 * Bounded by `MAX_CAUSE_DEPTH` to prevent unbounded recursion on cyclic or
 * adversarially deep chains. Returns `null` if no transport code is found.
 */
function normalizeCauseChain(
  cause: unknown,
  depth: number,
): { code: TransportErrorCode; message: string } | null {
  if (depth > MAX_CAUSE_DEPTH) return null
  if (!(cause instanceof Error)) return null
  const code = getNodeCode(cause)
  if (code) {
    if (RESET_CODES.has(code)) return { code: 'RESET', message: cause.message }
    if (REFUSED_CODES.has(code)) return { code: 'REFUSED', message: cause.message }
    if (TIMEOUT_CODES.has(code)) return { code: 'TIMEOUT', message: cause.message }
  }
  if (cause.cause != null) return normalizeCauseChain(cause.cause, depth + 1)
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

/**
 * Returns true if `err` is a permission/authorization failure (HTTP 401/403 or
 * Node.js EACCES/EPERM). These are never retried because retrying will not
 * change the outcome and may lock out the caller.
 *
 * Also recognizes the undici `TypeError { cause }` wrapper so a wrapped
 * EACCES/EPERM is not silently treated as a retriable transport failure.
 */
export function isPermissionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = getNodeCode(err)
  if (code && PERMISSION_CODES.has(code)) return true
  const cause = (err as Error & { cause?: unknown }).cause
  if (cause instanceof Error) {
    const causeCode = getNodeCode(cause)
    if (causeCode && PERMISSION_CODES.has(causeCode)) return true
  }
  const status = getHttpStatus(err)
  return status === 401 || status === 403
}

/**
 * Returns true if `err` represents a stale/expired state (HTTP 409/410/412 or
 * a stale-read marker). Stale errors are not retried blindly; callers must
 * re-read state before retrying to avoid clobbering concurrent updates.
 *
 * Permission errors take precedence: a 403 with a "stale" message must be
 * treated as a permission failure, not a stale re-read.
 */
export function isStaleError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (isPermissionError(err)) return false
  const status = getHttpStatus(err)
  if (status === 409 || status === 410 || status === 412) return true
  const msg = err.message.toLowerCase()
  return msg.includes('stale') || msg.includes('expired') || msg.includes('precondition failed')
}

/**
 * Best-effort extraction of an HTTP status code from an arbitrary error value.
 * Recognizes `status`, `statusCode`, and `response.status` shapes used by
 * fetch wrappers, axios, got, and node-fetch.
 *
 * Only integer status codes in the valid HTTP range [100, 599] are returned;
 * non-integer or out-of-range values are rejected so callers cannot be tricked
 * into retrying on a bogus status.
 */
export function getHttpStatus(err: unknown): number | undefined {
  if (err == null || typeof err !== 'object') return undefined
  const rec = err as Record<string, unknown>
  const direct = rec.status ?? rec.statusCode
  if (isValidHttpStatus(direct)) return direct
  const response = rec.response
  if (response != null && typeof response === 'object') {
    const nested = (response as Record<string, unknown>).status
    if (isValidHttpStatus(nested)) return nested
  }
  return undefined
}

function isValidHttpStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  )
}

/**
 * Classifies an error into a recovery decision. This is the single entry point
 * callers should use to decide whether to retry, re-read state, or surface the
 * failure. Deterministic for all inputs (including non-Error values).
 *
 * Invariants:
 * - Permission errors are never retried.
 * - Stale errors require a re-read before retry (never blind retry).
 * - Transport errors are retried per `isRetryableTransportCode`.
 * - Unknown errors are not retried (fail closed).
 * - Permission errors are checked before stale/transport so a wrapped
 *   EACCES/EPERM or 401/403 can never be retried.
 * - Non-Error values (null, undefined, strings, plain objects) fail closed.
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
