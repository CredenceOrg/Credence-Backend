/**
 * Retry classifier for outbound transport errors.
 *
 * Centralises the decision of whether a thrown error is transient (retriable)
 * and, when both a timeout signal and a connection-reset arrive simultaneously,
 * ensures the classifier always picks the correct code (TIMEOUT wins over RESET
 * because the AbortController fired first).
 *
 * Rule: isAbortError is checked before any syscall-code inspection so that
 * undici's `TypeError("fetch failed") { cause: AbortError }` is always
 * classified as TIMEOUT, not RESET.
 */

import {
  normalizeTransportError,
  isRetryableTransportCode,
  isRetryableHttpStatus,
  type TransportErrorCode,
} from '../clients/httpErrors.js'

export type RetryDecision =
  | { retryable: true; code: TransportErrorCode }
  | { retryable: false; reason: string }

/**
 * Classifies a raw thrown value and returns whether it should be retried.
 *
 * Uses `normalizeTransportError` as the single source of truth so that
 * overlapping timeout+reset signals are resolved consistently:
 * - AbortError (or TypeError wrapping AbortError) → TIMEOUT → retryable
 * - ECONNRESET / EPIPE / ENOTCONN → RESET → retryable
 * - ECONNREFUSED → REFUSED → retryable
 * - Generic undici transport failure → NETWORK → retryable
 * - Non-transport errors (SyntaxError, application errors) → not retryable
 */
export function classifyTransportError(err: unknown): RetryDecision {
  const transport = normalizeTransportError(err)
  if (transport === null) {
    const msg = err instanceof Error ? err.message : String(err)
    return { retryable: false, reason: msg }
  }
  if (isRetryableTransportCode(transport.code)) {
    return { retryable: true, code: transport.code }
  }
  return { retryable: false, reason: transport.message }
}

/**
 * Returns true if the HTTP status code is safe to retry.
 * Re-exported here so callers only need to import from one place.
 */
export { isRetryableHttpStatus }
