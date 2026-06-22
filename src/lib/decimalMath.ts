/**
 * Decimal-safe arithmetic utilities for financial calculations.
 *
 * Uses BigInt-based scaled-integer arithmetic internally to eliminate
 * IEEE 754 floating-point rounding errors. All public functions accept
 * decimal strings (e.g. "10.50") and return decimal strings so that
 * precision is never silently lost at call boundaries.
 */

/** Rounding modes aligned with financial specification. */
export enum RoundingMode {
  /** Round half away from zero — standard financial rounding. */
  HALF_UP = 'HALF_UP',
  /** Round half toward zero. */
  HALF_DOWN = 'HALF_DOWN',
  /** Banker's rounding: round half to the nearest even digit. */
  HALF_EVEN = 'HALF_EVEN',
  /** Truncate toward zero, discarding the fractional remainder. */
  DOWN = 'DOWN',
  /** Round away from zero regardless of the fractional value. */
  UP = 'UP',
}

/** Default rounding mode for fee calculations (finance specification). */
export const DEFAULT_ROUNDING_MODE = RoundingMode.HALF_UP

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ParsedDecimal {
  negative: boolean
  /** Digits left of the decimal point (no sign). */
  intStr: string
  /** Digits right of the decimal point, may be empty. */
  fracStr: string
}

function parseDecimalString(value: string): ParsedDecimal {
  const trimmed = value.trim()
  const negative = trimmed.startsWith('-')
  const abs = negative ? trimmed.slice(1) : trimmed
  if (!/^\d+(\.\d*)?$/.test(abs)) {
    throw new Error(`Invalid decimal string: "${value}"`)
  }
  const dot = abs.indexOf('.')
  return {
    negative,
    intStr: dot === -1 ? abs : abs.slice(0, dot),
    fracStr: dot === -1 ? '' : abs.slice(dot + 1),
  }
}

/**
 * Convert a non-negative BigInt scaled by 10^scale back to a decimal string
 * with exactly `scale` fractional digits.
 */
function formatScaledInt(value: bigint, scale: number): string {
  if (scale === 0) return value.toString()
  const sf = 10n ** BigInt(scale)
  const intPart = value / sf
  const fracPart = value % sf
  return `${intPart}.${fracPart.toString().padStart(scale, '0')}`
}

/**
 * Apply a rounding mode to a truncated BigInt value given the deciding digit
 * (0–9). Operates on non-negative magnitudes; the caller handles the sign.
 */
function applyRoundingMode(
  truncated: bigint,
  roundDigit: bigint,
  mode: RoundingMode,
): bigint {
  switch (mode) {
    case RoundingMode.DOWN:
      return truncated
    case RoundingMode.UP:
      return roundDigit > 0n ? truncated + 1n : truncated
    case RoundingMode.HALF_UP:
      return roundDigit >= 5n ? truncated + 1n : truncated
    case RoundingMode.HALF_DOWN:
      return roundDigit > 5n ? truncated + 1n : truncated
    case RoundingMode.HALF_EVEN: {
      if (roundDigit > 5n) return truncated + 1n
      if (roundDigit < 5n) return truncated
      // Exactly at midpoint — round to even.
      return truncated % 2n === 0n ? truncated : truncated + 1n
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Round a decimal value to a specified number of fractional digits.
 *
 * Arithmetic is performed entirely in BigInt — the full input precision is
 * retained so that UP mode and HALF modes are always exact regardless of
 * how many digits the input carries beyond the target scale.
 *
 * @param value - Decimal value as a string (e.g. "10.555") or number.
 * @param scale - Number of fractional digits in the result (≥ 0).
 * @param mode  - Rounding mode (defaults to HALF_UP).
 * @returns Decimal string with exactly `scale` fractional digits.
 *
 * @example
 * roundToScale("10.555", 2)                           // "10.56"  (HALF_UP)
 * roundToScale("10.545", 2, RoundingMode.HALF_EVEN)   // "10.54"  (banker's)
 * roundToScale("10.001", 2, RoundingMode.DOWN)        // "10.00"
 * roundToScale("0.005",  2, RoundingMode.HALF_UP)     // "0.01"
 * roundToScale("1.001",  0, RoundingMode.UP)          // "2"
 */
export function roundToScale(
  value: string | number,
  scale: number,
  mode: RoundingMode = DEFAULT_ROUNDING_MODE,
): string {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new Error(`scale must be a non-negative integer, got: ${scale}`)
  }

  const str = typeof value === 'number' ? value.toString() : value
  const { negative, intStr, fracStr } = parseDecimalString(str)

  // No rounding needed when input already has ≤ scale fractional digits.
  if (fracStr.length <= scale) {
    const pad = scale - fracStr.length
    const int = BigInt(intStr || '0')
    const frac = fracStr.length > 0 ? BigInt(fracStr) : 0n
    const scaled = int * (10n ** BigInt(scale)) + frac * (10n ** BigInt(pad))
    const formatted = formatScaledInt(scaled, scale)
    return negative && scaled !== 0n ? `-${formatted}` : formatted
  }

  // Full-precision integer: digits left of point || digits right of point.
  // e.g. "10.555" → intValue = 10555, inputScale = 3
  const inputScale = fracStr.length
  const intValue = BigInt(intStr || '0') * (10n ** BigInt(inputScale)) + BigInt(fracStr)

  // Discard `shift` digits from the right to reach target scale.
  const shift = inputScale - scale
  const shiftFactor = 10n ** BigInt(shift)
  const truncated = intValue / shiftFactor
  const remainder = intValue % shiftFactor

  // Use 2× remainder vs shiftFactor to determine half/above/below without
  // any fractional arithmetic.
  const twice = remainder * 2n

  let rounded: bigint
  switch (mode) {
    case RoundingMode.DOWN:
      rounded = truncated
      break
    case RoundingMode.UP:
      // Any non-zero remainder means the value was truncated — round away from zero.
      rounded = remainder > 0n ? truncated + 1n : truncated
      break
    case RoundingMode.HALF_UP:
      rounded = twice >= shiftFactor ? truncated + 1n : truncated
      break
    case RoundingMode.HALF_DOWN:
      rounded = twice > shiftFactor ? truncated + 1n : truncated
      break
    case RoundingMode.HALF_EVEN: {
      if (twice > shiftFactor) rounded = truncated + 1n
      else if (twice < shiftFactor) rounded = truncated
      else rounded = truncated % 2n === 0n ? truncated : truncated + 1n
      break
    }
    default:
      rounded = truncated
  }

  const formatted = formatScaledInt(rounded, scale)
  return negative && rounded !== 0n ? `-${formatted}` : formatted
}

/**
 * Multiply two decimal strings exactly, returning a decimal string.
 *
 * No rounding is applied. The result scale equals the sum of the two
 * input scales (trailing zeros are preserved).
 *
 * @example
 * multiplyDecimals("10.55", "2.5")  // "26.375"
 * multiplyDecimals("3",     "0.1")  // "0.3"
 */
export function multiplyDecimals(a: string, b: string): string {
  const pa = parseDecimalString(a)
  const pb = parseDecimalString(b)

  const aInt = BigInt(pa.intStr + pa.fracStr)
  const bInt = BigInt(pb.intStr + pb.fracStr)
  const product = aInt * bInt
  const scale = pa.fracStr.length + pb.fracStr.length
  const negative = pa.negative !== pb.negative

  const absProduct = product < 0n ? -product : product
  const formatted = formatScaledInt(absProduct, scale)
  return negative && product !== 0n ? `-${formatted}` : formatted
}
