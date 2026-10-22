/**
 * Fee calculation engine.
 *
 * All arithmetic is performed using BigInt-based scaled integers (via
 * decimalMath utilities) so that no IEEE 754 floating-point error
 * propagates through the pipeline. Rounding is applied once, at the
 * final step, using the currency's minor-unit scale and HALF_UP mode
 * (the finance specification default).
 *
 * Intentional behaviour change from any prior floating-point
 * implementation: values that previously rounded to the nearest
 * representable double are now rounded deterministically using
 * HALF_UP with the correct scale for each currency (e.g. 0 places
 * for JPY, 2 for USD/EUR, 3 for KWD). Historical calculations that
 * relied on the old floating-point results may differ by at most one
 * minor unit (1 cent / 1 yen / 1 fils).
 */

import { applyDivisionRounding, roundToScale, RoundingMode } from '../../lib/decimalMath.js'
import type { FeeInput, FeeResult, Money, CurrencyCode } from './types.js'
import { getCurrencyScale } from './types.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse a non-negative decimal string into { intDigits, fracDigits }. */
function parseNonNegativeDecimal(value: string, label: string): { intDigits: string; fracDigits: string } {
  const trimmed = value.trim()
  if (!/^\d+(\.\d*)?$/.test(trimmed)) {
    throw new Error(`${label} must be a non-negative decimal string, got: "${value}"`)
  }
  const dot = trimmed.indexOf('.')
  return {
    intDigits: dot === -1 ? trimmed : trimmed.slice(0, dot),
    fracDigits: dot === -1 ? '' : trimmed.slice(dot + 1),
  }
}

/**
 * Validate that `amount` does not exceed the currency's minor-unit `scale`
 * and format it to `scale` fractional digits.
 *
 * Rejects base amounts carrying excess fractional digits instead of silently
 * truncating them.
 */
function normaliseAndValidateBaseAmount(
  amount: string,
  currency: CurrencyCode,
  scale: number,
): string {
  const { fracDigits } = parseNonNegativeDecimal(amount, 'base.amount')
  if (fracDigits.length > scale) {
    throw new Error(
      `base.amount "${amount}" has ${fracDigits.length} fractional digit(s), which exceeds the currency scale of ${scale} for ${currency}`,
    )
  }
  return roundToScale(amount, scale, RoundingMode.DOWN)
}

/**
 * Compute `amount × ratePercent / 100` using pure BigInt arithmetic and
 * round the result to `targetScale` fractional digits with `mode`.
 *
 * The exact integer quotient and remainder at `targetScale` are computed in
 * BigInt and rounded via `applyDivisionRounding` so that all discarded
 * fractional digits (not just the first digit past `targetScale`) are taken
 * into account for `UP`, `HALF_DOWN`, and `HALF_EVEN`.
 */
function computeRawFee(
  amountStr: string,
  rateStr: string,
  targetScale: number,
  mode: RoundingMode,
): string {
  const { intDigits: aInt, fracDigits: aFrac } = parseNonNegativeDecimal(amountStr, 'amount')
  const { intDigits: rInt, fracDigits: rFrac } = parseNonNegativeDecimal(rateStr, 'ratePercent')

  // Represent amount and rate as unscaled BigInts.
  // "10.55" → amountBig = 1055n, amountScale = 2
  //  "2.5"  → rateBig   =   25n, rateScale   = 1
  const amountBig = BigInt(aInt + aFrac)
  const rateBig   = BigInt(rInt + rFrac)
  const amountScale = aFrac.length
  const rateScale   = rFrac.length

  // fee = amountBig/10^amountScale × rateBig/10^rateScale / 100
  //     = amountBig × rateBig / (10^(amountScale + rateScale) × 100)
  //
  // Scaled by 10^targetScale:
  //   numerator   = amountBig × rateBig × 10^targetScale
  //   denominator = 10^(amountScale + rateScale) × 100
  //   truncated   = numerator / denominator
  //   remainder   = numerator % denominator
  //
  // All operations stay in BigInt until the final format step.
  const denominator = (10n ** BigInt(amountScale + rateScale)) * 100n
  const numerator   = amountBig * rateBig * (10n ** BigInt(targetScale))

  const truncated = numerator / denominator
  const remainder = numerator % denominator
  const rounded   = applyDivisionRounding(truncated, remainder, denominator, mode)

  // Format back to decimal string at targetScale.
  if (targetScale === 0) return rounded.toString()
  const sf = 10n ** BigInt(targetScale)
  const intPart  = rounded / sf
  const fracPart = rounded % sf
  return `${intPart}.${fracPart.toString().padStart(targetScale, '0')}`
}

/**
 * Add two monetary amounts that share the same currency and scale.
 * Both inputs must already be rounded to `scale` fractional digits.
 */
function addMoneyStrings(a: string, b: string, scale: number): string {
  // Use roundToScale with DOWN (no rounding) to normalise formatting.
  const aParsed = parseNonNegativeDecimal(a, 'a')
  const bParsed = parseNonNegativeDecimal(b, 'b')
  const aInt = BigInt(aParsed.intDigits + aParsed.fracDigits.padEnd(scale, '0').slice(0, scale))
  const bInt = BigInt(bParsed.intDigits + bParsed.fracDigits.padEnd(scale, '0').slice(0, scale))
  const sum = aInt + bInt
  return roundToScale(
    scale === 0 ? sum.toString() : (() => {
      const sf = 10n ** BigInt(scale)
      const intP = sum / sf
      const fracP = sum % sf
      return `${intP}.${fracP.toString().padStart(scale, '0')}`
    })(),
    scale,
    RoundingMode.DOWN, // already at correct scale
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculate the fee for a single base amount and rate.
 *
 * Rounding is applied once, after the full multiplication, using HALF_UP
 * (the finance specification default) and the minor-unit scale of the
 * currency (e.g. 2 for USD, 0 for JPY, 3 for KWD).
 *
 * @param input      - Base amount and percentage rate.
 * @param roundingMode - Override rounding mode (defaults to HALF_UP).
 * @returns FeeResult with base, fee, and total amounts.
 *
 * @example
 * calculateFee({ base: { amount: "100.00", currency: "USD" }, ratePercent: "2.5" })
 * // → { baseAmount: { amount: "100.00", currency: "USD" },
 * //     feeAmount:  { amount: "2.50",   currency: "USD" },
 * //     totalAmount:{ amount: "102.50", currency: "USD" } }
 */
export function calculateFee(
  input: FeeInput,
  roundingMode: RoundingMode = RoundingMode.HALF_UP,
): FeeResult {
  const { base, ratePercent } = input
  const { currency } = base

  if (parseFloat(ratePercent) < 0) {
    throw new Error(`ratePercent must be non-negative, got: "${ratePercent}"`)
  }

  const scale = getCurrencyScale(currency)

  // Validate that base.amount does not exceed the currency scale, then format.
  const normalisedBase = normaliseAndValidateBaseAmount(base.amount, currency, scale)

  const feeAmountStr = computeRawFee(normalisedBase, ratePercent, scale, roundingMode)
  const totalAmountStr = addMoneyStrings(normalisedBase, feeAmountStr, scale)

  const toMoney = (amount: string): Money => ({ amount, currency })

  return {
    baseAmount:  toMoney(normalisedBase),
    feeAmount:   toMoney(feeAmountStr),
    totalAmount: toMoney(totalAmountStr),
  }
}

/**
 * Apply a sequence of fee steps to a base amount, accumulating the total fee.
 *
 * Each step's fee is calculated independently from the original base amount
 * (not compounded). This matches the additive fee model common in billing
 * pipelines (e.g. platform fee + network fee + tax).
 *
 * @param base   - Base monetary amount.
 * @param rates  - Array of percentage rate strings (e.g. ["1.5", "0.5"]).
 * @param roundingMode - Rounding mode applied to each step individually.
 * @returns FeeResult where feeAmount is the sum of all individual fees.
 */
export function applyFees(
  base: Money,
  rates: readonly string[],
  roundingMode: RoundingMode = RoundingMode.HALF_UP,
): FeeResult {
  const scale = getCurrencyScale(base.currency)
  const normBase = normaliseAndValidateBaseAmount(base.amount, base.currency, scale)
  const currency = base.currency

  if (rates.length === 0) {
    const zero = (0n).toString().padStart(1, '0')
    const zeroStr = scale === 0 ? zero : `${zero}.${'0'.repeat(scale)}`
    const toMoney = (amount: string): Money => ({ amount, currency: base.currency })
    return {
      baseAmount:  toMoney(normBase),
      feeAmount:   toMoney(zeroStr),
      totalAmount: toMoney(normBase),
    }
  }

  // Compute each individual fee and sum them.
  let totalFeeBig = 0n
  for (const rate of rates) {
    const feeStr = computeRawFee(normBase, rate, scale, roundingMode)
    const feeParsed = parseNonNegativeDecimal(feeStr, 'fee')
    totalFeeBig += BigInt(feeParsed.intDigits + feeParsed.fracDigits.padEnd(scale, '0').slice(0, scale))
  }

  // Format accumulated fee.
  const feeAmountStr = (() => {
    if (scale === 0) return totalFeeBig.toString()
    const sf = 10n ** BigInt(scale)
    const intP  = totalFeeBig / sf
    const fracP = totalFeeBig % sf
    return `${intP}.${fracP.toString().padStart(scale, '0')}`
  })()

  const totalAmountStr = addMoneyStrings(normBase, feeAmountStr, scale)
  const toMoney = (amount: string): Money => ({ amount, currency })

  return {
    baseAmount:  toMoney(normBase),
    feeAmount:   toMoney(feeAmountStr),
    totalAmount: toMoney(totalAmountStr),
  }
}
