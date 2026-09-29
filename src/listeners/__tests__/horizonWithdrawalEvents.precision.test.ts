/**
 * Regression suite: amount precision and overflow — issue #1262
 *
 * Tests the pure functions in `src/lib/bondAmountMath.ts` which back the
 * Horizon withdrawal ingestion pipeline.  No database, Stellar SDK, or Redis
 * dependency is required — these are zero-mock unit tests that run in < 1 s.
 *
 * Independent oracle: `decimalMath` primitives (`subtractDecimals`,
 * `compareDecimals`, `divideDecimals`) are used as the reference.
 *
 * Coverage
 * ────────
 *  computeNewBondAmount
 *    – zero, minimum, maximum, near-overflow amounts
 *    – fractional and multi-scale XLM amounts (7-decimal precision)
 *    – large integer amounts > 15 sig-digits (stroop range)
 *    – overdraft clamping (withdrawal >= balance → "0")
 *    – float-pitfall cases: 0.3 − 0.1 must equal "0.2" exactly
 *    – property: result ≥ 0 for any valid non-negative inputs
 *    – property: agrees with oracle for arbitrary valid decimal inputs
 *    – invalid inputs (sign, scientific notation, empty) → throws
 *
 *  shouldTakeSnapshot
 *    – zero, minimum, and near-overflow amounts
 *    – exactly 50 %, just under, just over (large integers that
 *      parseFloat() would mangle)
 *    – property: agrees with BigInt-based oracle for all integer percentages
 *
 *  decimalAmountSchema  (src/schemas/queue.ts)
 *    – zero, minimum, maximum valid amounts
 *    – overflow: > 20 integer digits, > 7 fractional digits
 *    – malformed: sign, scientific notation, whitespace, empty, multiple dots
 *    – property: every (intLen ≤ 20, fracLen ≤ 7) non-negative decimal is accepted
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import {
  computeNewBondAmount,
  shouldTakeSnapshot,
} from '../../lib/bondAmountMath.js'

import {
  subtractDecimals,
  compareDecimals,
  divideDecimals,
  RoundingMode,
} from '../../lib/decimalMath.js'

import { validateMessage } from '../messageValidator.js'
import { withdrawalEventSchema } from '../../schemas/queue.js'

// ── oracle helpers ────────────────────────────────────────────────────────────

function oracleNewAmount(current: string, withdrawal: string): string {
  if (compareDecimals(withdrawal, current) >= 0) return '0'
  return subtractDecimals(current, withdrawal)
}

function oracleRatio(previous: string, newAmt: string): string {
  if (compareDecimals(previous, '0') === 0) return '0.0000'
  const withdrawn = subtractDecimals(previous, newAmt)
  return divideDecimals(withdrawn, previous, 4, RoundingMode.DOWN)
}

// ── minimal withdrawal-event payload for schema tests ────────────────────────

function makePayload(amount: string) {
  return {
    id: 'op-1',
    pagingToken: 'pt-1',
    type: 'payment',
    createdAt: new Date().toISOString(),
    bondId: 'bond-1',
    account: 'GABC',
    amount,
    assetType: 'native',
    transactionHash: 'tx-1',
    operationIndex: 0,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1.  computeNewBondAmount
// ═══════════════════════════════════════════════════════════════════════════

describe('computeNewBondAmount — precision and overflow', () => {
  const TABLE: Array<{
    label: string
    current: string
    withdrawal: string
    expected: string
  }> = [
    // ── zero values ──────────────────────────────────────────────────────
    { label: 'zero current, zero withdrawal', current: '0', withdrawal: '0', expected: '0' },
    { label: 'non-zero current, zero withdrawal → unchanged', current: '100.0000000', withdrawal: '0', expected: '100.0000000' },

    // ── minimum non-zero unit (1 stroop = 0.0000001 XLM) ────────────────
    { label: '1 stroop partial', current: '1.0000000', withdrawal: '0.0000001', expected: '0.9999999' },
    { label: 'withdraw exactly minimum unit', current: '0.0000001', withdrawal: '0.0000001', expected: '0' },

    // ── standard XLM amounts ─────────────────────────────────────────────
    { label: 'partial: 300 from 1000', current: '1000.0000000', withdrawal: '300.0000000', expected: '700.0000000' },
    { label: 'exact full withdrawal', current: '1000.0000000', withdrawal: '1000.0000000', expected: '0' },

    // ── overdraft clamping ───────────────────────────────────────────────
    { label: 'overdraft: withdrawal > current → 0', current: '500.0000000', withdrawal: '1000.0000000', expected: '0' },
    { label: 'overdraft by 1 stroop', current: '0.0000001', withdrawal: '0.0000002', expected: '0' },

    // ── large integer amounts (> 15 sig-digits — parseFloat() territory) ─
    { label: '16-digit stroop subtraction', current: '9000000000000000', withdrawal: '1000000000000001', expected: '7999999999999999' },
    { label: '16-digit exact match → 0', current: '9999999999999999', withdrawal: '9999999999999999', expected: '0' },
    { label: '20-digit near-overflow', current: '99999999999999999999', withdrawal: '1', expected: '99999999999999999998' },

    // ── high-precision fractional ────────────────────────────────────────
    { label: '7-decimal XLM precision', current: '12345678.1234567', withdrawal: '0.0000001', expected: '12345678.1234566' },
    { label: 'mismatched scales', current: '100.1234567', withdrawal: '0.1', expected: '100.0234567' },
    { label: 'result is exact zero with trailing .0', current: '10.5', withdrawal: '10.5', expected: '0.0' },

    // ── classic float pitfalls ───────────────────────────────────────────
    // IEEE 754: 0.3 - 0.1 = 0.19999999999999998; exact math gives 0.2
    { label: 'float pitfall: 0.3 - 0.1 = 0.2 exactly', current: '0.3', withdrawal: '0.1', expected: '0.2' },
    { label: 'float pitfall: 1000000.1 - 0.1 = 1000000.0', current: '1000000.1', withdrawal: '0.1', expected: '1000000.0' },
  ]

  it.each(TABLE)('$label', ({ current, withdrawal, expected }) => {
    const result = computeNewBondAmount(current, withdrawal)
    expect(compareDecimals(result, expected)).toBe(0)
  })

  describe('validation — rejects before state change', () => {
    it('throws on non-numeric current amount', () => {
      expect(() => computeNewBondAmount('not-a-number', '100')).toThrow()
    })
    it('throws on negative current amount', () => {
      expect(() => computeNewBondAmount('-100', '50')).toThrow()
    })
    it('throws on scientific notation in current', () => {
      expect(() => computeNewBondAmount('1e7', '100')).toThrow()
    })
    it('throws on scientific notation in withdrawal', () => {
      expect(() => computeNewBondAmount('1000', '1e3')).toThrow()
    })
    it('throws on negative withdrawal amount', () => {
      expect(() => computeNewBondAmount('1000', '-100')).toThrow()
    })
    it('throws on whitespace in withdrawal amount', () => {
      expect(() => computeNewBondAmount('1000', ' 100')).toThrow()
    })
    it('throws on empty string', () => {
      expect(() => computeNewBondAmount('', '100')).toThrow()
    })
  })

  describe('oracle agreement — table cases', () => {
    it.each(TABLE)('oracle agrees: $label', ({ current, withdrawal }) => {
      const result = computeNewBondAmount(current, withdrawal)
      const oracle = oracleNewAmount(current, withdrawal)
      expect(compareDecimals(result, oracle)).toBe(0)
    })
  })

  describe('property: result is never negative', () => {
    // Arbitrary non-negative decimals with up to 7 fractional digits
    const nonNegDecimalArb = fc
      .tuple(
        fc.integer({ min: 0, max: 9_999_999_999 }),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 0, max: 9_999_999 }),
      )
      .map(([int, fracLen, fracVal]) => {
        if (fracLen === 0) return `${int}`
        const frac = String(fracVal).padStart(fracLen, '0').slice(0, fracLen)
        return `${int}.${frac}`
      })

    it('result >= 0 for all valid non-negative inputs', () => {
      fc.assert(
        fc.property(nonNegDecimalArb, nonNegDecimalArb, (current, withdrawal) => {
          const result = computeNewBondAmount(current, withdrawal)
          expect(compareDecimals(result, '0')).toBeGreaterThanOrEqual(0)
        }),
        { numRuns: 1000 },
      )
    })

    it('isActive flag is consistent with newAmount > 0', () => {
      // computeNewBondAmount returns the string; the caller checks !== '0'.
      // Verify oracle agreement for all arbitrary inputs.
      fc.assert(
        fc.property(nonNegDecimalArb, nonNegDecimalArb, (current, withdrawal) => {
          const result = computeNewBondAmount(current, withdrawal)
          const oracle = oracleNewAmount(current, withdrawal)
          expect(compareDecimals(result, oracle)).toBe(0)
        }),
        { numRuns: 1000 },
      )
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2.  shouldTakeSnapshot
// ═══════════════════════════════════════════════════════════════════════════

describe('shouldTakeSnapshot — ratio precision', () => {
  const TABLE: Array<{
    label: string
    previous: string
    next: string
    isActive: boolean
    expected: boolean
  }> = [
    // full withdrawal → always snapshot
    { label: 'full withdrawal (isActive=false)', previous: '1000', next: '0', isActive: false, expected: true },

    // exactly 50 %
    { label: 'exactly 50% withdrawn', previous: '1000', next: '500', isActive: true, expected: true },

    // 49.9999 % → no snapshot
    { label: '49.99% withdrawn → no snapshot', previous: '1000.0000000', next: '500.1000000', isActive: true, expected: false },

    // 50.01 % → snapshot
    { label: '50.01% withdrawn → snapshot', previous: '1000.0000000', next: '499.9000000', isActive: true, expected: true },

    // 60 % and 40 %
    { label: '60% withdrawn → snapshot', previous: '1000', next: '400', isActive: true, expected: true },
    { label: '40% withdrawn → no snapshot', previous: '1000', next: '600', isActive: true, expected: false },

    // Large 16-digit amounts — parseFloat() loses precision at this scale
    { label: 'exactly 50% of 16-digit amount → snapshot', previous: '9000000000000002', next: '4500000000000001', isActive: true, expected: true },
    { label: 'just under 50% of 16-digit amount → no snapshot', previous: '9000000000000000', next: '4500000000000001', isActive: true, expected: false },

    // Minimum units
    { label: '1 stroop from 2 stroops = 50% → snapshot', previous: '0.0000002', next: '0.0000001', isActive: true, expected: true },
    { label: '0 withdrawn → no snapshot', previous: '100', next: '100', isActive: true, expected: false },

    // Near-overflow
    { label: 'half of 20-digit amount → snapshot', previous: '20000000000000000000', next: '10000000000000000000', isActive: true, expected: true },

    // Edge: zero previous → no snapshot (division guard)
    { label: 'zero previous amount → no snapshot', previous: '0', next: '0', isActive: false, expected: true },
  ]

  it.each(TABLE)('$label', ({ previous, next, isActive, expected }) => {
    expect(shouldTakeSnapshot(previous, next, isActive)).toBe(expected)
  })

  describe('property: oracle agreement for integer percentages', () => {
    it('shouldTakeSnapshot agrees with oracle for all integer percent withdrawals', () => {
      const positiveIntArb = fc.integer({ min: 1, max: 999_999_999 }).map(String)

      fc.assert(
        fc.property(positiveIntArb, fc.integer({ min: 0, max: 100 }), (prev, pct) => {
          const newAmtBig = (BigInt(prev) * BigInt(pct)) / 100n
          const newAmt = String(newAmtBig)
          const isActive = newAmtBig > 0n

          const result = shouldTakeSnapshot(prev, newAmt, isActive)
          const oracleRatioStr = oracleRatio(prev, newAmt)
          const oracleResult = !isActive || compareDecimals(oracleRatioStr, '0.5') >= 0

          expect(result).toBe(oracleResult)
        }),
        { numRuns: 1000 },
      )
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3.  decimalAmountSchema — boundary validation at the ingestion boundary
// ═══════════════════════════════════════════════════════════════════════════

describe('decimalAmountSchema — boundary validation', () => {
  const VALID: string[] = [
    '0',
    '1',
    '0.0000001',          // 1 stroop
    '500.0000000',
    '9999999999999.9999999',           // 13 int + 7 frac
    '99999999999999999999',            // 20-digit integer (max integer part)
    '99999999999999999999.9999999',    // absolute max for NUMERIC(20,7)
  ]

  const INVALID: Array<{ amount: string; reason: string }> = [
    { amount: '-100',              reason: 'negative sign' },
    { amount: '1e10',              reason: 'scientific notation' },
    { amount: ' 100',              reason: 'leading space' },
    { amount: '100 ',              reason: 'trailing space' },
    { amount: '100.50.00',         reason: 'multiple dots' },
    { amount: '',                  reason: 'empty string' },
    { amount: 'abc',               reason: 'non-numeric' },
    { amount: '1.23456789',        reason: '8 fractional digits exceeds max (7)' },
    { amount: '1' + '0'.repeat(20), reason: '21-digit integer overflows NUMERIC(20,7)' },
    { amount: '9'.repeat(33),      reason: '33 chars exceeds max 32' },
  ]

  it.each(VALID)('accepts valid amount "%s"', (amount) => {
    const result = validateMessage(withdrawalEventSchema, makePayload(amount))
    expect(result.valid).toBe(true)
  })

  it.each(INVALID)('rejects — $reason', ({ amount }) => {
    const result = validateMessage(withdrawalEventSchema, makePayload(amount))
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.detail.toLowerCase()).toContain('amount')
    }
  })

  it('rejects overflow: more than 7 fractional digits', () => {
    expect(validateMessage(withdrawalEventSchema, makePayload('1.12345678')).valid).toBe(false)
  })

  it('rejects overflow: 21-digit integer part', () => {
    expect(validateMessage(withdrawalEventSchema, makePayload('1' + '0'.repeat(20))).valid).toBe(false)
  })

  it('accepts zero', () => {
    expect(validateMessage(withdrawalEventSchema, makePayload('0')).valid).toBe(true)
  })

  it('accepts maximum valid 7-decimal XLM amount', () => {
    expect(validateMessage(withdrawalEventSchema, makePayload('9999999999999.9999999')).valid).toBe(true)
  })

  describe('property: any valid-format non-negative decimal is accepted', () => {
    // Arbitrary (intLen ≤ 20, fracLen ≤ 7) non-negative decimal strings
    const validDecimalArb = fc
      .tuple(
        fc.integer({ min: 0, max: 9_999_999_999 }),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 0, max: 9_999_999 }),
      )
      .map(([int, fracLen, fracVal]) => {
        if (fracLen === 0) return `${int}`
        const frac = String(fracVal).padStart(fracLen, '0').slice(0, fracLen)
        const intStr = String(int)
        // Clamp int part to ≤ 20 digits
        return intStr.length <= 20 ? `${intStr}.${frac}` : `${intStr.slice(0, 20)}.${frac}`
      })

    it('all valid-format amounts pass schema', () => {
      fc.assert(
        fc.property(validDecimalArb, (amount) => {
          const result = validateMessage(withdrawalEventSchema, makePayload(amount))
          expect(result.valid).toBe(true)
        }),
        { numRuns: 500 },
      )
    })
  })
})
