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

/**
 * Invariant guard: the half-open probe delay must never be shorter than the
 * open (fail-fast) window. If it were, the breaker could admit a probe while
 * still inside the fail-fast period, defeating the purpose of the OPEN state
 * and allowing a thundering herd of requests against a downstream that has
 * not yet had time to recover.
 *
 * This is asserted at module load so misconfiguration fails fast and loudly
 * rather than producing an unsafe or inconsistent runtime state.
 */
if (CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS < CIRCUIT_BREAKER_OPEN_WINDOW_MS) {
  throw new Error(
    'Invalid Soroban circuit-breaker configuration: ' +
      'CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS (' +
      CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS +
      'ms) must be >= CIRCUIT_BREAKER_OPEN_WINDOW_MS (' +
      CIRCUIT_BREAKER_OPEN_WINDOW_MS +
      'ms).',
  )
}

/**
 * Invariant guard: the failure threshold must be a positive integer. A value
 * of zero or a negative value would trip the breaker immediately on the first
 * (or zeroth) observation, and a non-integer would make the consecutive
 * failure counter comparison ambiguous. Reject such configurations at load.
 */
if (
  !Number.isInteger(CIRCUIT_BREAKER_FAILURE_THRESHOLD) ||
  CIRCUIT_BREAKER_FAILURE_THRESHOLD < 1
) {
  throw new Error(
    'Invalid Soroban circuit-breaker configuration: ' +
      'CIRCUIT_BREAKER_FAILURE_THRESHOLD must be a positive integer, got ' +
      CIRCUIT_BREAKER_FAILURE_THRESHOLD +
      '.',
  )
}

/**
 * Invariant guard: both timing windows must be finite, non-negative numbers.
 * NaN or Infinity would make the OPEN/HALF_OPEN transitions non-deterministic
 * (e.g. `Date.now() >= openedAt + NaN` is always false, so the breaker would
 * never leave OPEN and would permanently reject traffic).
 */
if (
  !Number.isFinite(CIRCUIT_BREAKER_OPEN_WINDOW_MS) ||
  CIRCUIT_BREAKER_OPEN_WINDOW_MS < 0 ||
  !Number.isFinite(CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS) ||
  CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS < 0
) {
  throw new Error(
    'Invalid Soroban circuit-breaker configuration: timing windows must be ' +
      'finite, non-negative numbers.',
  )
}

/**
 * Frozen snapshot of the resolved defaults. Exposed so tests and callers can
 * assert against the exact values the breaker will use without re-deriving
 * them, and so accidental mutation cannot corrupt shared state.
 */
export const CIRCUIT_BREAKER_RESOLVED_DEFAULTS = Object.freeze({
  failureThreshold: CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  openWindowMs: CIRCUIT_BREAKER_OPEN_WINDOW_MS,
  halfOpenAfterMs: CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS,
})