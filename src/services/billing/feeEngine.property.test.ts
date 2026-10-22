import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { calculateFee, applyFees } from './feeEngine.js'
import { getCurrencyScale } from './types.js'
import {
  RoundingMode,
  divideDecimals,
  multiplyDecimals,
  compareDecimals,
  addDecimals,
  roundToScale,
} from '../../lib/decimalMath.js'

// Set a fixed seed for reproducibility across CI/CD and local environments.
const SEED = 42
fc.configureGlobal({ seed: SEED })

describe('Billing Fee Engine Property Tests', () => {
  // ---------------------------------------------------------------------------
  // Generators
  // ---------------------------------------------------------------------------

  /**
   * Generates a valid non-negative decimal string:
   * - Integer part: up to 999,999,999 to cover large numbers.
   * - Fractional part: 0 to 8 digits, using an array of random digits to cover
   *   leading zeros, trailing zeros, and mid-range decimals.
   */
  const decimalStringArb = fc
    .tuple(
      fc.integer({ min: 0, max: 999_999_999 }),
      fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 8 }),
    )
    .map(([intPart, fracDigits]) => {
      if (fracDigits.length === 0) {
        return intPart.toString()
      }
      return `${intPart}.${fracDigits.join('')}`
    })

  /**
   * Generates a valid rate percentage decimal string:
   * - Range: 0 to 1000 (representing 0% to 1000% fee rate).
   * - Fractional digits: 0 to 6 digits to cover high-precision fee rates.
   */
  const rateStringArb = fc
    .tuple(
      fc.integer({ min: 0, max: 1000 }),
      fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 6 }),
    )
    .map(([intPart, fracDigits]) => {
      if (fracDigits.length === 0) {
        return intPart.toString()
      }
      return `${intPart}.${fracDigits.join('')}`
    })

  /**
   * Generates a currency code spanning various target scales:
   * - JPY, KRW (scale 0)
   * - USD, EUR, XYZ (scale 2, where XYZ tests the fallback default scale)
   * - KWD, BHD, OMR, JOD (scale 3)
   */
  const currencyArb = fc.constantFrom(
    'USD',
    'EUR',
    'JPY',
    'KRW',
    'KWD',
    'BHD',
    'OMR',
    'JOD',
    'XYZ',
  )

  /**
   * Generates all supported rounding modes.
   */
  const roundingModeArb = fc.constantFrom(
    RoundingMode.HALF_UP,
    RoundingMode.HALF_DOWN,
    RoundingMode.HALF_EVEN,
    RoundingMode.DOWN,
    RoundingMode.UP,
  )

  /**
   * Generates invalid decimal strings to check robustness:
   * - Negative numbers.
   * - Alphabetical and special character inputs.
   * - Malformed decimal notation (multiple periods, space, etc.).
   */
  const invalidDecimalStringArb = fc.oneof(
    // Negative numbers
    decimalStringArb.filter((s) => s !== '0' && !s.startsWith('0.')).map((s) => `-${s}`),
    // Alphabetical / Garbage strings
    fc.string({ minLength: 1 }).filter((s) => !/^\s*\d+(\.\d*)?\s*$/.test(s)),
    // Malformed decimals
    fc.constantFrom('.', '..', '1..5', '1.2.3', '1a', 'a1', '1.0a', '-0'),
  )

  // ---------------------------------------------------------------------------
  // Reference Rational Implementation & Helpers
  // ---------------------------------------------------------------------------

  function referenceRationalFee(
    baseAmount: string,
    ratePercent: string,
    scale: number,
    mode: RoundingMode,
  ): string {
    const parseDigits = (s: string) => {
      const [intPart, fracPart = ''] = s.trim().split('.')
      return {
        unscaled: BigInt(intPart + fracPart),
        fracLen: fracPart.length,
      }
    }

    const b = parseDigits(baseAmount)
    const r = parseDigits(ratePercent)

    const n = b.unscaled * r.unscaled * (10n ** BigInt(scale))
    const d = (10n ** BigInt(b.fracLen + r.fracLen)) * 100n

    const q = n / d
    const rem = n % d
    const twoRem = 2n * rem

    let rounded: bigint
    switch (mode) {
      case RoundingMode.DOWN:
        rounded = q
        break
      case RoundingMode.UP:
        rounded = rem > 0n ? q + 1n : q
        break
      case RoundingMode.HALF_UP:
        rounded = twoRem >= d ? q + 1n : q
        break
      case RoundingMode.HALF_DOWN:
        rounded = twoRem > d ? q + 1n : q
        break
      case RoundingMode.HALF_EVEN:
        if (twoRem > d) rounded = q + 1n
        else if (twoRem < d) rounded = q
        else rounded = q % 2n === 0n ? q : q + 1n
        break
    }

    if (scale === 0) return rounded.toString()
    const sf = 10n ** BigInt(scale)
    return `${rounded / sf}.${(rounded % sf).toString().padStart(scale, '0')}`
  }

  /**
   * Proxy function to add two decimal strings using the private addMoneyStrings helper.
   * To adhere to testing constraints, we proxy through the public calculateFee surface:
   * By setting base = aNorm and ratePercent = (bNorm / aNorm) * 100 computed with
   * 50 decimal places of precision, computeRawFee computes the fee as exactly bNorm,
   * and calculateFee returns totalAmount = addMoneyStrings(aNorm, bNorm, scale).
   */
  function testAdd(a: string, b: string, currency: string): string {
    const scale = getCurrencyScale(currency)
    const aNorm = roundToScale(a, scale, RoundingMode.DOWN)
    const bNorm = roundToScale(b, scale, RoundingMode.DOWN)

    const aBig = BigInt(aNorm.replace('.', ''))
    const bBig = BigInt(bNorm.replace('.', ''))

    if (aBig === 0n) {
      return bNorm
    }
    if (bBig === 0n) {
      return aNorm
    }

    const ratePercent = divideDecimals(
      multiplyDecimals(bNorm, '100'),
      aNorm,
      50,
      RoundingMode.HALF_UP,
    )

    const result = calculateFee({
      base: { amount: aNorm, currency },
      ratePercent,
    })

    return result.totalAmount.amount
  }

  // ---------------------------------------------------------------------------
  // Property Invariant Tests
  // ---------------------------------------------------------------------------

  /**
   * TSDoc: Invariant - Exact Rational Reference Equivalence (1,000 runs)
   *
   * For random base/rate strings and currencies, each rounding mode's feeAmount
   * matches a direct rational reference implementation comparing 2r against d.
   */
  it('should match the exact rational reference implementation across all rounding modes', () => {
    fc.assert(
      fc.property(
        decimalStringArb,
        rateStringArb,
        currencyArb,
        roundingModeArb,
        (rawAmount, rate, currency, mode) => {
          const scale = getCurrencyScale(currency)
          const baseAmount = roundToScale(rawAmount, scale, RoundingMode.DOWN)

          const actual = calculateFee(
            { base: { amount: baseAmount, currency }, ratePercent: rate },
            mode,
          ).feeAmount.amount
          const expected = referenceRationalFee(baseAmount, rate, scale, mode)

          expect(actual).toBe(expected)
        },
      ),
      { numRuns: 1000 },
    )
  })

  /**
   * TSDoc: Invariant - Rounding Mode Ordering & 1-Minor-Unit Bound (1,000 runs)
   *
   * For every input: DOWN <= HALF_DOWN <= HALF_UP <= UP, DOWN <= HALF_EVEN <= UP,
   * and (UP - DOWN) is either 0 or 1 minor unit.
   */
  it('should satisfy DOWN <= HALF_* <= UP and UP - DOWN in {0, 1 minor unit}', () => {
    fc.assert(
      fc.property(
        decimalStringArb,
        rateStringArb,
        currencyArb,
        (rawAmount, rate, currency) => {
          const scale = getCurrencyScale(currency)
          const baseAmount = roundToScale(rawAmount, scale, RoundingMode.DOWN)
          const input = { base: { amount: baseAmount, currency }, ratePercent: rate }

          const down = calculateFee(input, RoundingMode.DOWN).feeAmount.amount
          const halfDown = calculateFee(input, RoundingMode.HALF_DOWN).feeAmount.amount
          const halfEven = calculateFee(input, RoundingMode.HALF_EVEN).feeAmount.amount
          const halfUp = calculateFee(input, RoundingMode.HALF_UP).feeAmount.amount
          const up = calculateFee(input, RoundingMode.UP).feeAmount.amount

          expect(compareDecimals(down, halfDown)).toBeLessThanOrEqual(0)
          expect(compareDecimals(down, halfEven)).toBeLessThanOrEqual(0)
          expect(compareDecimals(down, halfUp)).toBeLessThanOrEqual(0)
          expect(compareDecimals(halfDown, halfUp)).toBeLessThanOrEqual(0)
          expect(compareDecimals(halfDown, up)).toBeLessThanOrEqual(0)
          expect(compareDecimals(halfEven, up)).toBeLessThanOrEqual(0)
          expect(compareDecimals(halfUp, up)).toBeLessThanOrEqual(0)

          const downMinor = BigInt(down.replace('.', ''))
          const upMinor = BigInt(up.replace('.', ''))
          const diff = upMinor - downMinor
          expect(diff === 0n || diff === 1n).toBe(true)
        },
      ),
      { numRuns: 1000 },
    )
  })

  /**
   * TSDoc: Invariant - applyFees (fee + net == gross)
   *
   * For every generated non-negative decimal amount, list of rates, currency,
   * and rounding mode:
   * The sum of baseAmount (net) and feeAmount (fee) must equal totalAmount (gross).
   */
  it('should satisfy fee + net == gross for applyFees', () => {
    fc.assert(
      fc.property(
        decimalStringArb,
        fc.array(rateStringArb, { minLength: 0, maxLength: 5 }),
        currencyArb,
        roundingModeArb,
        (amount, rates, currency, roundingMode) => {
          const scale = getCurrencyScale(currency)
          const normAmount = roundToScale(amount, scale, RoundingMode.DOWN)
          const base = { amount: normAmount, currency }
          const result = applyFees(base, rates, roundingMode)

          const sum = addDecimals(result.baseAmount.amount, result.feeAmount.amount)
          expect(compareDecimals(sum, result.totalAmount.amount)).toBe(0)
        },
      ),
      { numRuns: 1000 },
    )
  })

  /**
   * TSDoc: Invariant - addMoneyStrings Commutativity
   *
   * For any generated non-negative decimal values a and b under a fixed currency scale,
   * addMoneyStrings(a, b) must equal addMoneyStrings(b, a).
   */
  it('should satisfy commutativity of addition (add(a, b) == add(b, a))', () => {
    fc.assert(
      fc.property(
        decimalStringArb,
        decimalStringArb,
        currencyArb,
        (a, b, currency) => {
          const sum1 = testAdd(a, b, currency)
          const sum2 = testAdd(b, a, currency)
          expect(sum1).toBe(sum2)
        },
      ),
      { numRuns: 1000 },
    )
  })

  /**
   * TSDoc: Invariant - addMoneyStrings Associativity
   *
   * For any generated non-negative decimal values a, b, and c under a fixed currency scale,
   * addMoneyStrings(addMoneyStrings(a, b), c) must equal addMoneyStrings(a, addMoneyStrings(b, c)).
   */
  it('should satisfy associativity of addition (add(add(a, b), c) == add(a, add(b, c)))', () => {
    fc.assert(
      fc.property(
        decimalStringArb,
        decimalStringArb,
        decimalStringArb,
        currencyArb,
        (a, b, c, currency) => {
          const sum1 = testAdd(testAdd(a, b, currency), c, currency)
          const sum2 = testAdd(a, testAdd(b, c, currency), currency)
          expect(sum1).toBe(sum2)
        },
      ),
      { numRuns: 500 },
    )
  })

  /**
   * TSDoc: Invariant - calculateFee Monotonicity
   *
   * For any fixed rate, calculateFee must be monotonic non-decreasing in the amount.
   * If amount1 <= amount2, then feeAmount(amount1) <= feeAmount(amount2).
   */
  it('should be monotonic non-decreasing in the amount for a fixed rate', () => {
    fc.assert(
      fc.property(
        decimalStringArb, // amount1
        decimalStringArb, // delta (non-negative)
        rateStringArb,    // rate
        currencyArb,
        roundingModeArb,
        (amount1, delta, rate, currency, roundingMode) => {
          const scale = getCurrencyScale(currency)
          const normAmount1 = roundToScale(amount1, scale, RoundingMode.DOWN)
          const normDelta = roundToScale(delta, scale, RoundingMode.DOWN)
          const normAmount2 = addDecimals(normAmount1, normDelta)

          const fee1 = calculateFee({ base: { amount: normAmount1, currency }, ratePercent: rate }, roundingMode)
          const fee2 = calculateFee({ base: { amount: normAmount2, currency }, ratePercent: rate }, roundingMode)

          const cmp = compareDecimals(fee1.feeAmount.amount, fee2.feeAmount.amount)
          expect(cmp).toBeLessThanOrEqual(0)
        },
      ),
      { numRuns: 1000 },
    )
  })

  /**
   * TSDoc: Invariant - parseNonNegativeDecimal Error Handling
   *
   * parseNonNegativeDecimal must reject negative, NaN, and malformed strings.
   * Verified by ensuring calculateFee throws when such values are passed as ratePercent.
   */
  it('should reject negative, NaN, and malformed ratePercent strings', () => {
    fc.assert(
      fc.property(
        invalidDecimalStringArb,
        currencyArb,
        (invalidRate, currency) => {
          const scale = getCurrencyScale(currency)
          const baseAmount = scale === 0 ? '100' : `100.${'0'.repeat(scale)}`
          expect(() =>
            calculateFee({
              base: { amount: baseAmount, currency },
              ratePercent: invalidRate,
            }),
          ).toThrow()
        },
      ),
      { numRuns: 500 },
    )
  })

  /**
   * TSDoc: Invariant - parseNonNegativeDecimal Round-Trip
   *
   * parseNonNegativeDecimal must parse valid non-negative decimal strings correctly.
   * Verified by ensuring a base-100 fee calculation round-trips the normalized ratePercent.
   */
  it('should round-trip valid non-negative decimal strings', () => {
    fc.assert(
      fc.property(
        decimalStringArb,
        currencyArb,
        (rate, currency) => {
          const scale = getCurrencyScale(currency)
          const rateNorm = roundToScale(rate, scale, RoundingMode.DOWN)

          const baseAmount = scale === 0 ? '100' : `100.${'0'.repeat(scale)}`

          const result = calculateFee(
            {
              base: { amount: baseAmount, currency },
              ratePercent: rateNorm,
            },
            RoundingMode.DOWN,
          )

          expect(result.feeAmount.amount).toBe(rateNorm)
        },
      ),
      { numRuns: 1000 },
    )
  })

  /**
   * TSDoc: Invariant - Precision Preservation
   *
   * No result ever loses precision relative to the configured scale.
   * If the exact intermediate product `base * rate / 100` is exactly representable
   * within the target scale, the computed fee must equal the exact value.
   */
  it('should not lose precision if the result is exactly representable at the configured scale', () => {
    fc.assert(
      fc.property(
        decimalStringArb,
        rateStringArb,
        currencyArb,
        (amount, rate, currency) => {
          const scale = getCurrencyScale(currency)
          const baseAmountNorm = roundToScale(amount, scale, RoundingMode.DOWN)

          const exactFee = divideDecimals(
            multiplyDecimals(baseAmountNorm, rate),
            '100',
            scale + 10,
            RoundingMode.DOWN,
          )

          const parts = exactFee.split('.')
          const fracDigits = parts[1] || ''
          const extraFrac = fracDigits.slice(scale)
          const hasExtraPrecision = /[1-9]/.test(extraFrac)

          if (!hasExtraPrecision) {
            const result = calculateFee(
              { base: { amount: baseAmountNorm, currency }, ratePercent: rate },
              RoundingMode.HALF_UP,
            )
            const expectedFee = roundToScale(exactFee, scale, RoundingMode.DOWN)
            expect(result.feeAmount.amount).toBe(expectedFee)
          }
        },
      ),
      { numRuns: 1000 },
    )
  })
})
