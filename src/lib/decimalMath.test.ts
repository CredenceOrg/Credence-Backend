/**
 * Unit tests for decimal-safe arithmetic utilities.
 *
 * Table-driven and property-based tests cover boundary values, rounding modes,
 * sign handling, scale edge cases, and multi-precision inputs.
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  roundToScale,
  multiplyDecimals,
  RoundingMode,
  DEFAULT_ROUNDING_MODE,
} from './decimalMath.js'

const propertyConfig = { numRuns: 250 }

interface DecimalParts {
  negative: boolean
  intPart: string
  fracPart: string
}

interface UnsignedDecimalCase {
  value: string
  intPart: string
  fracPart: string
}

interface SignedDecimalCase extends UnsignedDecimalCase {
  negative: boolean
}

const digitsToBigInt = (digits: string): bigint =>
  BigInt(digits.replace(/^0+/, '') || '0')

const tenPow = (scale: number): bigint => 10n ** BigInt(scale)

const formatUnsignedScaled = (value: bigint, scale: number): string => {
  if (scale === 0) return value.toString()

  const factor = tenPow(scale)
  const intPart = value / factor
  const fracPart = value % factor

  return `${intPart}.${fracPart.toString().padStart(scale, '0')}`
}

const formatReference = (
  value: bigint,
  scale: number,
  negative: boolean,
): string => {
  const formatted = formatUnsignedScaled(value, scale)

  return negative && value !== 0n ? `-${formatted}` : formatted
}

const parseDecimalForTest = (value: string): DecimalParts => {
  const negative = value.startsWith('-')
  const abs = negative ? value.slice(1) : value
  const [intPart, fracPart = ''] = abs.split('.')

  return { negative, intPart, fracPart }
}

const decimalMagnitudeAtScale = (
  value: string,
  targetScale: number,
): { truncated: bigint; remainder: bigint; shiftFactor: bigint } => {
  const { intPart, fracPart } = parseDecimalForTest(value)
  const inputScale = fracPart.length
  const intValue = digitsToBigInt(`${intPart}${fracPart}`)

  if (inputScale <= targetScale) {
    return {
      truncated: intValue * tenPow(targetScale - inputScale),
      remainder: 0n,
      shiftFactor: 1n,
    }
  }

  const shiftFactor = tenPow(inputScale - targetScale)

  return {
    truncated: intValue / shiftFactor,
    remainder: intValue % shiftFactor,
    shiftFactor,
  }
}

const parseOutputMagnitude = (value: string, scale: number): bigint => {
  const abs = value.startsWith('-') ? value.slice(1) : value
  const [intPart, fracPart = ''] = abs.split('.')

  expect(fracPart.length).toBe(scale)

  return digitsToBigInt(`${intPart}${fracPart}`)
}

const referenceRound = (
  value: string,
  scale: number,
  mode: RoundingMode,
): string => {
  const { negative } = parseDecimalForTest(value)
  const { truncated, remainder, shiftFactor } = decimalMagnitudeAtScale(
    value,
    scale,
  )
  const twice = remainder * 2n
  let rounded: bigint = truncated

  switch (mode) {
    case RoundingMode.DOWN:
      rounded = truncated
      break
    case RoundingMode.UP:
      rounded = remainder > 0n ? truncated + 1n : truncated
      break
    case RoundingMode.HALF_UP:
      rounded = twice >= shiftFactor ? truncated + 1n : truncated
      break
    case RoundingMode.HALF_DOWN:
      rounded = twice > shiftFactor ? truncated + 1n : truncated
      break
    case RoundingMode.HALF_EVEN:
      if (twice > shiftFactor) rounded = truncated + 1n
      else if (twice < shiftFactor) rounded = truncated
      else rounded = truncated % 2n === 0n ? truncated : truncated + 1n
      break
  }

  return formatReference(rounded, scale, negative)
}

const digitStringArb = (minLength: number, maxLength: number) =>
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength, maxLength })
    .map((digits) => digits.join(''))

const unsignedDecimalArb: fc.Arbitrary<UnsignedDecimalCase> = fc
  .record({
    intPart: digitStringArb(1, 18),
    fracPart: digitStringArb(0, 12),
  })
  .map(({ intPart, fracPart }) => ({
    value: fracPart.length === 0 ? intPart : `${intPart}.${fracPart}`,
    intPart,
    fracPart,
  }))

const signedDecimalArb: fc.Arbitrary<SignedDecimalCase> = fc
  .record({
    decimal: unsignedDecimalArb,
    negative: fc.boolean(),
  })
  .map(({ decimal, negative }) => ({
    ...decimal,
    value: negative ? `-${decimal.value}` : decimal.value,
    negative,
  }))

const scaleArb = fc.integer({ min: 0, max: 8 })
const roundingModeArb = fc.constantFrom(...Object.values(RoundingMode))
const negativeZeroPattern = /^-0(?:\.0+)?$/

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

    describe('property-based rounding invariants', () => {
      it('matches a BigInt reference model for all rounding modes', () => {
        fc.assert(
          fc.property(
            signedDecimalArb,
            scaleArb,
            roundingModeArb,
            ({ value }, scale, mode) => {
              expect(roundToScale(value, scale, mode)).toBe(
                referenceRound(value, scale, mode),
              )
            },
          ),
          propertyConfig,
        )
      })

      it('always returns a normalized scale and never returns negative zero', () => {
        fc.assert(
          fc.property(
            signedDecimalArb,
            scaleArb,
            roundingModeArb,
            ({ value }, scale, mode) => {
              const result = roundToScale(value, scale, mode)
              const pattern =
                scale === 0
                  ? /^-?\d+$/
                  : new RegExp(`^-?\\d+\\.\\d{${scale}}$`)

              expect(result).toMatch(pattern)
              expect(result).not.toMatch(negativeZeroPattern)
            },
          ),
          propertyConfig,
        )
      })

      it('keeps rounded magnitudes within one unit of the truncated scale', () => {
        fc.assert(
          fc.property(
            signedDecimalArb,
            scaleArb,
            roundingModeArb,
            ({ value }, scale, mode) => {
              const { truncated, remainder } = decimalMagnitudeAtScale(
                value,
                scale,
              )
              const rounded = parseOutputMagnitude(
                roundToScale(value, scale, mode),
                scale,
              )
              const maxRounded =
                remainder > 0n ? truncated + 1n : truncated

              expect(rounded >= truncated).toBe(true)
              expect(rounded <= maxRounded).toBe(true)
            },
          ),
          propertyConfig,
        )
      })

      it('orders positive DOWN and UP bounds around half rounding modes', () => {
        fc.assert(
          fc.property(unsignedDecimalArb, scaleArb, ({ value }, scale) => {
            const down = parseOutputMagnitude(
              roundToScale(value, scale, RoundingMode.DOWN),
              scale,
            )
            const up = parseOutputMagnitude(
              roundToScale(value, scale, RoundingMode.UP),
              scale,
            )

            for (const mode of [
              RoundingMode.HALF_UP,
              RoundingMode.HALF_DOWN,
              RoundingMode.HALF_EVEN,
            ]) {
              const rounded = parseOutputMagnitude(
                roundToScale(value, scale, mode),
                scale,
              )

              expect(rounded >= down).toBe(true)
              expect(rounded <= up).toBe(true)
            }
          }),
          propertyConfig,
        )
      })

      it('rounds exact HALF_EVEN midpoints to an even final digit', () => {
        const midpointArb = fc
          .record({
            truncated: fc.integer({ min: 0, max: 1_000_000 }),
            scale: fc.integer({ min: 0, max: 6 }),
            extraDigits: fc.integer({ min: 1, max: 6 }),
          })
          .map(({ truncated, scale, extraDigits }) => {
            const truncatedMagnitude = BigInt(truncated)
            const raw =
              truncatedMagnitude * tenPow(extraDigits) +
              5n * tenPow(extraDigits - 1)

            return {
              input: formatUnsignedScaled(raw, scale + extraDigits),
              scale,
              truncated: truncatedMagnitude,
            }
          })

        fc.assert(
          fc.property(midpointArb, ({ input, scale, truncated }) => {
            const result = parseOutputMagnitude(
              roundToScale(input, scale, RoundingMode.HALF_EVEN),
              scale,
            )
            const expected =
              truncated % 2n === 0n ? truncated : truncated + 1n

            expect(result).toBe(expected)
            expect(result % 2n).toBe(0n)
          }),
          propertyConfig,
        )
      })

      it('keeps HALF_UP and HALF_DOWN symmetric for negative values', () => {
        fc.assert(
          fc.property(
            unsignedDecimalArb,
            scaleArb,
            fc.constantFrom(RoundingMode.HALF_UP, RoundingMode.HALF_DOWN),
            ({ value }, scale, mode) => {
              const positive = roundToScale(value, scale, mode)
              const negative = roundToScale(`-${value}`, scale, mode)
              const expected =
                parseOutputMagnitude(positive, scale) === 0n
                  ? positive
                  : `-${positive}`

              expect(negative).toBe(expected)
            },
          ),
          propertyConfig,
        )
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

    describe('property-based multiplication invariants', () => {
      it('matches exact BigInt multiplication and preserves product scale', () => {
        fc.assert(
          fc.property(signedDecimalArb, signedDecimalArb, (a, b) => {
            const result = multiplyDecimals(a.value, b.value)
            const aInt = digitsToBigInt(`${a.intPart}${a.fracPart}`)
            const bInt = digitsToBigInt(`${b.intPart}${b.fracPart}`)
            const product = aInt * bInt
            const scale = a.fracPart.length + b.fracPart.length
            const expected = formatReference(
              product,
              scale,
              a.negative !== b.negative,
            )
            const [, fracPart = ''] = result.replace(/^-/, '').split('.')

            expect(result).toBe(expected)
            expect(fracPart.length).toBe(scale)
            expect(result).not.toMatch(negativeZeroPattern)
          }),
          propertyConfig,
        )
      })
    })
  })
})
