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

/** Thrown by {@link divideDecimals} when the divisor is zero. */
export class DivisionByZeroError extends Error {
  constructor(dividend: string, divisor: string) {
    super(`Division by zero: cannot divide "${dividend}" by "${divisor}"`)
    this.name = 'DivisionByZeroError'
  }
}

/**
 * Thrown by {@link assertWithinNumericBounds} when a value carries more
 * fractional digits than the target column's scale allows.
 *
 * This case is distinct from overflow: a Postgres `NUMERIC(p,s)` column does
 * not reject excess fractional digits, it silently *rounds* the value to `s`
 * digits on write. Left unchecked, the caller believes the exact input
 * amount was persisted (and may record it verbatim in an audit ledger) while
 * the column silently stores a rounded value — a precision-loss bug that
 * matches values in normal review.
 */
export class DecimalScaleError extends Error {
  constructor(
    readonly value: string,
    readonly maxScale: number,
    readonly actualScale: number,
  ) {
    super(
      `Value "${value}" has ${actualScale} fractional digit(s), exceeding the maximum allowed scale of ${maxScale}`,
    )
    this.name = 'DecimalScaleError'
  }
}

/**
 * Thrown by {@link assertWithinNumericBounds} when a value's integer part
 * has more digits than the target column's precision allows.
 *
 * Writing such a value to a Postgres `NUMERIC(p,s)` column raises a raw
 * `22003 numeric_field_overflow` error at the database boundary. Checking
 * this in the application layer lets the operation be rejected *before* any
 * row lock or state mutation, with a typed, documented error instead of a
 * driver-specific exception leaking out of the repository.
 */
export class DecimalOverflowError extends Error {
  constructor(
    readonly value: string,
    readonly precision: number,
    readonly scale: number,
  ) {
    super(
      `Value "${value}" exceeds the maximum magnitude representable by NUMERIC(${precision},${scale})`,
    )
    this.name = 'DecimalOverflowError'
  }
}

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

/**
 * Convert a parsed decimal's absolute value to a BigInt scaled by 10^scale,
 * padding with trailing zeros if the value has fewer fractional digits than
 * `scale`. Assumes `scale >= fracStr.length` (true for the max-of-two-scales
 * usage in addDecimals/subtractDecimals/compareDecimals).
 */
function toScaledMagnitude(p: ParsedDecimal, scale: number): bigint {
  const pad = scale - p.fracStr.length
  const int = BigInt(p.intStr)
  const frac = p.fracStr.length > 0 ? BigInt(p.fracStr) : 0n
  return int * 10n ** BigInt(scale) + frac * 10n ** BigInt(pad)
}

/**
 * Apply a rounding mode to a division's truncated quotient given the
 * remainder and divisor (rather than a single decimal digit). Operates on
 * non-negative magnitudes; the caller handles the sign.
 */
function applyDivisionRounding(
  truncated: bigint,
  remainder: bigint,
  divisor: bigint,
  mode: RoundingMode,
): bigint {
  const twice = remainder * 2n
  switch (mode) {
    case RoundingMode.DOWN:
      return truncated
    case RoundingMode.UP:
      return remainder > 0n ? truncated + 1n : truncated
    case RoundingMode.HALF_UP:
      return twice >= divisor ? truncated + 1n : truncated
    case RoundingMode.HALF_DOWN:
      return twice > divisor ? truncated + 1n : truncated
    case RoundingMode.HALF_EVEN: {
      if (twice > divisor) return truncated + 1n
      if (twice < divisor) return truncated
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
 * Return true iff value is a valid decimal string representing a number
 * strictly greater than zero (positive, non-zero, non-negative).
 *
 * @example
 * isValidPositiveDecimal("0.000000001") // true
 * isValidPositiveDecimal("0")           // false
 * isValidPositiveDecimal("-1")          // false
 * isValidPositiveDecimal("abc")         // false
 */
export function isValidPositiveDecimal(value: string): boolean {
  try {
    const { negative, intStr, fracStr } = parseDecimalString(value)
    if (negative) return false
    return BigInt((intStr || '0') + (fracStr || '')) > 0n
  } catch {
    return false
  }
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

/**
 * Add two decimal strings exactly, returning a decimal string.
 *
 * Scales are aligned to the larger of the two input scales before adding —
 * no rounding is applied, so the result is always exact.
 *
 * @example
 * addDecimals("10.50", "2.25")   // "12.75"
 * addDecimals("0.1",   "0.2")    // "0.3"
 * addDecimals("-5",    "3")      // "-2"
 * addDecimals("-3",    "3")      // "0"   (no trailing -0)
 */
export function addDecimals(a: string, b: string): string {
  const pa = parseDecimalString(a)
  const pb = parseDecimalString(b)
  const scale = Math.max(pa.fracStr.length, pb.fracStr.length)

  const aSigned = (pa.negative ? -1n : 1n) * toScaledMagnitude(pa, scale)
  const bSigned = (pb.negative ? -1n : 1n) * toScaledMagnitude(pb, scale)
  const sum = aSigned + bSigned

  const formatted = formatScaledInt(sum < 0n ? -sum : sum, scale)
  return sum < 0n ? `-${formatted}` : formatted
}

/**
 * Subtract two decimal strings exactly, returning a decimal string.
 *
 * Scales are aligned to the larger of the two input scales before
 * subtracting — no rounding is applied, so the result is always exact.
 *
 * @example
 * subtractDecimals("10.50", "2.25")  // "8.25"
 * subtractDecimals("2",     "5")     // "-3"
 * subtractDecimals("5",     "5")     // "0"   (no trailing -0)
 */
export function subtractDecimals(a: string, b: string): string {
  const pa = parseDecimalString(a)
  const pb = parseDecimalString(b)
  const scale = Math.max(pa.fracStr.length, pb.fracStr.length)

  const aSigned = (pa.negative ? -1n : 1n) * toScaledMagnitude(pa, scale)
  const bSigned = (pb.negative ? -1n : 1n) * toScaledMagnitude(pb, scale)
  const diff = aSigned - bSigned

  const formatted = formatScaledInt(diff < 0n ? -diff : diff, scale)
  return diff < 0n ? `-${formatted}` : formatted
}

/**
 * Divide two decimal strings, rounding the quotient to a caller-specified
 * scale using the given rounding mode.
 *
 * Arithmetic is performed on exact BigInt numerators/denominators — the
 * quotient is never approximated via floating point, so repeating decimals
 * (e.g. 1/3) round correctly at any requested scale.
 *
 * @param a     - Dividend as a decimal string.
 * @param b     - Divisor as a decimal string. Must not be zero.
 * @param scale - Number of fractional digits in the result (≥ 0).
 * @param mode  - Rounding mode (defaults to HALF_UP).
 * @throws {DivisionByZeroError} If `b` is zero.
 *
 * @example
 * divideDecimals("10", "4", 2)                          // "2.50"
 * divideDecimals("1",  "3", 6)                          // "0.333333"
 * divideDecimals("10", "3", 2, RoundingMode.DOWN)       // "3.33"
 * divideDecimals("-10", "4", 2)                         // "-2.50"
 * divideDecimals("1",  "0", 2)                          // throws DivisionByZeroError
 */
export function divideDecimals(
  a: string,
  b: string,
  scale: number,
  mode: RoundingMode = DEFAULT_ROUNDING_MODE,
): string {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new Error(`scale must be a non-negative integer, got: ${scale}`)
  }

  const pa = parseDecimalString(a)
  const pb = parseDecimalString(b)

  const numerator = BigInt(pa.intStr + pa.fracStr)
  const denominator = BigInt(pb.intStr + pb.fracStr)
  if (denominator === 0n) {
    throw new DivisionByZeroError(a, b)
  }

  // a/b = (numerator / 10^aScale) / (denominator / 10^bScale)
  //     = numerator * 10^(scale + bScale - aScale) / denominator
  const shift = scale + pb.fracStr.length - pa.fracStr.length
  const scaledNumerator = shift >= 0 ? numerator * 10n ** BigInt(shift) : numerator
  const divisor = shift >= 0 ? denominator : denominator * 10n ** BigInt(-shift)

  const truncated = scaledNumerator / divisor
  const remainder = scaledNumerator % divisor
  const rounded = applyDivisionRounding(truncated, remainder, divisor, mode)

  const negative = pa.negative !== pb.negative
  const formatted = formatScaledInt(rounded, scale)
  return negative && rounded !== 0n ? `-${formatted}` : formatted
}

/**
 * Validate that a decimal string is representable, exactly and without
 * rounding, by a Postgres `NUMERIC(precision, scale)` column — the same
 * bounds Postgres itself enforces for that column type.
 *
 * Two independent conditions are checked, each with its own error so
 * callers (and tests) can distinguish "wrong shape" from "too big":
 *
 * 1. **Scale** — the value must not carry more fractional digits than
 *    `scale`. Postgres does not error on this; it silently rounds, which is
 *    exactly the kind of silent precision loss financial code must reject
 *    explicitly instead.
 * 2. **Overflow** — the value's integer part must fit within
 *    `precision - scale` digits, matching Postgres's own
 *    `22003 numeric_field_overflow` boundary. Checking it here lets the
 *    caller reject the operation before acquiring any lock or writing any
 *    state, with a typed error instead of a raw driver exception.
 *
 * This performs no rounding and no floating-point conversion; digit counts
 * are computed directly from the decimal string.
 *
 * @param value     - Decimal string to validate (e.g. "10.50", "-3").
 * @param precision - Total significant digits allowed by the column (> 0).
 * @param scale     - Fractional digits allowed by the column (0 ≤ scale ≤ precision).
 * @throws {Error}              if `value` is not a syntactically valid decimal string.
 * @throws {DecimalScaleError}    if `value` has more than `scale` fractional digits.
 * @throws {DecimalOverflowError} if `value`'s integer part exceeds `precision - scale` digits.
 *
 * @example
 * assertWithinNumericBounds("1.5", 36, 18)              // ok
 * assertWithinNumericBounds("0.0000000000000000001", 36, 18) // throws DecimalScaleError (19 > 18)
 * assertWithinNumericBounds("9".repeat(19), 36, 18)     // throws DecimalOverflowError (19 > 18 int digits)
 * assertWithinNumericBounds("0", 36, 18)                // ok (zero always fits)
 */
export function assertWithinNumericBounds(
  value: string,
  precision: number,
  scale: number,
): void {
  if (!Number.isInteger(precision) || precision <= 0) {
    throw new Error(`precision must be a positive integer, got: ${precision}`)
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
    throw new Error(
      `scale must be an integer in [0, precision], got: ${scale}`,
    )
  }

  const { intStr, fracStr } = parseDecimalString(value)

  if (fracStr.length > scale) {
    throw new DecimalScaleError(value, scale, fracStr.length)
  }

  // Strip leading zeros before counting significant integer digits so that
  // "0007" (4 chars) correctly counts as 1 digit, not 4 — and an integer
  // part that is entirely zero ("0", "00", ...) counts as 0 digits, since
  // Postgres does not charge precision for a value with no integer part
  // (e.g. NUMERIC(1,1) legitimately holds "0.9").
  const strippedIntStr = intStr.replace(/^0+/, '')
  const significantIntDigits = strippedIntStr.length
  const maxIntDigits = precision - scale

  if (significantIntDigits > maxIntDigits) {
    throw new DecimalOverflowError(value, precision, scale)
  }
}

/**
 * Compare two decimal strings exactly, without ever converting to Number.
 *
 * @returns `-1` if `a < b`, `1` if `a > b`, `0` if they are numerically equal.
 *
 * @example
 * compareDecimals("1.50", "1.5")    // 0   (trailing zeros don't matter)
 * compareDecimals("-1",   "1")      // -1
 * compareDecimals("0.30", "0.1")    // 1
 */
export function compareDecimals(a: string, b: string): -1 | 0 | 1 {
  const pa = parseDecimalString(a)
  const pb = parseDecimalString(b)
  const scale = Math.max(pa.fracStr.length, pb.fracStr.length)

  const aSigned = (pa.negative ? -1n : 1n) * toScaledMagnitude(pa, scale)
  const bSigned = (pb.negative ? -1n : 1n) * toScaledMagnitude(pb, scale)

  if (aSigned < bSigned) return -1
  if (aSigned > bSigned) return 1
  return 0
}
