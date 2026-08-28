/**
 * Pure, side-effect-free arithmetic for Horizon bond withdrawal ingestion.
 *
 * These functions are extracted from HorizonWithdrawalListener so they can be
 * unit-tested without any database, Stellar SDK, or Redis dependency.
 *
 * Design invariants
 * ─────────────────
 * • All arithmetic uses BigInt-scaled integers via `decimalMath` — never
 *   IEEE 754 floating-point — so amounts with > 15 significant digits are
 *   handled exactly.
 * • Both operands are validated against a non-negative decimal format before
 *   any state mutation; invalid inputs throw synchronously with a descriptive
 *   message so the caller can route the event to the DLQ without side effects.
 * • `computeNewBondAmount` clamps to "0" when the withdrawal equals or exceeds
 *   the current balance; negative balances are structurally impossible.
 * • `shouldTakeSnapshot` uses exact BigInt division (scale 4) for the 50 %
 *   ratio test, eliminating the floating-point midpoint imprecision that
 *   affected `parseFloat`-based implementations.
 *
 * Compatibility
 * ─────────────
 * Public behaviour is unchanged for well-formed inputs that fit within
 * JavaScript's safe-integer range.  The only visible change for callers
 * is that inputs which were previously silently mangled (> 15 sig-digits)
 * are now computed exactly, and structurally invalid inputs (negative, NaN,
 * scientific notation) now throw instead of producing garbage output.
 */

import {
  subtractDecimals,
  compareDecimals,
  divideDecimals,
  RoundingMode,
} from './decimalMath.js'

// ── internal ────────────────────────────────────────────────────────────────

/** Regex that matches a valid non-negative decimal amount string. */
const NON_NEGATIVE_DECIMAL_RE = /^\d+(\.\d+)?$/

function assertValidAmount(value: string, label: string): void {
  if (!NON_NEGATIVE_DECIMAL_RE.test(value)) {
    throw new Error(
      `Invalid ${label}: "${value}" — must be a non-negative decimal string ` +
      `(no sign, no scientific notation, no whitespace)`,
    )
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Compute the new bond balance after a withdrawal.
 *
 * @param currentAmount   - Current bond balance as a decimal string (e.g. "1000.0000000").
 * @param withdrawalAmount - Amount being withdrawn as a decimal string.
 * @returns New balance string, clamped to "0" if withdrawal >= current.
 * @throws  If either argument is not a non-negative decimal string.
 */
export function computeNewBondAmount(
  currentAmount: string,
  withdrawalAmount: string,
): string {
  assertValidAmount(currentAmount, 'currentAmount')
  assertValidAmount(withdrawalAmount, 'withdrawalAmount')

  // Clamp: if withdrawal >= current, result is exactly "0" (no overdraft).
  if (compareDecimals(withdrawalAmount, currentAmount) >= 0) {
    return '0'
  }

  return subtractDecimals(currentAmount, withdrawalAmount)
}

/**
 * Decide whether a score-history snapshot should be taken after a withdrawal.
 *
 * Returns `true` when:
 *   – the bond is no longer active (full withdrawal), OR
 *   – the withdrawal represents ≥ 50 % of the previous balance.
 *
 * The 50 % ratio is computed with exact BigInt division at 4 decimal places
 * (RoundingMode.DOWN), so no floating-point midpoint error can flip the
 * decision near the threshold.
 *
 * @param previousAmount - Balance before the withdrawal (decimal string).
 * @param newAmount      - Balance after the withdrawal (decimal string).
 * @param isActive       - Whether the bond is still active after the withdrawal.
 */
export function shouldTakeSnapshot(
  previousAmount: string,
  newAmount: string,
  isActive: boolean,
): boolean {
  if (!isActive) return true

  // Guard against zero or invalid previous amount — no snapshot makes sense.
  if (!NON_NEGATIVE_DECIMAL_RE.test(previousAmount)) return false
  if (!NON_NEGATIVE_DECIMAL_RE.test(newAmount)) return false
  if (compareDecimals(previousAmount, '0') === 0) return false

  // withdrawn = previous - new  (always >= 0 after a valid calculateBondUpdate)
  const withdrawn = subtractDecimals(previousAmount, newAmount)

  // ratio = withdrawn / previous, truncated to 4 decimal places.
  // DOWN rounding means we never over-count the withdrawal fraction.
  const ratio = divideDecimals(withdrawn, previousAmount, 4, RoundingMode.DOWN)

  return compareDecimals(ratio, '0.5') >= 0
}
