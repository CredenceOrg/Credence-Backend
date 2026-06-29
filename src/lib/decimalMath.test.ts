/**
 * Unit tests for decimal-safe arithmetic utilities.
 *
 * Table-driven tests cover boundary values, rounding modes, sign handling,
 * scale edge cases, and multi-precision inputs.
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  roundToScale,
  multiplyDecimals,
  addDecimals,
  subtractDecimals,
  divideDecimals,
  compareDecimals,
  DivisionByZeroError,
  RoundingMode,
  DEFAULT_ROUNDING_MODE,
} from './decimalMath.js'

describe('decimalMath', () => {
  describe('DEFAULT_ROUNDING_MODE', () => {
    it('should be HALF_UP', () => {
      expect(DEFAULT_ROUNDING_MODE).toBe(RoundingMode.HALF_UP)
    })
  })

  describe('roundToScale', () => {
    describe('HALF_UP (default) — boundary table', () => {
      const cases: Array<[string | number, number, string]> = [
        // Exact — no rounding needed
        ['10.00', 2, '10.00'],
        ['0.00', 2, '0.00'],
        ['1', 0, '1'],
        ['1.5', 0, '2'],   // .5 rounds up
        ['2.5', 0, '3'],
        ['3.5', 0, '4'],
        // Below midpoint — truncate
        ['10.554', 2, '10.55'],
        ['10.444', 2, '10.44'],
        ['0.004', 2, '0.00'],
        // At midpoint — rounds up
        ['10.555', 2, '10.56'],
        ['0.005', 2, '0.01'],
        ['0.015', 2, '0.02'],
        ['0.025', 2, '0.03'],
        ['0.995', 2, '1.00'],
        // Above midpoint — rounds up
        ['10.556', 2, '10.56'],
        // Scale 0 (JPY-style)
        ['99.4', 0, '99'],
        ['99.5', 0, '100'],
        ['99.9', 0, '100'],
        // Scale 3 (KWD-style)
        ['1.2345', 3, '1.235'],
        ['1.2344', 3, '1.234'],
        // Numeric input
        [10.555, 2, '10.56'],
        [0.1 + 0.2, 2, '0.30'], // classic float pitfall
        // Large values
        ['999999.995', 2, '1000000.00'],
        // Whole numbers
        ['42', 2, '42.00'],
        ['42', 0, '42'],
      ]

      it.each(cases)('roundToScale(%s, %i) → %s', (input, scale, expected) => {
        expect(roundToScale(input, scale)).toBe(expected)
      })
    })

    describe('HALF_DOWN — boundary table', () => {
      const cases: Array<[string, number, string]> = [
        ['10.555', 2, '10.55'],  // exactly .5 rounds down
        ['10.556', 2, '10.56'],  // above .5 rounds up
        ['10.554', 2, '10.55'],  // below .5 truncates
        ['0.005', 2, '0.00'],    // exactly .5 rounds down
        ['0.006', 2, '0.01'],    // above .5 rounds up
        ['2.5', 0, '2'],         // half rounds down
        ['3.5', 0, '3'],
      ]

      it.each(cases)('roundToScale(%s, %i, HALF_DOWN) → %s', (input, scale, expected) => {
        expect(roundToScale(input, scale, RoundingMode.HALF_DOWN)).toBe(expected)
      })
    })

    describe('HALF_EVEN (banker\'s rounding) — boundary table', () => {
      const cases: Array<[string, number, string]> = [
        // Half rounds to nearest even
        ['0.5', 0, '0'],   // 0 is even
        ['1.5', 0, '2'],   // 2 is even
        ['2.5', 0, '2'],   // 2 is even
        ['3.5', 0, '4'],   // 4 is even
        ['4.5', 0, '4'],   // 4 is even
        ['5.5', 0, '6'],
        // Scale 2
        ['10.545', 2, '10.54'],  // 4 is even
        ['10.555', 2, '10.56'],  // 6 is even
        ['10.565', 2, '10.56'],  // 6 is even
        ['10.575', 2, '10.58'],  // 8 is even
        // Non-half — standard truncation/round
        ['10.554', 2, '10.55'],
        ['10.556', 2, '10.56'],
      ]

      it.each(cases)('roundToScale(%s, %i, HALF_EVEN) → %s', (input, scale, expected) => {
        expect(roundToScale(input, scale, RoundingMode.HALF_EVEN)).toBe(expected)
      })
    })

    describe('DOWN (truncate toward zero) — boundary table', () => {
      const cases: Array<[string, number, string]> = [
        ['10.999', 2, '10.99'],
        ['10.001', 2, '10.00'],
        ['0.009', 2, '0.00'],
        ['1.999', 0, '1'],
        ['99.9',  0, '99'],
      ]

      it.each(cases)('roundToScale(%s, %i, DOWN) → %s', (input, scale, expected) => {
        expect(roundToScale(input, scale, RoundingMode.DOWN)).toBe(expected)
      })
    })

    describe('UP (round away from zero) — boundary table', () => {
      const cases: Array<[string, number, string]> = [
        ['10.001', 2, '10.01'],
        ['10.000', 2, '10.00'],  // exact — no UP needed
        ['0.001', 2, '0.01'],
        ['1.001', 0, '2'],
        ['1.000', 0, '1'],
      ]

      it.each(cases)('roundToScale(%s, %i, UP) → %s', (input, scale, expected) => {
        expect(roundToScale(input, scale, RoundingMode.UP)).toBe(expected)
      })
    })

    describe('negative values', () => {
      const cases: Array<[string, number, RoundingMode, string]> = [
        ['-10.555', 2, RoundingMode.HALF_UP,   '-10.56'],  // away from zero
        ['-10.555', 2, RoundingMode.HALF_DOWN, '-10.55'],
        ['-10.555', 2, RoundingMode.HALF_EVEN, '-10.56'],  // 6 is even
        ['-10.545', 2, RoundingMode.HALF_EVEN, '-10.54'],  // 4 is even
        ['-10.999', 2, RoundingMode.DOWN,       '-10.99'], // toward zero
        ['-10.001', 2, RoundingMode.UP,         '-10.01'], // away from zero
        ['-0.005',  2, RoundingMode.HALF_UP,    '-0.01'],
        ['-0.004',  2, RoundingMode.HALF_UP,    '0.00'],   // rounds to zero — no sign
      ]

      it.each(cases)(
        'roundToScale(%s, %i, %s) → %s',
        (input, scale, mode, expected) => {
          expect(roundToScale(input, scale, mode)).toBe(expected)
        },
      )
    })

    describe('scale = 0', () => {
      it('returns integer string with no decimal point', () => {
        expect(roundToScale('42.7', 0)).toBe('43')
        expect(roundToScale('42.3', 0)).toBe('42')
        expect(roundToScale('42', 0)).toBe('42')
      })
    })

    describe('high input precision', () => {
      it('handles more input digits than scale', () => {
        expect(roundToScale('1.123456789', 2)).toBe('1.12')
        expect(roundToScale('1.125000001', 2)).toBe('1.13')
      })

      it('pads when input has fewer digits than scale', () => {
        expect(roundToScale('1.1', 4)).toBe('1.1000')
        expect(roundToScale('1', 3)).toBe('1.000')
      })
    })

    describe('error handling', () => {
      it('throws for negative scale', () => {
        expect(() => roundToScale('1.5', -1)).toThrow()
      })

      it('throws for non-integer scale', () => {
        expect(() => roundToScale('1.5', 1.5 as unknown as number)).toThrow()
      })

      it('throws for invalid decimal string', () => {
        expect(() => roundToScale('abc', 2)).toThrow()
        expect(() => roundToScale('1.2.3', 2)).toThrow()
      })
    })
  })

  describe('multiplyDecimals', () => {
    describe('exact multiplication table', () => {
      const cases: Array<[string, string, string]> = [
        ['10.55', '2.5',  '26.375'],
        ['1',     '1',    '1'],
        ['3',     '0.1',  '0.3'],
        ['0.1',   '0.1',  '0.01'],
        ['100',   '0.01', '1.00'],
        ['1.5',   '2',    '3.0'],
        ['0',     '999',  '0'],
        ['0.5',   '0.5',  '0.25'],
        ['1000',  '1000', '1000000'],
      ]

      it.each(cases)('multiplyDecimals(%s, %s) → %s', (a, b, expected) => {
        expect(multiplyDecimals(a, b)).toBe(expected)
      })
    })

    it('sign: positive × positive', () => {
      expect(multiplyDecimals('2', '3')).toBe('6')
    })

    it('preserves trailing zeros in fractional scale', () => {
      // "1.0" has fracStr length 1, "2.0" has fracStr length 1 → scale 2
      expect(multiplyDecimals('1.0', '2.0')).toBe('2.00')
    })
  })

  describe('addDecimals', () => {
    describe('exact addition table', () => {
      const cases: Array<[string, string, string]> = [
        ['10.50', '2.25', '12.75'],
        ['0.1', '0.2', '0.3'],
        ['1', '1', '2'],
        ['0', '0', '0'],
        ['100', '0.01', '100.01'],
        // Mismatched scales
        ['1.1', '2.22', '3.32'],
        ['1', '0.001', '1.001'],
        // Negative operands
        ['-5', '3', '-2'],
        ['5', '-3', '2'],
        ['-5', '-3', '-8'],
        // Crosses zero — must not produce "-0"
        ['-3', '3', '0'],
        ['3', '-3', '0'],
        ['-0.5', '0.5', '0.0'],
      ]

      it.each(cases)('addDecimals(%s, %s) → %s', (a, b, expected) => {
        expect(addDecimals(a, b)).toBe(expected)
      })
    })
  })

  describe('subtractDecimals', () => {
    describe('exact subtraction table', () => {
      const cases: Array<[string, string, string]> = [
        ['10.50', '2.25', '8.25'],
        ['1', '1', '0'],
        ['2', '5', '-3'],
        ['0', '0', '0'],
        ['100.01', '0.01', '100.00'],
        // Mismatched scales
        ['3.32', '1.1', '2.22'],
        ['1.001', '1', '0.001'],
        // Negative operands
        ['-5', '3', '-8'],
        ['5', '-3', '8'],
        ['-5', '-3', '-2'],
        // Crosses zero — must not produce "-0"
        ['5', '5', '0'],
        ['-2.5', '-2.5', '0.0'],
      ]

      it.each(cases)('subtractDecimals(%s, %s) → %s', (a, b, expected) => {
        expect(subtractDecimals(a, b)).toBe(expected)
      })
    })
  })

  describe('compareDecimals', () => {
    const cases: Array<[string, string, -1 | 0 | 1]> = [
      ['1', '1', 0],
      ['1.50', '1.5', 0],   // trailing zeros don't matter
      ['0', '-0.0', 0],     // signed zero is still zero
      ['1', '2', -1],
      ['-1', '1', -1],
      ['0.30', '0.1', 1],
      ['2', '1', 1],
      ['-1', '-2', 1],
      ['-2', '-1', -1],
    ]

    it.each(cases)('compareDecimals(%s, %s) → %i', (a, b, expected) => {
      expect(compareDecimals(a, b)).toBe(expected)
    })
  })

  describe('divideDecimals', () => {
    describe('exact and rounded division table (HALF_UP default)', () => {
      const cases: Array<[string, string, number, string]> = [
        ['10', '4', 2, '2.50'],
        ['10', '3', 2, '3.33'],
        ['1', '3', 6, '0.333333'],      // repeating decimal
        ['2', '3', 6, '0.666667'],      // repeating decimal, rounds up
        ['1', '4', 0, '0'],             // 0.25 rounds down to 0 at scale 0
        ['3', '4', 0, '1'],             // 0.75 rounds up to 1 at scale 0
        ['100', '10', 2, '10.00'],
        ['0', '5', 2, '0.00'],
        ['7', '2', 0, '4'],             // 3.5 rounds up (HALF_UP)
      ]

      it.each(cases)('divideDecimals(%s, %s, %i) → %s', (a, b, scale, expected) => {
        expect(divideDecimals(a, b, scale)).toBe(expected)
      })
    })

    describe('rounding modes', () => {
      const cases: Array<[string, string, number, RoundingMode, string]> = [
        ['10', '3', 2, RoundingMode.DOWN, '3.33'],
        ['10', '3', 2, RoundingMode.UP, '3.34'],
        ['7', '2', 0, RoundingMode.HALF_DOWN, '3'],     // 3.5 rounds down
        ['7', '2', 0, RoundingMode.HALF_EVEN, '4'],     // 3.5 → nearest even (4)
        ['9', '2', 0, RoundingMode.HALF_EVEN, '4'],     // 4.5 → nearest even (4)
        ['1', '3', 0, RoundingMode.DOWN, '0'],
      ]

      it.each(cases)(
        'divideDecimals(%s, %s, %i, %s) → %s',
        (a, b, scale, mode, expected) => {
          expect(divideDecimals(a, b, scale, mode)).toBe(expected)
        },
      )
    })

    describe('sign handling', () => {
      const cases: Array<[string, string, number, string]> = [
        ['-10', '4', 2, '-2.50'],
        ['10', '-4', 2, '-2.50'],
        ['-10', '-4', 2, '2.50'],
        ['-1', '4', 2, '-0.25'],
        // Rounds to exactly zero — must not produce "-0"
        ['-1', '1000000', 2, '0.00'],
      ]

      it.each(cases)('divideDecimals(%s, %s, %i) → %s', (a, b, scale, expected) => {
        expect(divideDecimals(a, b, scale)).toBe(expected)
      })
    })

    describe('mismatched input scales', () => {
      it('handles a divisor with more fractional digits than the dividend', () => {
        expect(divideDecimals('10', '2.5', 2)).toBe('4.00')
      })

      it('handles a dividend with more fractional digits than the divisor', () => {
        expect(divideDecimals('10.5', '5', 2)).toBe('2.10')
      })
    })

    describe('error handling', () => {
      it('throws DivisionByZeroError when dividing by "0"', () => {
        expect(() => divideDecimals('1', '0', 2)).toThrow(DivisionByZeroError)
      })

      it('throws DivisionByZeroError when dividing by "0.00"', () => {
        expect(() => divideDecimals('1', '0.00', 2)).toThrow(DivisionByZeroError)
      })

      it('throws DivisionByZeroError when dividing by "-0"', () => {
        expect(() => divideDecimals('1', '-0', 2)).toThrow(DivisionByZeroError)
      })

      it('names the error "DivisionByZeroError"', () => {
        try {
          divideDecimals('1', '0', 2)
          expect.unreachable()
        } catch (err) {
          expect((err as Error).name).toBe('DivisionByZeroError')
          expect((err as Error).message).toContain('1')
          expect((err as Error).message).toContain('0')
        }
      })

      it('throws for negative scale', () => {
        expect(() => divideDecimals('1', '2', -1)).toThrow()
      })

      it('throws for non-integer scale', () => {
        expect(() => divideDecimals('1', '2', 1.5 as unknown as number)).toThrow()
      })
    })
  })

  describe('property-based invariants', () => {
    // Generates decimal strings like "123.45", "-7", "0.001" with up to 4
    // fractional digits and magnitudes small enough to keep fast-check
    // shrinking fast while still exercising sign and scale combinations.
    const decimalStringArb = fc
      .tuple(
        fc.boolean(), // negative
        fc.integer({ min: 0, max: 999_999 }), // integer part
        fc.integer({ min: 0, max: 4 }), // fractional digit count
        fc.integer({ min: 0, max: 9999 }), // fractional digits value
      )
      .map(([negative, intPart, fracLen, fracVal]) => {
        const fracStr = fracVal.toString().padStart(4, '0').slice(0, fracLen)
        const magnitude = fracLen > 0 ? `${intPart}.${fracStr}` : `${intPart}`
        const isZero = intPart === 0 && (fracLen === 0 || fracVal === 0)
        return negative && !isZero ? `-${magnitude}` : magnitude
      })

    // Nonzero decimal strings, for use as a divisor.
    const nonZeroDecimalStringArb = decimalStringArb.filter(
      (s) => compareDecimals(s, '0') !== 0,
    )

    it('(a + b) - b === a for arbitrary decimal strings', () => {
      fc.assert(
        fc.property(decimalStringArb, decimalStringArb, (a, b) => {
          const roundTripped = subtractDecimals(addDecimals(a, b), b)
          expect(compareDecimals(roundTripped, a)).toBe(0)
        }),
      )
    })

    it('addDecimals is commutative', () => {
      fc.assert(
        fc.property(decimalStringArb, decimalStringArb, (a, b) => {
          expect(addDecimals(a, b)).toBe(addDecimals(b, a))
        }),
      )
    })

    it('divide (DOWN) then multiply back stays within one unit of the divisor', () => {
      // DOWN truncates toward zero, so the reconstruction error is bounded by
      // exactly one unit-in-the-last-place of the quotient, scaled by |b|:
      // |a - quotient*b| < |b| * 10^-scale.
      fc.assert(
        fc.property(
          decimalStringArb,
          nonZeroDecimalStringArb,
          fc.integer({ min: 0, max: 6 }),
          (a, b, scale) => {
            const quotient = divideDecimals(a, b, scale, RoundingMode.DOWN)
            const reconstructed = multiplyDecimals(quotient, b)
            const diff = subtractDecimals(a, reconstructed)
            const absDiff = diff.startsWith('-') ? diff.slice(1) : diff
            const absB = b.startsWith('-') ? b.slice(1) : b
            const epsilon = scale === 0 ? '1' : `0.${'0'.repeat(scale - 1)}1`
            const bound = multiplyDecimals(absB, epsilon)

            expect(compareDecimals(absDiff, bound)).not.toBe(1)
          },
        ),
      )
    })

    it('compareDecimals matches the sign of subtractDecimals(a, b)', () => {
      fc.assert(
        fc.property(decimalStringArb, decimalStringArb, (a, b) => {
          const cmp = compareDecimals(a, b)
          const diffSign = compareDecimals(subtractDecimals(a, b), '0')
          expect(cmp).toBe(diffSign)
        }),
      )
    })
  })

  describe('property-based rounding & multiply invariants', () => {
    /**
     * Arbitrary decimal strings suitable for decimalMath.
     *
     * - Allows negative values but excludes signed zero (e.g. "-0"), matching library expectations.
     * - Produces varying integer/frac lengths to exercise different scale boundaries.
     */
    const decimalStringArb = fc
      .tuple(
        fc.boolean(), // negative
        fc.integer({ min: 0, max: 999_999 }), // integer part
        fc.integer({ min: 0, max: 12 }), // frac length
        fc.integer({ min: 0, max: 9_999_999_999 }), // frac digits value (trimmed)
      )
      .map(([negative, intPart, fracLen, fracVal]) => {
        const safeFracLen = Math.min(fracLen, 12)
        const fracStr =
          safeFracLen === 0
            ? ''
            : fracVal
                .toString()
                .padStart(safeFracLen, '0')
                .slice(0, safeFracLen)
        const abs =
          safeFracLen > 0 ? `${intPart}.${fracStr}` : `${intPart}`
        const isZero = intPart === 0 && (safeFracLen === 0 || fracVal === 0)
        return negative && !isZero ? `-${abs}` : abs
      })

    const nonZeroDecimalStringArb = decimalStringArb.filter(
      (s) => compareDecimals(s, '0') !== 0,
    )

    /**
     * Builds a scale-specific “expected step” invariant bound.
     * The library operates in base-10 scaled integers, so the ULP at scale
     * `scale` is exactly 10^-scale (or 1 if scale === 0).
     */
    const ulpAtScale = (scale: number): string => {
      if (scale === 0) return '1'
      return `0.${'0'.repeat(scale - 1)}1`
    }

    const getFracLen = (v: string): number => {
      const s = v.trim()
      const dot = s.indexOf('.')
      if (dot === -1) return 0
      return s.length - dot - 1
    }

    const stripSign = (v: string): string => (v.startsWith('-') ? v.slice(1) : v)

    const toScaledBigInt = (v: string): { mag: bigint; scale: number } => {
      const isNeg = v.startsWith('-')
      const abs = stripSign(v)
      const parts = abs.split('.')
      const intPart = parts[0] ?? '0'
      const fracPart = parts[1] ?? ''
      const scale = fracPart.length
      const mag = BigInt((intPart === '' ? '0' : intPart) + fracPart)
      return { mag: isNeg ? -mag : mag, scale }
    }

    const assertNoNegativeZero = (s: string) => {
      expect(s).not.toMatch(/^-0(\.0+)?$/)
    }

    it('roundToScale invariants: HALF modes bound error by ≤ 1 ULP and ordering DOWN ≤ value ≤ UP', () => {
      fc.assert(
        fc.property(
          decimalStringArb,
          fc.integer({ min: 0, max: 12 }),
          (value, targetScale) => {
            const rDown = roundToScale(value, targetScale, RoundingMode.DOWN)
            const rUp = roundToScale(value, targetScale, RoundingMode.UP)
            const rHalfUp = roundToScale(value, targetScale, RoundingMode.HALF_UP)
            const rHalfDown = roundToScale(
              value,
              targetScale,
              RoundingMode.HALF_DOWN,
            )
            const rHalfEven = roundToScale(
              value,
              targetScale,
              RoundingMode.HALF_EVEN,
            )

            // DOWN and UP establish an interval that all other rounding modes must respect.
            const min = compareDecimals(rDown, rUp) <= 0 ? rDown : rUp
            const max = compareDecimals(rDown, rUp) <= 0 ? rUp : rDown
            const within = (x: string) => {
              return compareDecimals(min, x) <= 0 && compareDecimals(x, max) <= 0
            }

            expect(within(rHalfUp)).toBe(true)
            expect(within(rHalfDown)).toBe(true)
            expect(within(rHalfEven)).toBe(true)

            // Error bound: |rounded - exact| ≤ 1 ULP.
            // Compute the exact scaled value by rounding to a larger precision (no rounding loss)
            // then comparing against the library’s scaled integer rounding.
            const { scale: inputScale } = toScaledBigInt(value)
            const safeScale = Math.max(inputScale, targetScale) + 2

            const exactAtSafeScale = roundToScale(value, safeScale, RoundingMode.DOWN)
            const exactRoundedDownToTarget = roundToScale(
              exactAtSafeScale,
              targetScale,
              RoundingMode.DOWN,
            )

            const ulp = ulpAtScale(targetScale)
            const withinOneUlp = (rounded: string) => {
              const diff = subtractDecimals(rounded, exactRoundedDownToTarget)
              const absDiff = diff.startsWith('-') ? diff.slice(1) : diff
              // absDiff ≤ 1 ULP
              return compareDecimals(absDiff, ulp) <= 0
            }

            expect(withinOneUlp(rHalfUp)).toBe(true)
            expect(withinOneUlp(rHalfDown)).toBe(true)
            expect(withinOneUlp(rHalfEven)).toBe(true)

            assertNoNegativeZero(rDown)
            assertNoNegativeZero(rUp)
            assertNoNegativeZero(rHalfUp)
            assertNoNegativeZero(rHalfDown)
            assertNoNegativeZero(rHalfEven)
          },
        ),
        { numRuns: 2000 },
      )
    })

    it("HALF_EVEN produces even last digit at exact midpoints", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 25 }),
          fc.integer({ min: 1, max: 12 }), // target scale >= 1 to exercise fractional midpoint construction
          (lastEvenDigit, targetScale) => {
            const evenDigit = lastEvenDigit % 10
            if (evenDigit % 2 !== 0) return true

            // Construct a value whose discarded digit at targetScale is exactly '5'
            // and the retained last digit is `evenDigit`.
            // Example: scale=2, create 0.<prefix><evenDigit>5 where everything after is 0.
            const prefixInt = '0'
            const retained = `${prefixInt}.${'0'.repeat(Math.max(0, targetScale - 1))}${evenDigit}`
            const value = `${retained}5` // appending '5' creates midpoint at targetScale

            const rounded = roundToScale(value, targetScale, RoundingMode.HALF_EVEN)
            const fracLen = getFracLen(rounded)
            expect(fracLen).toBe(targetScale)

            const lastDigit = rounded[targetScale === 0 ? 0 : rounded.length - 1]
            expect(lastDigit).toBe(String(evenDigit))
            return true
          },
        ),
        { numRuns: 500 },
      )
    })

    it('sign correctness: no -0 output; negative rounding is symmetric for HALF_UP/HALF_DOWN', () => {
      fc.assert(
        fc.property(
          nonZeroDecimalStringArb,
          fc.integer({ min: 0, max: 12 }),
          (value, targetScale) => {
            const pos = value.startsWith('-') ? value.slice(1) : value
            const neg = `-${pos}`

            const rPosUp = roundToScale(pos, targetScale, RoundingMode.HALF_UP)
            const rNegUp = roundToScale(neg, targetScale, RoundingMode.HALF_UP)

            const rPosDown = roundToScale(pos, targetScale, RoundingMode.HALF_DOWN)
            const rNegDown = roundToScale(neg, targetScale, RoundingMode.HALF_DOWN)

            // no -0 anywhere
            assertNoNegativeZero(rPosUp)
            assertNoNegativeZero(rNegUp)
            assertNoNegativeZero(rPosDown)
            assertNoNegativeZero(rNegDown)

            // symmetry: rounding(-x) = -rounding(x) for HALF_UP/HALF_DOWN
            const isZero = (v: string) => compareDecimals(v, '0') === 0
            expect(rNegUp).toBe(isZero(rPosUp) ? rPosUp : `-${rPosUp}`)
            expect(rNegDown).toBe(isZero(rPosDown) ? rPosDown : `-${rPosDown}`)
          },
        ),
        { numRuns: 2000 },
      )
    })

    it('multiplyDecimals exactness: equals BigInt product reference and scale is sum of input scales', () => {
      fc.assert(
        fc.property(
          decimalStringArb,
          decimalStringArb,
          (a, b) => {
            const { mag: aMag, scale: aScale } = toScaledBigInt(a)
            const { mag: bMag, scale: bScale } = toScaledBigInt(b)
            const product = aMag * bMag
            const expectedScale = aScale + bScale

            const out = multiplyDecimals(a, b)
            assertNoNegativeZero(out)

            // verify scale (fraction digits length)
            const outFracLen = getFracLen(out)
            expect(outFracLen).toBe(expectedScale)

            const outScaled = toScaledBigInt(out)
            expect(outScaled.mag).toBe(product)
          },
        ),
        { numRuns: 2000 },
      )
    })

    it('focused regressions: 0.005, 10.545, 2.5 (HALF_EVEN), and large many-digit inputs', () => {
      expect(roundToScale('0.005', 2, RoundingMode.HALF_UP)).toBe('0.01')
      expect(roundToScale('10.545', 2, RoundingMode.HALF_EVEN)).toBe('10.54')
      expect(roundToScale('2.5', 0, RoundingMode.HALF_EVEN)).toBe('2')

      const largeA = '123456789012345678901234567890.12345678901234567890'
      const largeB = '987654321098765432109876543210.54321098765432109876'

      const m = multiplyDecimals(largeA, largeB)
      const { mag: aMag, scale: aScale } = toScaledBigInt(largeA)
      const { mag: bMag, scale: bScale } = toScaledBigInt(largeB)

      expect(multiplyDecimals(largeA, largeB)).toBe(m)
      expect(toScaledBigInt(m).mag).toBe(aMag * bMag)
      expect(getFracLen(m)).toBe(aScale + bScale)
    })
  })

  describe('round-trip invariants for normalize, denormalize, and multiply', () => {
    /**
     * Arbitrary decimal strings with up to 8 fractional digits.
     * Excludes signed zero ("-0") to match library expectations.
     */
    const decimalArb = fc
      .tuple(
        fc.boolean(),
        fc.integer({ min: 0, max: 999_999 }),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 99_999_999 }),
      )
      .map(([negative, intPart, fracLen, fracVal]) => {
        const fracStr =
          fracLen === 0
            ? ''
            : fracVal.toString().padStart(fracLen, '0').slice(0, fracLen)
        const magnitude = fracLen > 0 ? `${intPart}.${fracStr}` : `${intPart}`
        const isZero = intPart === 0 && (fracLen === 0 || fracVal === 0)
        return negative && !isZero ? `-${magnitude}` : magnitude
      })

    const nonZeroDecimalArb = decimalArb.filter(
      (s) => compareDecimals(s, '0') !== 0,
    )

    const getFracLen = (v: string): number => {
      const dot = v.indexOf('.')
      return dot === -1 ? 0 : v.length - dot - 1
    }

    // -- normalize (roundToScale) invariants --------------------------------

    it('roundToScale_is_idempotent_for_all_rounding_modes', () => {
      const modes = [
        RoundingMode.HALF_UP,
        RoundingMode.HALF_DOWN,
        RoundingMode.HALF_EVEN,
        RoundingMode.DOWN,
        RoundingMode.UP,
      ]
      fc.assert(
        fc.property(
          decimalArb,
          fc.integer({ min: 0, max: 10 }),
          fc.constantFrom(...modes),
          (value, scale, mode) => {
            const once = roundToScale(value, scale, mode)
            const twice = roundToScale(once, scale, mode)
            expect(twice).toBe(once)
          },
        ),
        { numRuns: 2000 },
      )
    })

    it('roundToScale_preserves_value_when_input_already_has_fewer_or_equal_fractional_digits', () => {
      fc.assert(
        fc.property(
          decimalArb,
          fc.integer({ min: 0, max: 10 }),
          (value, extraDigits) => {
            const inputFracLen = getFracLen(value)
            const targetScale = inputFracLen + extraDigits
            // Rounding to a wider scale should not change the numeric value.
            const rounded = roundToScale(value, targetScale, RoundingMode.DOWN)
            expect(compareDecimals(rounded, value)).toBe(0)
          },
        ),
        { numRuns: 1000 },
      )
    })

    // -- normalize then denormalize round-trip --------------------------------

    it('normalize_then_widen_scale_preserves_numeric_value', () => {
      fc.assert(
        fc.property(
          decimalArb,
          fc.integer({ min: 0, max: 8 }),
          fc.integer({ min: 0, max: 4 }),
          (value, narrowScale, extraDigits) => {
            const widerScale = narrowScale + extraDigits
            // Normalize to narrower scale, then widen back.
            const normalized = roundToScale(value, narrowScale, RoundingMode.DOWN)
            const widened = roundToScale(normalized, widerScale, RoundingMode.DOWN)
            // The widened result must be numerically equal to the normalized value.
            expect(compareDecimals(widened, normalized)).toBe(0)
          },
        ),
        { numRuns: 1000 },
      )
    })

    it('normalize_DOWN_then_normalize_UP_bounds_original_value', () => {
      fc.assert(
        fc.property(
          decimalArb,
          fc.integer({ min: 0, max: 10 }),
          (value, scale) => {
            const down = roundToScale(value, scale, RoundingMode.DOWN)
            const up = roundToScale(value, scale, RoundingMode.UP)
            // The original value must sit between DOWN and UP (inclusive).
            // For positive values: down <= value <= up
            // For negative values: up <= value <= down (magnitudes reversed)
            const min = compareDecimals(down, up) <= 0 ? down : up
            const max = compareDecimals(down, up) <= 0 ? up : down
            expect(compareDecimals(min, value)).toBeLessThanOrEqual(0)
            expect(compareDecimals(value, max)).toBeLessThanOrEqual(0)
          },
        ),
        { numRuns: 1000 },
      )
    })

    // -- multiply round-trip invariants ---------------------------------------

    it('multiplyDecimals_by_one_preserves_numeric_value', () => {
      fc.assert(
        fc.property(decimalArb, (a) => {
          const result = multiplyDecimals(a, '1')
          expect(compareDecimals(result, a)).toBe(0)
        }),
        { numRuns: 1000 },
      )
    })

    it('multiplyDecimals_by_zero_returns_zero', () => {
      fc.assert(
        fc.property(decimalArb, (a) => {
          const result = multiplyDecimals(a, '0')
          expect(compareDecimals(result, '0')).toBe(0)
        }),
        { numRuns: 500 },
      )
    })

    it('multiplyDecimals_is_commutative', () => {
      fc.assert(
        fc.property(decimalArb, decimalArb, (a, b) => {
          const ab = multiplyDecimals(a, b)
          const ba = multiplyDecimals(b, a)
          expect(compareDecimals(ab, ba)).toBe(0)
        }),
        { numRuns: 1000 },
      )
    })

    it('multiplyDecimals_result_scale_equals_sum_of_input_scales', () => {
      fc.assert(
        fc.property(decimalArb, decimalArb, (a, b) => {
          const result = multiplyDecimals(a, b)
          const expectedScale = getFracLen(a) + getFracLen(b)
          expect(getFracLen(result)).toBe(expectedScale)
        }),
        { numRuns: 1000 },
      )
    })

    it('multiplyDecimals_then_divideDecimals_round_trips_within_one_ulp', () => {
      fc.assert(
        fc.property(
          decimalArb,
          nonZeroDecimalArb,
          fc.integer({ min: 0, max: 8 }),
          (a, b, extraScale) => {
            // Use enough scale to capture input precision.
            const inputScale = getFracLen(a)
            const scale = inputScale + extraScale
            const product = multiplyDecimals(a, b)
            const quotient = divideDecimals(product, b, scale, RoundingMode.HALF_UP)
            // |quotient - a| ≤ 1 ULP at `scale`
            const diff = subtractDecimals(quotient, a)
            const absDiff = diff.startsWith('-') ? diff.slice(1) : diff
            const ulp = scale === 0 ? '1' : `0.${'0'.repeat(scale - 1)}1`
            expect(compareDecimals(absDiff, ulp)).toBeLessThanOrEqual(0)
          },
        ),
        { numRuns: 1000 },
      )
    })

    // -- sad path: invalid inputs always throw --------------------------------

    it('roundToScale_rejects_non_numeric_strings', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).filter((s) => !/^\s*-?\d+(\.\d*)?\s*$/.test(s)),
          fc.integer({ min: 0, max: 6 }),
          (garbage, scale) => {
            expect(() => roundToScale(garbage, scale)).toThrow()
          },
        ),
        { numRuns: 500 },
      )
    })

    it('multiplyDecimals_rejects_non_numeric_strings', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).filter((s) => !/^\s*-?\d+(\.\d*)?\s*$/.test(s)),
          (garbage) => {
            expect(() => multiplyDecimals(garbage, '1')).toThrow()
            expect(() => multiplyDecimals('1', garbage)).toThrow()
          },
        ),
        { numRuns: 500 },
      )
    })

    it('divideDecimals_throws_DivisionByZeroError_for_any_zero_divisor', () => {
      const zeroArb = fc.constantFrom('0', '0.0', '0.00', '-0', '-0.0', '-0.00')
      fc.assert(
        fc.property(
          nonZeroDecimalArb,
          zeroArb,
          fc.integer({ min: 0, max: 6 }),
          (a, zero, scale) => {
            expect(() => divideDecimals(a, zero, scale)).toThrow(DivisionByZeroError)
          },
        ),
        { numRuns: 200 },
      )
    })
  })
})

