/**
 * Unit tests for the fee calculation engine.
 *
 * Table-driven tests cover:
 *   - Standard USD/EUR/GBP (2 decimal places)
 *   - Zero-decimal currencies (JPY, KRW)
 *   - Three-decimal currencies (KWD, BHD, OMR)
 *   - Boundary values that expose 1-cent floating-point discrepancies
 *   - Rounding modes (including multi-digit remainder cases)
 *   - Multi-rate (applyFees) pipeline
 *   - Edge inputs: zero amount, zero rate, tiny rates, large amounts, excess base precision rejection
 */

import { describe, it, expect } from 'vitest'
import { calculateFee, applyFees } from './feeEngine.js'
import { RoundingMode } from '../../lib/decimalMath.js'
import type { Money } from './types.js'

// ---------------------------------------------------------------------------
// calculateFee — single rate
// ---------------------------------------------------------------------------

describe('feeEngine', () => {
  describe('calculateFee', () => {
    describe('USD (2 decimal places) — standard cases', () => {
      const cases: Array<[string, string, string, string, string]> = [
        // [amount, rate%, expectedBase, expectedFee, expectedTotal]
        ['100.00', '2.5',  '100.00', '2.50',   '102.50'],
        ['100.00', '10',   '100.00', '10.00',  '110.00'],
        ['100.00', '0',    '100.00', '0.00',   '100.00'],
        ['0.00',   '2.5',  '0.00',   '0.00',   '0.00'],
        ['1.00',   '50',   '1.00',   '0.50',   '1.50'],
        ['200.00', '1.5',  '200.00', '3.00',   '203.00'],
        ['99.99',  '1',    '99.99',  '1.00',   '100.99'],
        ['1000.00','0.1',  '1000.00','1.00',   '1001.00'],
      ]

      it.each(cases)(
        'amount=%s rate=%s% → fee=%s total=%s',
        (amount, rate, base, fee, total) => {
          const result = calculateFee({ base: { amount, currency: 'USD' }, ratePercent: rate })
          expect(result.baseAmount.amount).toBe(base)
          expect(result.feeAmount.amount).toBe(fee)
          expect(result.totalAmount.amount).toBe(total)
          expect(result.baseAmount.currency).toBe('USD')
          expect(result.feeAmount.currency).toBe('USD')
          expect(result.totalAmount.currency).toBe('USD')
        },
      )
    })

    describe('USD — boundary values that expose floating-point 1-cent errors', () => {
      const cases: Array<[string, string, string, string]> = [
        // These amounts / rates produce x.xx5 intermediate values where
        // floating-point arithmetic gives the wrong rounding direction.
        ['10.55',  '5',    '0.53',  '11.08'],   // 10.55*0.05 = 0.5275 → 0.53
        ['14.99',  '7.5',  '1.12',  '16.11'],   // 14.99*0.075 = 1.12425 → 1.12
        ['29.99',  '3',    '0.90',  '30.89'],   // 29.99*0.03 = 0.8997 → 0.90
        ['49.99',  '2',    '1.00',  '50.99'],   // 49.99*0.02 = 0.9998 → 1.00 (valid scale-2 USD base)
        ['0.01',   '50',   '0.01',  '0.02'],   // 0.01*0.50 = 0.005 → fee=0.01 (HALF_UP), total=0.02
        ['0.01',   '33.3', '0.00',  '0.01'],   // 0.01*0.333 = 0.00333 → 0.00
        ['33.33',  '3',    '1.00',  '34.33'],   // 33.33*0.03 = 0.9999 → 1.00
        ['66.67',  '3',    '2.00',  '68.67'],   // 66.67*0.03 = 2.0001 → 2.00
      ]

      it.each(cases)(
        'amount=%s rate=%s% → fee=%s total=%s',
        (amount, rate, fee, total) => {
          const result = calculateFee({ base: { amount, currency: 'USD' }, ratePercent: rate })
          expect(result.feeAmount.amount).toBe(fee)
          expect(result.totalAmount.amount).toBe(total)
        },
      )
    })

    describe('EUR (2 decimal places)', () => {
      it('matches USD behaviour for 2-decimal currency', () => {
        const result = calculateFee({ base: { amount: '50.00', currency: 'EUR' }, ratePercent: '3' })
        expect(result.feeAmount.amount).toBe('1.50')
        expect(result.totalAmount.amount).toBe('51.50')
        expect(result.feeAmount.currency).toBe('EUR')
      })
    })

    describe('JPY (0 decimal places)', () => {
      const cases: Array<[string, string, string, string]> = [
        ['1000',  '5',   '50',   '1050'],
        ['1000',  '3',   '30',   '1030'],
        ['100',   '10',  '10',   '110'],
        ['99',    '1',   '1',    '100'],
        ['1',     '50',  '1',    '2'],    // 0.5 → rounds up to 1 (HALF_UP)
        ['1',     '49',  '0',    '1'],    // 0.49 → 0 yen
        ['1000',  '1.5', '15',   '1015'], // 1000 × 0.015 = 15
        ['333',   '1',   '3',    '336'],  // 333 × 0.01 = 3.33 → 3 yen (HALF_UP)
        ['750',   '1',   '8',    '758'],  // 750 × 0.01 = 7.5 → 8 yen (HALF_UP)
      ]

      it.each(cases)(
        'JPY amount=%s rate=%s% → fee=%s total=%s',
        (amount, rate, fee, total) => {
          const result = calculateFee({ base: { amount, currency: 'JPY' }, ratePercent: rate })
          expect(result.baseAmount.amount).toBe(amount)
          expect(result.feeAmount.amount).toBe(fee)
          expect(result.totalAmount.amount).toBe(total)
        },
      )
    })

    describe('KWD (3 decimal places)', () => {
      const cases: Array<[string, string, string, string, string]> = [
        ['100.000', '2.5',   '100.000', '2.500',   '102.500'],
        ['1.000',   '5',     '1.000',   '0.050',   '1.050'],
        ['1.000',   '0.1',   '1.000',   '0.001',   '1.001'],
        ['1.000',   '0.05',  '1.000',   '0.001',   '1.001'],  // 0.0005 → 0.001 (HALF_UP)
        ['1.000',   '0.04',  '1.000',   '0.000',   '1.000'],  // 0.0004 → 0.000
        ['0.001',   '50',    '0.001',   '0.001',   '0.002'],  // 0.0005 → 0.001 (HALF_UP)
      ]

      it.each(cases)(
        'KWD amount=%s rate=%s% → fee=%s total=%s',
        (amount, rate, base, fee, total) => {
          const result = calculateFee({ base: { amount, currency: 'KWD' }, ratePercent: rate })
          expect(result.baseAmount.amount).toBe(base)
          expect(result.feeAmount.amount).toBe(fee)
          expect(result.totalAmount.amount).toBe(total)
        },
      )
    })

    describe('KRW (0 decimal places)', () => {
      it('rounds to whole won', () => {
        const result = calculateFee({ base: { amount: '10000', currency: 'KRW' }, ratePercent: '1.5' })
        expect(result.feeAmount.amount).toBe('150')
        expect(result.totalAmount.amount).toBe('10150')
      })
    })

    describe('rounding mode overrides', () => {
      it('HALF_DOWN: 0.5 rounds down', () => {
        // 0.01 × 50% = 0.005 → scale 2 → 0.01 (HALF_UP) but 0.00 (HALF_DOWN)
        const result = calculateFee(
          { base: { amount: '0.01', currency: 'USD' }, ratePercent: '50' },
          RoundingMode.HALF_DOWN,
        )
        expect(result.feeAmount.amount).toBe('0.00')
      })

      it('HALF_DOWN exact midpoint: 1.00 @ 0.5 gives 0.00', () => {
        const result = calculateFee(
          { base: { amount: '1.00', currency: 'USD' }, ratePercent: '0.5' },
          RoundingMode.HALF_DOWN,
        )
        expect(result.feeAmount.amount).toBe('0.00')
      })

      it('HALF_DOWN above midpoint past first discarded digit: 1.00 @ 0.5001 gives 0.01', () => {
        // Exact fee is 0.005001, which is strictly above the 0.005 midpoint
        const result = calculateFee(
          { base: { amount: '1.00', currency: 'USD' }, ratePercent: '0.5001' },
          RoundingMode.HALF_DOWN,
        )
        expect(result.feeAmount.amount).toBe('0.01')
      })

      it('HALF_EVEN: 0.5 rounds to even', () => {
        // JPY: 1 × 50% = 0.5 → HALF_EVEN → 0 (0 is even)
        const result = calculateFee(
          { base: { amount: '1', currency: 'JPY' }, ratePercent: '50' },
          RoundingMode.HALF_EVEN,
        )
        expect(result.feeAmount.amount).toBe('0')

        // JPY: 3 × 50% = 1.5 → HALF_EVEN → 2 (2 is even)
        const result2 = calculateFee(
          { base: { amount: '3', currency: 'JPY' }, ratePercent: '50' },
          RoundingMode.HALF_EVEN,
        )
        expect(result2.feeAmount.amount).toBe('2')
      })

      it('HALF_EVEN exact midpoint in USD: 1.00 @ 0.5 gives 0.00 and 3.00 @ 0.5 gives 0.02', () => {
        const evenMid = calculateFee(
          { base: { amount: '1.00', currency: 'USD' }, ratePercent: '0.5' },
          RoundingMode.HALF_EVEN,
        )
        expect(evenMid.feeAmount.amount).toBe('0.00')

        const oddMid = calculateFee(
          { base: { amount: '3.00', currency: 'USD' }, ratePercent: '0.5' },
          RoundingMode.HALF_EVEN,
        )
        expect(oddMid.feeAmount.amount).toBe('0.02')
      })

      it('HALF_EVEN above midpoint past first discarded digit: 1.00 @ 0.5001 gives 0.01', () => {
        // Exact fee is 0.005001, which is strictly above the 0.005 midpoint
        const result = calculateFee(
          { base: { amount: '1.00', currency: 'USD' }, ratePercent: '0.5001' },
          RoundingMode.HALF_EVEN,
        )
        expect(result.feeAmount.amount).toBe('0.01')
      })

      it('DOWN: always truncates toward zero', () => {
        // 10.55 × 5% = 0.5275 → DOWN → 0.52
        const result = calculateFee(
          { base: { amount: '10.55', currency: 'USD' }, ratePercent: '5' },
          RoundingMode.DOWN,
        )
        expect(result.feeAmount.amount).toBe('0.52')
      })

      it('UP: rounds away from zero for any remainder', () => {
        // 10.55 × 5% = 0.5275 → UP → 0.53
        const result = calculateFee(
          { base: { amount: '10.55', currency: 'USD' }, ratePercent: '5' },
          RoundingMode.UP,
        )
        expect(result.feeAmount.amount).toBe('0.53')
      })

      it('UP with tiny remainder past first discarded digit: 1.00 @ 0.0001 gives 0.01', () => {
        // Exact fee is 0.000001 -> non-zero remainder -> rounds up to 0.01
        const result = calculateFee(
          { base: { amount: '1.00', currency: 'USD' }, ratePercent: '0.0001' },
          RoundingMode.UP,
        )
        expect(result.feeAmount.amount).toBe('0.01')
      })

      it('UP with exact result: 100.00 @ 2.5 gives 2.50, not 2.51', () => {
        const result = calculateFee(
          { base: { amount: '100.00', currency: 'USD' }, ratePercent: '2.5' },
          RoundingMode.UP,
        )
        expect(result.feeAmount.amount).toBe('2.50')
      })

      it('UP on JPY (scale 0): 1 @ 0.1 gives 1', () => {
        const result = calculateFee(
          { base: { amount: '1', currency: 'JPY' }, ratePercent: '0.1' },
          RoundingMode.UP,
        )
        expect(result.feeAmount.amount).toBe('1')
      })

      it('UP on KWD (scale 3): 1.000 @ 0.00001 gives 0.001', () => {
        const result = calculateFee(
          { base: { amount: '1.000', currency: 'KWD' }, ratePercent: '0.00001' },
          RoundingMode.UP,
        )
        expect(result.feeAmount.amount).toBe('0.001')
      })
    })

    describe('edge cases', () => {
      it('zero amount produces zero fee', () => {
        const result = calculateFee({ base: { amount: '0.00', currency: 'USD' }, ratePercent: '10' })
        expect(result.feeAmount.amount).toBe('0.00')
        expect(result.totalAmount.amount).toBe('0.00')
      })

      it('zero rate produces zero fee', () => {
        const result = calculateFee({ base: { amount: '500.00', currency: 'USD' }, ratePercent: '0' })
        expect(result.feeAmount.amount).toBe('0.00')
        expect(result.totalAmount.amount).toBe('500.00')
      })

      it('100% rate equals the full amount', () => {
        const result = calculateFee({ base: { amount: '250.00', currency: 'USD' }, ratePercent: '100' })
        expect(result.feeAmount.amount).toBe('250.00')
        expect(result.totalAmount.amount).toBe('500.00')
      })

      it('very small rate (0.01%) on large USD amount', () => {
        // 1000000.00 × 0.0001 = 100.00
        const result = calculateFee({ base: { amount: '1000000.00', currency: 'USD' }, ratePercent: '0.01' })
        expect(result.feeAmount.amount).toBe('100.00')
      })

      it('rejects base amount with more fractional digits than the currency scale', () => {
        expect(() =>
          calculateFee({ base: { amount: '100.999', currency: 'USD' }, ratePercent: '0' }),
        ).toThrow(/currency scale of 2 for USD/)

        expect(() =>
          calculateFee({ base: { amount: '10.999', currency: 'USD' }, ratePercent: '1' }),
        ).toThrow(/currency scale of 2 for USD/)

        expect(() =>
          calculateFee({ base: { amount: '10.5', currency: 'JPY' }, ratePercent: '1' }),
        ).toThrow(/currency scale of 0 for JPY/)

        expect(() =>
          calculateFee({ base: { amount: '1.0001', currency: 'KWD' }, ratePercent: '1' }),
        ).toThrow(/currency scale of 3 for KWD/)
      })

      it('throws for negative rate', () => {
        expect(() =>
          calculateFee({ base: { amount: '100.00', currency: 'USD' }, ratePercent: '-1' }),
        ).toThrow()
      })
    })
  })

  // ---------------------------------------------------------------------------
  // applyFees — multi-rate pipeline
  // ---------------------------------------------------------------------------

  describe('applyFees', () => {
    describe('additive multi-rate pipeline', () => {
      it('sums two independent fees correctly (USD)', () => {
        // platform 2% + network 0.5% on $100.00
        // platform fee: 100 × 0.02 = 2.00
        // network fee:  100 × 0.005 = 0.50
        // total fee: 2.50
        const base: Money = { amount: '100.00', currency: 'USD' }
        const result = applyFees(base, ['2', '0.5'])
        expect(result.feeAmount.amount).toBe('2.50')
        expect(result.totalAmount.amount).toBe('102.50')
      })

      it('three rates on JPY (0 decimals)', () => {
        // 1000 yen × 1% = 10, × 0.5% = 5, × 0.1% = 1 → total fee = 16
        const base: Money = { amount: '1000', currency: 'JPY' }
        const result = applyFees(base, ['1', '0.5', '0.1'])
        expect(result.feeAmount.amount).toBe('16')
        expect(result.totalAmount.amount).toBe('1016')
      })

      it('three rates on KWD (3 decimals)', () => {
        // 100.000 KWD × 1% = 1.000, × 0.5% = 0.500, × 0.1% = 0.100
        const base: Money = { amount: '100.000', currency: 'KWD' }
        const result = applyFees(base, ['1', '0.5', '0.1'])
        expect(result.feeAmount.amount).toBe('1.600')
        expect(result.totalAmount.amount).toBe('101.600')
      })

      it('single rate delegates to same logic as calculateFee', () => {
        const base: Money = { amount: '50.00', currency: 'USD' }
        const single = calculateFee({ base, ratePercent: '3' })
        const multi  = applyFees(base, ['3'])
        expect(multi.feeAmount.amount).toBe(single.feeAmount.amount)
        expect(multi.totalAmount.amount).toBe(single.totalAmount.amount)
      })

      it('empty rates produce zero fee', () => {
        const base: Money = { amount: '200.00', currency: 'USD' }
        const result = applyFees(base, [])
        expect(result.feeAmount.amount).toBe('0.00')
        expect(result.totalAmount.amount).toBe('200.00')
      })

      it('rounding mode is applied per step', () => {
        // Each step with DOWN: 0.5275 → 0.52 per step, not combined first
        const base: Money = { amount: '10.55', currency: 'USD' }
        const result = applyFees(base, ['5', '5'], RoundingMode.DOWN)
        // step1: 10.55 × 5% = 0.5275 → DOWN → 0.52
        // step2: 10.55 × 5% = 0.5275 → DOWN → 0.52
        // total fee = 1.04
        expect(result.feeAmount.amount).toBe('1.04')
        expect(result.totalAmount.amount).toBe('11.59')
      })
    })

    describe('edge cases', () => {
      it('zero base with multiple rates', () => {
        const result = applyFees({ amount: '0.00', currency: 'USD' }, ['2', '3'])
        expect(result.feeAmount.amount).toBe('0.00')
        expect(result.totalAmount.amount).toBe('0.00')
      })

      it('preserves currency on all output fields', () => {
        const result = applyFees({ amount: '100', currency: 'JPY' }, ['1', '2'])
        expect(result.baseAmount.currency).toBe('JPY')
        expect(result.feeAmount.currency).toBe('JPY')
        expect(result.totalAmount.currency).toBe('JPY')
      })

      it('rejects excess fractional digits on base amount', () => {
        expect(() =>
          applyFees({ amount: '10.999', currency: 'USD' }, ['1']),
        ).toThrow(/currency scale of 2 for USD/)
      })
    })
  })
})
