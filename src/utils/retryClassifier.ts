/**
 * Retry classifier for outbound transport and downstream errors.
 *
 * Centralises the decision of whether a thrown error is transient (retriable)
 * and, when both a timeout signal and a connection-reset arrive simultaneously,
 * ensures the classifier always picks the correct code (TIMEOUT wins over RESET
 * because the AbortController fired first).
 *
 * Rule: `isAbortError` is checked before any syscall-code inspection so that
 * undici's `TypeError("fetch failed") { cause: AbortError }` is always
 * classified as TIMEOUT, not RESET.
 *
 * `classifyTransportError` and `classifyDownstreamError` both rely on
 * `isRetryableTransportCode` as the single source of truth for transport-layer
 * retryability, so adding a non-retriable transport code only requires updating
 * that one function — both classifiers pick it up automatically.
 */

import {
  normalizeTransportError,
  isRetryableTransportCode,
  isRetryableHttpStatus,
  type TransportErrorCode,
} from '../clients/httpErrors.js'

/**
 * Discriminated retry decision returned for a thrown value.
 *
 * `reason` is populated for BOTH retryable and non-retryable outcomes so
 * callers can log a human-readable explanation without re-deriving it from the
 * raw error.
 */
export type RetryDecision =
  | { retryable: true; code: TransportErrorCode; reason: string }
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
 *
 * Retryability is determined by `isRetryableTransportCode`, not by hardcoded
 * per-class logic, so a non-retriable transport code added in the future will
 * flow through to this function automatically.
 */
export function classifyTransportError(err: unknown): RetryDecision {
  const transport = normalizeTransportError(err)
  if (transport === null) {
    const msg = err instanceof Error ? err.message : String(err)
    return { retryable: false, reason: msg }
  }
  if (isRetryableTransportCode(transport.code)) {
    return { retryable: true, code: transport.code, reason: transport.message }
  }
  // Currently unreachable while every TransportErrorCode is retriable, but
  // explicit so that a future non-retriable transport code is honoured here
  // rather than silently forced to retryable.
  return { retryable: false, reason: transport.message }
}

/**
 * Returns true if the HTTP status code is safe to retry.
 * Re-exported here so callers only need to import from one place.
 */
export { isRetryableHttpStatus }

// ---------------------------------------------------------------------------
// Downstream error classification (NETWORK vs TIMEOUT vs RPC)
// ---------------------------------------------------------------------------

/**
 * High-level class of a downstream failure, surfaced to callers so they can
 * branch on a stable, typed value instead of inspecting raw error internals.
 *
 * - `NETWORK_ERROR`: connection-level transport failure (reset, refused, or a
 *   generic undici "fetch failed") — the request never got a usable response.
 * - `TIMEOUT_ERROR`: the request exceeded its deadline (AbortController abort or
 *   an OS-level socket timeout) — distinct from `NETWORK_ERROR` because the
 *   remedy (back off vs. raise the timeout) differs.
 * - `RPC_ERROR`: the downstream returned a well-formed JSON-RPC error object —
 *   transport succeeded but the RPC method reported a failure.
 */
export type DownstreamErrorClass = 'NETWORK_ERROR' | 'TIMEOUT_ERROR' | 'RPC_ERROR'

/**
 * JSON-RPC error codes that are transient and safe to retry under the default
 * idempotent policy. Single source of truth for every downstream client so the
 * retriable-RPC set is never duplicated as inline magic numbers.
 *
 * - `-32004`: resource not yet available (e.g. Soroban "transaction not found"
 *   while the ledger catches up).
 * - `-32005`: try again later (transient backend unavailability).
 */
export const RETRYABLE_RPC_ERROR_CODES: readonly number[] = [-32004, -32005]

/** Returns true if a JSON-RPC error code is in the retriable set. */
export function isRetryableRpcCode(code: number | undefined): boolean {
  return code !== undefined && RETRYABLE_RPC_ERROR_CODES.includes(code)
}

/**
 * Typed classification of a downstream error. `class` is always present so
 * callers can `switch` exhaustively; `retryable` carries the retry decision so
 * the caller does not re-derive it.
 *
 * Transport errors carry `retryable: boolean` (not the literal `true`) because
 * retryability is sourced from `isRetryableTransportCode` — a future
 * non-retriable transport code would then flow through unchanged instead of
 * being silently forced to retryable.
 */
export type DownstreamClassification =
  | {
      class: 'NETWORK_ERROR'
      retryable: boolean
      reason: string
      /** Underlying transport code (RESET | REFUSED | NETWORK). */
      transportCode: TransportErrorCode
    }
  | { class: 'TIMEOUT_ERROR'; retryable: boolean; reason: string }
  | {
      class: 'RPC_ERROR'
      retryable: boolean
      reason: string
      /** The JSON-RPC error code reported by the downstream. */
      rpcCode: number
    }

/** Extract a JSON-RPC error `{ code, message }` from a thrown value, if present. */
function extractRpcError(err: unknown): { code: number; message?: string } | null {
  if (err === null || typeof err !== 'object') return null

  // An error object that already carries a numeric `rpcCode` (e.g. a previously
  // normalized client error) is treated as an RPC failure.
  const rpcCode = (err as Record<string, unknown>).rpcCode
  if (typeof rpcCode === 'number') {
    const message = err instanceof Error ? err.message : undefined
    return { code: rpcCode, message }
  }

  // A raw JSON-RPC envelope: { error: { code, message } }.
  const errorField = (err as Record<string, unknown>).error
  if (errorField !== null && typeof errorField === 'object') {
    const code = (errorField as Record<string, unknown>).code
    const message = (errorField as Record<string, unknown>).message
    if (typeof code === 'number') {
      return { code, message: typeof message === 'string' ? message : undefined }
    }
  }

  return null
}

/**
 * Explicitly classify a downstream error into one of `NETWORK_ERROR`,
 * `TIMEOUT_ERROR`, or `RPC_ERROR`, with the retry decision attached.
 *
 * Returns `null` when the value is not a recognised downstream failure (for
 * example a programming error or a parse failure), leaving the caller to decide
 * how to surface it rather than forcing it into a transport bucket.
 *
 * Classification order:
 * 1. JSON-RPC error object → `RPC_ERROR` (retriable only for
 *    {@link RETRYABLE_RPC_ERROR_CODES}).
 * 2. Timeout (AbortController abort or OS socket timeout) → `TIMEOUT_ERROR`.
 * 3. Any other transport failure → `NETWORK_ERROR`.
 *
 * Timeout is resolved before generic network via `normalizeTransportError`, so
 * an abort wrapped as a reset is still surfaced as `TIMEOUT_ERROR`.
 *
 * `retryable` is sourced from `isRetryableTransportCode` for transport errors
 * so this function never diverges from `classifyTransportError` on the same
 * underlying error.
 */
export function classifyDownstreamError(err: unknown): DownstreamClassification | null {
  const rpc = extractRpcError(err)
  if (rpc !== null) {
    return {
      class: 'RPC_ERROR',
      retryable: isRetryableRpcCode(rpc.code),
      reason: rpc.message ?? `RPC error ${rpc.code}`,
      rpcCode: rpc.code,
    }
  }

  const transport = normalizeTransportError(err)
  if (transport !== null) {
    const retryable = isRetryableTransportCode(transport.code)
    if (transport.code === 'TIMEOUT') {
      return { class: 'TIMEOUT_ERROR', retryable, reason: transport.message }
    }
    return {
      class: 'NETWORK_ERROR',
      retryable,
      reason: transport.message,
      transportCode: transport.code,
    }
  }

  return null
}

/**
 * Classification of an HTTP response when only the status code is available
 * (e.g. the response was rejected before any body was read). Mirrors
 * `isRetryableHttpStatus` so both throw-based and status-based classifications
 * share a single source of truth.
 */
export type HttpStatusClassification =
  | { retryable: true; status: number; reason: string }
  | { retryable: false; status: number; reason: string }

/**
 * Returns a retry-friendly classification of an HTTP status code:
 * - 408 / 429 / 5xx → retryable
 * - everything else (including 2xx, 3xx, 4xx other than 408/429) → not retryable
 *
 * Use this when the only signal you have is the response status (e.g. an error
 * thrown with the status attached but no underlying transport failure).
 */
export function classifyHttpStatus(
  status: number,
  message?: string,
): HttpStatusClassification {
  const reason = message ?? `HTTP ${status}`
  if (isRetryableHttpStatus(status)) {
    return { retryable: true, status, reason }
  }
  return { retryable: false, status, reason }
}
