import type { IdentityData } from './types.js'

/** Bonded amount (in base units) at which the bond component saturates at 100. */
export const MAX_BOND_AMOUNT = 1000n

/** Attestation count at which the attestation component saturates at 100. */
export const MAX_ATTESTATION_COUNT = 50

/** Weight of the bond component, expressed in per-mille so scoring stays integer-exact. */
export const BOND_WEIGHT_PER_MILLE = 600

/** Weight of the attestation component, expressed in per-mille. */
export const ATTESTATION_WEIGHT_PER_MILLE = 400

/** Inclusive lower bound of every score returned by {@link computeScore}. */
export const MIN_SCORE = 0

/** Inclusive upper bound of every score returned by {@link computeScore}. */
export const MAX_SCORE = 100

/**
 * Reason a call to {@link computeScore} was rejected.
 *
 * These are stable, machine-readable values: callers (notably
 * `ScoreSnapshotJob`) can branch or aggregate on `error.code` instead of
 * pattern-matching message text.
 */
export type ScoreComputationErrorCode =
  /** `data` was not a non-null object. */
  | 'INVALID_IDENTITY_DATA'
  /** `active` was present but not a boolean, so activeness could not be trusted. */
  | 'INVALID_ACTIVE_FLAG'
  /** `bondedAmount` could not be read as an exact integer amount. */
  | 'INVALID_BONDED_AMOUNT'
  /** `attestationCount` was not a safe integer. */
  | 'INVALID_ATTESTATION_COUNT'

/** Longest address echoed into an error message before it is truncated. */
const MAX_ADDRESS_LENGTH = 64

/** Characters allowed to survive address sanitisation (log-injection defence). */
const UNSAFE_ADDRESS_CHARS = /[^A-Za-z0-9:_.-]/g

/**
 * Error thrown when {@link computeScore} cannot derive a trustworthy score.
 *
 * The offending raw value is deliberately **not** echoed into `message`.
 * `bondedAmount` and `attestationCount` originate outside this process, so
 * reproducing them verbatim would let a crafted row inject newlines or
 * arbitrary payloads into logs and metrics labels. Only the field name and a
 * sanitised, length-capped address are included.
 */
export class ScoreComputationError extends Error {
  /** Stable, machine-readable rejection reason. */
  readonly code: ScoreComputationErrorCode
  /** Name of the offending field on `IdentityData`. */
  readonly field: string
  /** Sanitised, truncated identity address. */
  readonly address: string

  constructor(code: ScoreComputationErrorCode, field: string, address: string) {
    super(`[${code}] cannot compute score: field "${field}" is invalid for identity ${address}`)
    this.name = 'ScoreComputationError'
    this.code = code
    this.field = field
    this.address = address
  }
}

/**
 * Render an arbitrary address as a bounded, log-safe string.
 *
 * Called before any other field is read so that a rejection on a malformed row
 * is still attributable to the identity that caused it.
 */
function safeAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return 'unknown'
  }
  const truncated =
    value.length > MAX_ADDRESS_LENGTH ? `${value.slice(0, MAX_ADDRESS_LENGTH)}~` : value
  const sanitised = truncated.replace(UNSAFE_ADDRESS_CHARS, '?')
  // A value made up entirely of replaced characters (whitespace or control
  // bytes only) carries no information, and echoing a bare "?" would read as a
  // real address in a log line.
  return /[A-Za-z0-9]/.test(sanitised) ? sanitised : 'unknown'
}

/**
 * Coerce `bondedAmount` to an exact non-negative `bigint`.
 *
 * Accepted: decimal strings (including the whitespace-, sign- and radix-prefixed
 * forms `BigInt` already understands), safe integer numbers, and bigints.
 * Rejected: anything `BigInt` cannot represent exactly — the empty string,
 * decimals, exponent notation and numeric separators — because silently
 * coercing those to a different amount would mis-price an identity.
 *
 * Negative amounts saturate to zero rather than throwing: a slashed or
 * over-drawn bond is a valid ledger state, and the component is a saturating
 * function, so it must be bounded from below exactly as it is from above.
 * Throwing here would leave the identity without a snapshot (a permanently
 * stale score) for a condition the model already knows how to score.
 */
function toBondAmount(value: unknown, address: string): bigint {
  if (typeof value === 'bigint') {
    return value < 0n ? 0n : value
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ScoreComputationError('INVALID_BONDED_AMOUNT', 'bondedAmount', address)
    }
    return value < 0 ? 0n : BigInt(value)
  }

  // `BigInt('')` is 0n, so an empty/whitespace amount must be rejected before
  // parsing or a missing bond would be scored as a fully unbonded identity.
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ScoreComputationError('INVALID_BONDED_AMOUNT', 'bondedAmount', address)
  }

  let parsed: bigint
  try {
    parsed = BigInt(value)
  } catch {
    throw new ScoreComputationError('INVALID_BONDED_AMOUNT', 'bondedAmount', address)
  }

  return parsed < 0n ? 0n : parsed
}

/**
 * Coerce `attestationCount` to a non-negative safe integer.
 *
 * Rejects non-numbers, `NaN`, `±Infinity`, fractions and values beyond
 * `Number.MAX_SAFE_INTEGER`. Those values would otherwise propagate a `NaN` or
 * a non-finite score into `score_history`, which is not JSON-serialisable and
 * silently poisons any downstream aggregate. Negative counts saturate to zero
 * for the same reason negative bonds do.
 */
function toAttestationCount(value: unknown, address: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ScoreComputationError('INVALID_ATTESTATION_COUNT', 'attestationCount', address)
  }
  return value < 0 ? 0 : value
}

/**
 * Default score computation algorithm.
 *
 * Score is computed based on:
 * - Bond amount (normalized)
 * - Attestation count
 *
 * Formula: score = bondWeight * bondScore + attestationScore * attestationWeight
 *
 * ## Invariants
 *
 * For any input, the function is total in one of exactly two ways:
 *
 * 1. It returns an integer in `[MIN_SCORE, MAX_SCORE]` (`0..100`), or
 * 2. it throws a {@link ScoreComputationError} carrying a
 *    {@link ScoreComputationErrorCode}.
 *
 * Guarantees this encoding provides:
 *
 * - **Bounded.** Both components saturate at 100 and the result is clamped, so
 *   no bond, attestation count, or future weight change can emit a score
 *   outside `0..100`. Previously a negative bond or negative attestation count
 *   produced a negative score, and a negative count combined with `Infinity`
 *   produced `-Infinity`.
 * - **Deterministic.** Components and the weighted sum are computed in integer
 *   and `bigint` arithmetic (per-mille weights), with a single round-half-up at
 *   the end. No floating-point result is ever compared or rounded, so inputs
 *   that land exactly on a `.5` boundary cannot flip between runs or platforms.
 * - **Overflow-free.** Bond amounts are capped *before* conversion to `Number`,
 *   so arbitrarily large `bigint` amounts cannot produce `Infinity` or lose
 *   precision on the way to the score.
 * - **Fail-loud on untrustworthy input.** Rather than a raw `SyntaxError` from
 *   `BigInt()`, or a `NaN` that is persisted as a real score, malformed fields
 *   raise a typed error naming the field. `ScoreSnapshotJob` already counts
 *   throws, so a corrupt row becomes a visible, countable error instead of a
 *   silently skipped identity.
 * - **No coercion of activeness.** `active` must be a real boolean. Treating a
 *   truthy-but-malformed value such as `'false'` or `1` as active would score an
 *   identity that should be at `MIN_SCORE`.
 *
 * @param data - Identity data for score computation
 * @returns Computed score, an integer in `[0, 100]`
 * @throws {ScoreComputationError} if the input cannot be scored deterministically
 */
export function computeScore(data: IdentityData): number {
  // Widened view so runtime checks do not depend on the compile-time type; a
  // row from an external source can violate the declared shape at any time.
  const row = data as Partial<IdentityData> | null | undefined
  const address = safeAddress(row?.address)

  if (row === null || row === undefined || typeof row !== 'object') {
    throw new ScoreComputationError('INVALID_IDENTITY_DATA', 'data', address)
  }

  if (typeof row.active !== 'boolean') {
    throw new ScoreComputationError('INVALID_ACTIVE_FLAG', 'active', address)
  }

  // Inactive identities short-circuit *before* numeric validation. Their bond
  // row is irrelevant to the score, so a corrupt or partially-migrated amount
  // must not stop the job from recording the definitive 0 — otherwise the
  // previously-persisted score would linger and read as stale-but-current.
  if (!row.active) {
    return MIN_SCORE
  }

  const bondAmount = toBondAmount(row.bondedAmount, address)
  const attestationCount = toAttestationCount(row.attestationCount, address)

  // Saturating bond component. Cap first, then scale, so the division result is
  // bounded by MAX_SCORE and the bigint -> number conversion can never overflow
  // regardless of how many digits the source amount carries. MAX_SCORE doubles
  // as the percentage scale for the component.
  const cappedBond = bondAmount > MAX_BOND_AMOUNT ? MAX_BOND_AMOUNT : bondAmount
  const bondScore = Number((cappedBond * BigInt(MAX_SCORE)) / MAX_BOND_AMOUNT)

  // Saturating attestation component. Cap first for the same exactness reason:
  // the scaling division is then evaluated at a magnitude small enough to be
  // exactly representable as a double, so the component is always an integer.
  const cappedAttestations =
    attestationCount > MAX_ATTESTATION_COUNT ? MAX_ATTESTATION_COUNT : attestationCount
  const attestationScore = (cappedAttestations * MAX_SCORE) / MAX_ATTESTATION_COUNT

  // Weighted sum in per-mille, then a single round-half-up. Both terms and the
  // weights are integers, so this is exact; only the final quotient is divided.
  const weightedPerMille =
    BOND_WEIGHT_PER_MILLE * bondScore + ATTESTATION_WEIGHT_PER_MILLE * attestationScore
  const rounded = Math.floor((weightedPerMille + 500) / 1000)

  // Belt-and-braces clamp: the weights already sum to 1000 and the components
  // are already capped, so this only guards against a future re-weighting.
  return Math.min(Math.max(rounded, MIN_SCORE), MAX_SCORE)
}
