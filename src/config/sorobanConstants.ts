/**
 * Soroban RPC circuit-breaker and related constants.
 *
 * All numeric thresholds and timeouts for the Soroban RPC circuit breaker
 * live here so they are referenced from a single authoritative location.
 * Do NOT scatter magic numbers across client files — import from here instead.
 *
 * Environment variable overrides are validated in `src/config/index.ts` and
 * the resolved values are passed into `CircuitBreaker` at construction time.
 */

// ── Failure threshold ─────────────────────────────────────────────────────────

/**
 * Number of consecutive failures required to trip (OPEN) the breaker.
 * Corresponds to env var `SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD`.
 */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5

// ── Timing windows ────────────────────────────────────────────────────────────

/**
 * Duration in milliseconds that the breaker stays OPEN and rejects all
 * requests immediately (fail-fast) after tripping.
 *
 * During this window no request touches the network; callers receive a
 * `SorobanClientError` with `code: 'NETWORK_ERROR'` immediately.
 *
 * Corresponds to env var `SOROBAN_CIRCUIT_BREAKER_OPEN_WINDOW_MS`.
 * Default: 10 000 ms (10 seconds).
 */
export const CIRCUIT_BREAKER_OPEN_WINDOW_MS = 10_000

/**
 * Duration in milliseconds after the breaker trips before a single probe
 * request is allowed through to test whether the downstream has recovered.
 *
 * Must be ≥ `CIRCUIT_BREAKER_OPEN_WINDOW_MS`. When set equal to the open
 * window the breaker moves to HALF_OPEN as soon as the fail-fast period ends.
 * Setting it longer creates a deliberate back-off before the first probe.
 *
 * Corresponds to env var `SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS`.
 * Default: 30 000 ms (30 seconds).
 */
export const CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS = 30_000

/**
 * Convenience object that bundles all defaults so callers can spread or
 * destructure without importing each constant individually.
 */
export const CIRCUIT_BREAKER_DEFAULTS = {
  failureThreshold: CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  openWindowMs: CIRCUIT_BREAKER_OPEN_WINDOW_MS,
  halfOpenAfterMs: CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS,
} as const
