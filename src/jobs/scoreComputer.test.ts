import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'
import {
  computeScore,
  ScoreComputationError,
  MAX_SCORE,
  MIN_SCORE,
  MAX_BOND_AMOUNT,
  MAX_ATTESTATION_COUNT,
  type ScoreComputationErrorCode,
} from './scoreComputer.js'
import { ScoreSnapshotJob, createScoreSnapshotJob } from './scoreSnapshot.js'
import type {
  IdentityData,
  IdentityDataSource,
  ScoreSnapshot,
  ScoreSnapshotStore,
} from './types.js'

/**
 * Build an active identity row. Every boundary test starts from this so a
 * single field can be varied while the rest of the vector stays fixed.
 */
function activeRow(overrides: Partial<IdentityData> = {}): IdentityData {
  return { address: '0xabc', bondedAmount: '1000', active: true, attestationCount: 0, ...overrides }
}

/** Score a row without the `IdentityData` type getting in the way of bad input. */
function score(overrides: Partial<IdentityData> = {}): number {
  return computeScore(activeRow(overrides))
}

/** Score a value that is not a well-formed `IdentityData` at all. */
function scoreRaw(data: unknown): number {
  return computeScore(data as IdentityData)
}

/** Assert that `fn` rejects with a ScoreComputationError carrying `code`. */
function expectRejection(fn: () => unknown, code: ScoreComputationErrorCode, field: string): ScoreComputationError {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught, `expected a rejection with code ${code}`).toBeInstanceOf(ScoreComputationError)
  const typed = caught as ScoreComputationError
  expect(typed.code).toBe(code)
  expect(typed.field).toBe(field)
  expect(typed.name).toBe('ScoreComputationError')
  return typed
}

describe('computeScore', () => {
  it('returns 0 for inactive identity', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '1000',
      active: false,
      attestationCount: 10,
    }
    expect(computeScore(data)).toBe(0)
  })

  it('computes score based on bond amount only', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '1000', // Max bond = 100% bond score
      active: true,
      attestationCount: 0,
    }
    // 60% * 100 + 40% * 0 = 60
    expect(computeScore(data)).toBe(60)
  })

  it('computes score based on attestations only', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '0',
      active: true,
      attestationCount: 50, // Max attestations = 100% attestation score
    }
    // 60% * 0 + 40% * 100 = 40
    expect(computeScore(data)).toBe(40)
  })

  it('computes score with both bond and attestations', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '500', // 50% of max bond
      active: true,
      attestationCount: 25, // 50% of max attestations
    }
    // 60% * 50 + 40% * 50 = 30 + 20 = 50
    expect(computeScore(data)).toBe(50)
  })

  it('caps bond score at 100', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '2000', // 200% of max bond
      active: true,
      attestationCount: 0,
    }
    // 60% * 100 + 40% * 0 = 60
    expect(computeScore(data)).toBe(60)
  })

  it('caps attestation score at 100', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '0',
      active: true,
      attestationCount: 100, // 200% of max attestations
    }
    // 60% * 0 + 40% * 100 = 40
    expect(computeScore(data)).toBe(40)
  })

  it('computes perfect score', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '1000',
      active: true,
      attestationCount: 50,
    }
    // 60% * 100 + 40% * 100 = 100
    expect(computeScore(data)).toBe(100)
  })

  it('rounds score to nearest integer', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '333', // 33.3% of max
      active: true,
      attestationCount: 17, // 34% of max
    }
    // 60% * 33.3 + 40% * 34 = 19.98 + 13.6 = 33.58 -> 34 (but actual is 33)
    expect(computeScore(data)).toBe(33)
  })

  it('handles zero bond and attestations', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '0',
      active: true,
      attestationCount: 0,
    }
    expect(computeScore(data)).toBe(0)
  })

  it('handles large bond amounts', () => {
    const data: IdentityData = {
      address: '0xabc',
      bondedAmount: '1000000000000000000000', // Very large amount
      active: true,
      attestationCount: 50,
    }
    // Should cap bond score at 100
    expect(computeScore(data)).toBe(100)
  })
})

describe('computeScore boundary conditions', () => {
  describe('bond saturation at MAX_BOND_AMOUNT', () => {
    it('saturates the bond axis one unit below the cap', () => {
      // bondScore = trunc(999 / 10) = 99 -> 60% * 99 = 59.4 -> 59
      expect(score({ bondedAmount: String(MAX_BOND_AMOUNT - 1n) })).toBe(59)
    })

    it('saturates the bond axis exactly at the cap', () => {
      // bondScore = trunc(1000 / 10) = 100 -> 60% * 100 = 60
      expect(score({ bondedAmount: MAX_BOND_AMOUNT.toString() })).toBe(60)
    })

    it('saturates the bond axis one unit above the cap', () => {
      expect(score({ bondedAmount: String(MAX_BOND_AMOUNT + 1n) })).toBe(60)
    })

    it('holds the bond axis constant for arbitrarily large amounts', () => {
      const atCap = score({ bondedAmount: MAX_BOND_AMOUNT.toString() })
      expect(score({ bondedAmount: '1001' })).toBe(atCap)
      expect(score({ bondedAmount: '100000' })).toBe(atCap)
      expect(score({ bondedAmount: '1000000000000000000000' })).toBe(atCap)
      expect(score({ bondedAmount: '9'.repeat(400) })).toBe(atCap)
    })

    it('ignores bond amounts below one tenth of the cap', () => {
      // bondScore truncates to 0 for bond < 10, so the score must stay at 0.
      expect(score({ bondedAmount: '0' })).toBe(MIN_SCORE)
      expect(score({ bondedAmount: '1' })).toBe(MIN_SCORE)
      expect(score({ bondedAmount: '9' })).toBe(MIN_SCORE)
      expect(score({ bondedAmount: '10' })).toBe(1)
    })
  })

  describe('attestation saturation at MAX_ATTESTATION_COUNT', () => {
    it('saturates the attestation axis one unit below the cap', () => {
      // attestationScore = 49 * 2 = 98 -> 40% * 98 = 39.2 -> 39
      expect(score({ bondedAmount: '0', attestationCount: MAX_ATTESTATION_COUNT - 1 })).toBe(39)
    })

    it('saturates the attestation axis exactly at the cap', () => {
      expect(score({ bondedAmount: '0', attestationCount: MAX_ATTESTATION_COUNT })).toBe(40)
    })

    it('saturates the attestation axis one unit above the cap', () => {
      expect(score({ bondedAmount: '0', attestationCount: MAX_ATTESTATION_COUNT + 1 })).toBe(40)
    })

    it('holds the attestation axis constant far above the cap', () => {
      const atCap = score({ bondedAmount: '0', attestationCount: MAX_ATTESTATION_COUNT })
      expect(score({ bondedAmount: '0', attestationCount: 1_000 })).toBe(atCap)
      expect(score({ bondedAmount: '0', attestationCount: Number.MAX_SAFE_INTEGER })).toBe(atCap)
    })

    it('moves the score one point at the smallest attestation count', () => {
      expect(score({ bondedAmount: '0', attestationCount: 0 })).toBe(MIN_SCORE)
      expect(score({ bondedAmount: '0', attestationCount: 1 })).toBe(1)
    })
  })

  describe('corners of the 2D input domain', () => {
    it.each([
      ['origin', '0', 0, 0],
      ['bond corner', '0', 0, 0],
      ['bond cap, no attestations', MAX_BOND_AMOUNT.toString(), 0, 60],
      ['no bond, attestation cap', '0', MAX_ATTESTATION_COUNT, 40],
      ['both caps', MAX_BOND_AMOUNT.toString(), MAX_ATTESTATION_COUNT, MAX_SCORE],
      ['both far above caps', '999999', 999_999, MAX_SCORE],
      ['both at zero', '0', 0, MIN_SCORE],
    ])('%s -> %i', (_label, bondedAmount, attestationCount, expected) => {
      expect(score({ bondedAmount, attestationCount })).toBe(expected)
    })

    it('reaches every integer score in the documented range with no gaps', () => {
      const reachable = new Set<number>()
      for (let bond = 0; bond <= 2_000; bond++) {
        for (let att = 0; att <= 100; att++) {
          reachable.add(score({ bondedAmount: String(bond), attestationCount: att }))
        }
      }
      expect(Math.min(...reachable)).toBe(MIN_SCORE)
      expect(Math.max(...reachable)).toBe(MAX_SCORE)
      expect(reachable.size).toBe(MAX_SCORE - MIN_SCORE + 1)
    })
  })

  describe('out-of-range values saturate instead of escaping the range', () => {
    it('floors a negative bond at zero rather than producing a negative score', () => {
      // Pre-hardening this produced -52 for bondedAmount '-1000'.
      expect(score({ bondedAmount: '-1000' })).toBe(0)
      expect(score({ bondedAmount: '-1' })).toBe(0)
      expect(score({ bondedAmount: '-1', attestationCount: 10 })).toBe(8)
      expect(score({ bondedAmount: '-999999999999999999999999' })).toBe(0)
    })

    it('floors a negative attestation count at zero', () => {
      // Pre-hardening this produced -40 for attestationCount -50.
      expect(score({ bondedAmount: '0', attestationCount: -50 })).toBe(MIN_SCORE)
      expect(score({ bondedAmount: '0', attestationCount: -1 })).toBe(MIN_SCORE)
      expect(score({ bondedAmount: '0', attestationCount: Number.MIN_SAFE_INTEGER })).toBe(MIN_SCORE)
    })

    it('never emits a negative or non-finite score for adversarial magnitudes', () => {
      const adversarial: Array<[string, unknown]> = [
        ['negative bond, negative attestations', { bondedAmount: '-500', attestationCount: -50 }],
        ['negative bond, huge attestations', { bondedAmount: '-500', attestationCount: Number.MAX_SAFE_INTEGER }],
        ['huge bond, negative attestations', { bondedAmount: '9'.repeat(400), attestationCount: -1 }],
        ['both extremes', { bondedAmount: `-${'9'.repeat(400)}`, attestationCount: Number.MIN_SAFE_INTEGER }],
      ]
      for (const [label, overrides] of adversarial) {
        const result = score(overrides as Partial<IdentityData>)
        expect(Number.isFinite(result), label).toBe(true)
        expect(result, label).toBeGreaterThanOrEqual(MIN_SCORE)
        expect(result, label).toBeLessThanOrEqual(MAX_SCORE)
      }
    })

    it('accepts every bigint magnitude without overflowing to Infinity', () => {
      // A 400-digit amount exceeds Number.MAX_VALUE, so an implementation that
      // converts before clamping would produce Infinity and then NaN.
      const result = score({ bondedAmount: '9'.repeat(400), attestationCount: MAX_ATTESTATION_COUNT })
      expect(result).toBe(MAX_SCORE)
      expect(Number.isFinite(result)).toBe(true)
      expect(Number.isNaN(result)).toBe(false)
    })
  })

  describe('numeric representations that must stay compatible', () => {
    it.each([
      ['canonical decimal', '1000', 60],
      ['leading zeros', '01000', 60],
      ['explicit plus sign', '+1000', 60],
      ['surrounding whitespace', ' 1000 ', 60],
      ['hexadecimal', '0x3e8', 60],
    ])('scores the %s bond form identically', (_label, bondedAmount, expected) => {
      expect(score({ bondedAmount })).toBe(expected)
    })

    it('accepts a safe integer number and a bigint bond without reinterpreting them', () => {
      expect(score({ bondedAmount: 1000 as unknown as string })).toBe(60)
      expect(score({ bondedAmount: 1000n as unknown as string })).toBe(60)
      expect(score({ bondedAmount: 0n as unknown as string })).toBe(0)
    })

    it('floors a negative number or bigint bond the same way it floors a string', () => {
      // All three input representations must saturate identically, otherwise the
      // score would depend on which numeric type the data source happened to
      // produce for the same underlying bond.
      const asString = score({ bondedAmount: '-1000' })
      expect(score({ bondedAmount: -1000 as unknown as string })).toBe(asString)
      expect(score({ bondedAmount: -1000n as unknown as string })).toBe(asString)
      expect(asString).toBe(0)
      expect(score({ bondedAmount: -1n as unknown as string })).toBe(0)
    })
  })
})

describe('computeScore input rejection', () => {
  describe('bondedAmount', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['tab and newline', '\t\n'],
      ['decimal notation', '1000.5'],
      ['exponent notation', '1e3'],
      ['numeric separator', '1_000'],
      ['hex with padding', '0xzz'],
      ['alphabetic', 'not-a-number'],
      ['a rejected value carrying a log payload', '1000\n[INFO] forged log line'],
      ['null', null],
      ['undefined', undefined],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['fractional number', 1000.5],
      ['unsafe integer number', Number.MAX_SAFE_INTEGER + 2],
      ['object', { amount: '1000' }],
      ['array', ['1000']],
      ['boolean', true],
    ])('rejects %s with INVALID_BONDED_AMOUNT', (_label, bondedAmount) => {
      expectRejection(() => score({ bondedAmount: bondedAmount as string }), 'INVALID_BONDED_AMOUNT', 'bondedAmount')
    })
  })

  describe('attestationCount', () => {
    it.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['fractional', 2.5],
      ['tiny fraction', Number.EPSILON],
      ['numeric string', '10'],
      ['empty numeric string', ''],
      ['null', null],
      ['undefined', undefined],
      ['bigint', 10n],
      ['unsafe integer', Number.MAX_SAFE_INTEGER + 2],
      ['object', { count: 10 }],
      ['array', [10]],
      ['boolean', false],
    ])('rejects %s with INVALID_ATTESTATION_COUNT', (_label, attestationCount) => {
      expectRejection(
        () => score({ attestationCount: attestationCount as number }),
        'INVALID_ATTESTATION_COUNT',
        'attestationCount',
      )
    })
  })

  describe('active', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['string "true"', 'true'],
      ['string "false"', 'false'],
      ['empty string', ''],
      ['number 1', 1],
      ['number 0', 0],
      ['object', {}],
    ])('rejects %s with INVALID_ACTIVE_FLAG', (_label, active) => {
      // A truthy-but-malformed `active` must never be treated as active, and a
      // falsy-but-malformed one must never silently persist a score of 0.
      expectRejection(() => score({ active: active as boolean }), 'INVALID_ACTIVE_FLAG', 'active')
    })
  })

  describe('identity data', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'identity'],
      ['a number', 7],
      ['a boolean', true],
    ])('rejects %s as INVALID_IDENTITY_DATA', (_label, data) => {
      expectRejection(() => scoreRaw(data), 'INVALID_IDENTITY_DATA', 'data')
    })
  })

  describe('recovery ordering', () => {
    it('short-circuits an inactive identity before validating numeric fields', () => {
      // The bond row of an inactive identity is irrelevant, so corruption there
      // must not block the definitive 0 from being recorded.
      expect(score({ active: false, bondedAmount: 'not-a-number' })).toBe(MIN_SCORE)
      expect(score({ active: false, bondedAmount: '' })).toBe(MIN_SCORE)
      expect(score({ active: false, attestationCount: NaN })).toBe(MIN_SCORE)
      expect(score({ active: false, attestationCount: -1 })).toBe(MIN_SCORE)
    })

    it('validates the active flag before touching numeric fields', () => {
      // With `active` unusable there is no safe answer, so the flag is reported
      // rather than the downstream field that happens to be read first.
      const error = expectRejection(
        () => score({ active: 'nope' as unknown as boolean, bondedAmount: '' }),
        'INVALID_ACTIVE_FLAG',
        'active',
      )
      expect(error.code).toBe('INVALID_ACTIVE_FLAG')
    })

    it('reports the bond before the attestation count', () => {
      expectRejection(
        () => score({ bondedAmount: 'bad', attestationCount: NaN }),
        'INVALID_BONDED_AMOUNT',
        'bondedAmount',
      )
    })
  })

  describe('error surface stays typed and predictable', () => {
    it('never leaks a raw BigInt or coercion error to the caller', () => {
      // Before hardening, BigInt('1000.5') escaped as a bare SyntaxError and
      // BigInt(null) as a TypeError, neither of which carries the offending
      // field or any machine-readable reason.
      const thrown: unknown[] = []
      for (const bondedAmount of ['1000.5', '1e3', '1_000', null, undefined, NaN]) {
        try {
          score({ bondedAmount: bondedAmount as string })
        } catch (error) {
          thrown.push(error)
        }
      }
      expect(thrown).toHaveLength(6)
      for (const error of thrown) {
        expect(error).toBeInstanceOf(ScoreComputationError)
        expect(error).not.toBeInstanceOf(SyntaxError)
        expect(error).not.toBeInstanceOf(TypeError)
      }
    })

    it('produces an identical error for identical invalid input', () => {
      const first = expectRejection(() => score({ bondedAmount: '1e3' }), 'INVALID_BONDED_AMOUNT', 'bondedAmount')
      const second = expectRejection(() => score({ bondedAmount: '1e3' }), 'INVALID_BONDED_AMOUNT', 'bondedAmount')
      expect(first.message).toBe(second.message)
      expect(first.code).toBe(second.code)
    })

    it('never mutates the input row', () => {
      const row = activeRow({ bondedAmount: '0500', attestationCount: 7 })
      const snapshot = { ...row }
      computeScore(row)
      expect(row).toEqual(snapshot)
    })
  })
})

describe('computeScore error diagnosability', () => {
  it('carries the rejection code in the message for log aggregation', () => {
    const error = expectRejection(() => score({ bondedAmount: 'oops' }), 'INVALID_BONDED_AMOUNT', 'bondedAmount')
    expect(error.message).toContain('[INVALID_BONDED_AMOUNT]')
    expect(error.message).toContain('bondedAmount')
  })

  it('attaches the offending identity address to the error', () => {
    const error = expectRejection(
      () => score({ address: 'GABC123', bondedAmount: 'oops' }),
      'INVALID_BONDED_AMOUNT',
      'bondedAmount',
    )
    expect(error.address).toBe('GABC123')
    expect(error.message).toContain('GABC123')
  })

  it('does not echo the raw offending value into the message', () => {
    // bondedAmount is attacker-influenced data from an external source; echoing
    // it verbatim would let a crafted row inject payloads into logs.
    const poison = '1000\n[ERROR] forged line'
    const error = expectRejection(
      () => score({ bondedAmount: poison }),
      'INVALID_BONDED_AMOUNT',
      'bondedAmount',
    )
    expect(error.message).not.toContain('1000')
    expect(error.message).not.toContain('forged line')
    // Exactly one line, so a log formatter cannot be made to emit a second one.
    expect(error.message.split('\n')).toHaveLength(1)
  })

  it('sanitises control characters out of the address before logging it', () => {
    const error = expectRejection(
      () => score({ address: 'GABC\r\nINFO forged', bondedAmount: 'oops' }),
      'INVALID_BONDED_AMOUNT',
      'bondedAmount',
    )
    expect(error.address).toBe('GABC??INFO?forged')
    expect(error.address).not.toMatch(/[\r\n]/)
    expect(error.message.split('\n')).toHaveLength(1)
    expect(error.message).toContain('GABC??INFO?forged')
  })

  it('truncates an over-long address instead of logging it whole', () => {
    const error = expectRejection(
      () => score({ address: 'G'.repeat(500), bondedAmount: 'oops' }),
      'INVALID_BONDED_AMOUNT',
      'bondedAmount',
    )
    expect(error.address.length).toBeLessThanOrEqual(65)
    expect(error.message).not.toContain('G'.repeat(100))
  })

  it('reports "unknown" for a missing or unusable address', () => {
    const missing = expectRejection(
      () => score({ address: undefined as unknown as string, bondedAmount: 'oops' }),
      'INVALID_BONDED_AMOUNT',
      'bondedAmount',
    )
    expect(missing.address).toBe('unknown')

    // A whitespace-only address sanitises down to nothing identifiable, so it
    // must not be rendered as a bare "?" that looks like a real address.
    for (const blank of [' ', '\t', '\r\n', ' ']) {
      const error = expectRejection(
        () => score({ address: blank, bondedAmount: 'oops' }),
        'INVALID_BONDED_AMOUNT',
        'bondedAmount',
      )
      expect(error.address, JSON.stringify(blank)).toBe('unknown')
    }
  })

  it('is catchable as a plain Error by existing callers', () => {
    // ScoreSnapshotJob's recovery path catches `error instanceof Error`; the
    // typed error must keep satisfying that check.
    try {
      score({ bondedAmount: 'oops' })
      expect.unreachable('expected computeScore to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBeTypeOf('string')
    }
  })
})

describe('computeScore scoring invariants', () => {
  const validRowArb = fc.record({
    address: fc.constant('0xabc'),
    active: fc.constant(true),
    bondedAmount: fc.oneof(
      fc.integer({ min: 0, max: 100_000 }).map(String),
      fc.integer({ min: 0, max: 100_000 }).map((n) => BigInt(n).toString()),
    ),
    attestationCount: fc.integer({ min: 0, max: 10_000 }),
  })

  it('always returns a bounded integer for every well-formed input', () => {
    fc.assert(
      fc.property(validRowArb, (row) => {
        const result = computeScore(row)
        expect(Number.isInteger(result)).toBe(true)
        expect(result).toBeGreaterThanOrEqual(MIN_SCORE)
        expect(result).toBeLessThanOrEqual(MAX_SCORE)
      }),
      { numRuns: 500 },
    )
  })

  it('is total: arbitrary input either scores in range or raises ScoreComputationError', () => {
    fc.assert(
      fc.property(fc.anything(), (data) => {
        let result: number | undefined
        try {
          result = computeScore(data as IdentityData)
        } catch (error) {
          expect(error).toBeInstanceOf(ScoreComputationError)
          return
        }
        expect(Number.isInteger(result)).toBe(true)
        expect(result).toBeGreaterThanOrEqual(MIN_SCORE)
        expect(result).toBeLessThanOrEqual(MAX_SCORE)
      }),
      { numRuns: 1000 },
    )
  })

  it('is a pure function of its input', () => {
    fc.assert(
      fc.property(validRowArb, (row) => {
        const first = computeScore(row)
        const second = computeScore(row)
        expect(second).toBe(first)
      }),
      { numRuns: 300 },
    )
  })

  it('is monotone non-decreasing in bond amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 0, max: 200 }),
        (bondA, bondB, attestationCount) => {
          const [low, high] = bondA <= bondB ? [bondA, bondB] : [bondB, bondA]
          const atLow = score({ bondedAmount: String(low), attestationCount })
          const atHigh = score({ bondedAmount: String(high), attestationCount })
          expect(atHigh).toBeGreaterThanOrEqual(atLow)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('is monotone non-decreasing in attestation count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 20_000 }),
        (attA, attB, bondedAmount) => {
          const [low, high] = attA <= attB ? [attA, attB] : [attB, attA]
          const atLow = score({ bondedAmount: String(bondedAmount), attestationCount: low })
          const atHigh = score({ bondedAmount: String(bondedAmount), attestationCount: high })
          expect(atHigh).toBeGreaterThanOrEqual(atLow)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('is bounded above by the fully-saturated identity', () => {
    fc.assert(
      fc.property(validRowArb, (row) => {
        const saturated = score({ bondedAmount: MAX_BOND_AMOUNT.toString(), attestationCount: MAX_ATTESTATION_COUNT })
        expect(computeScore(row)).toBeLessThanOrEqual(saturated)
      }),
      { numRuns: 300 },
    )
  })

  it('scores an inactive identity at zero regardless of the rest of the vector', () => {
    fc.assert(
      fc.property(validRowArb, (row) => {
        expect(computeScore({ ...row, active: false })).toBe(MIN_SCORE)
      }),
      { numRuns: 300 },
    )
  })

  it('never returns NaN, even for non-finite counts', () => {
    for (const attestationCount of [NaN, Infinity, -Infinity, 2.5, '10' as unknown as number]) {
      let result: number | 'rejected' = 'rejected'
      try {
        result = score({ bondedAmount: '1000', attestationCount })
      } catch {
        // Rejection is the expected outcome; the invariant is that no NaN escapes.
      }
      expect(result).not.toBeNaN()
    }
  })
})

describe('computeScore parity with the documented formula', () => {
  /**
   * The documented model, expressed with the original floating-point
   * arithmetic. Kept independent of the production integer path so a change to
   * either one shows up as a divergence rather than a shared assumption.
   */
  function documentedFloatFormula(bondedAmount: string, attestationCount: number): number {
    const bondScore = Math.min(Number((BigInt(bondedAmount) * 100n) / 1000n), 100)
    const attestationScore = Math.min((attestationCount / 50) * 100, 100)
    return Math.round(0.6 * bondScore + 0.4 * attestationScore)
  }

  it('matches the documented formula across the whole valid input grid', () => {
    // Integer-exact scoring is only a safe substitution if it agrees with the
    // float formula everywhere, including exact .5 rounding boundaries.
    // Mismatches are accumulated rather than asserted per cell so a failure
    // reports the diverging inputs instead of just the first one.
    const mismatches: string[] = []
    for (let bond = 0; bond <= 1_200; bond++) {
      for (let attestations = 0; attestations <= 60; attestations++) {
        const actual = score({ bondedAmount: String(bond), attestationCount: attestations })
        const expected = documentedFloatFormula(String(bond), attestations)
        if (actual !== expected) {
          mismatches.push(`bond=${bond} attestations=${attestations} integer=${actual} float=${expected}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  }, 60_000)

  it('matches the documented formula above the saturation points', () => {
    for (const bond of [1_000, 1_001, 5_000, 1_000_000, 10n ** 30n]) {
      for (const attestations of [50, 51, 200, 10_000]) {
        expect(score({ bondedAmount: bond.toString(), attestationCount: attestations })).toBe(
          documentedFloatFormula(bond.toString(), attestations),
        )
      }
    }
  })
})

/**
 * Job-level harness that runs the real `computeScore` through the real
 * `ScoreSnapshotJob`, so the recovery and partial-failure paths under test are
 * the ones production uses.
 */
function createHarness(options: { batchSize?: number; continueOnError?: boolean } = {}) {
  const saved: ScoreSnapshot[] = []
  const logs: string[] = []

  const store: ScoreSnapshotStore = {
    save: vi.fn(async (snapshot: ScoreSnapshot) => {
      saved.push(snapshot)
    }),
    saveBatch: vi.fn(async (snapshots: ScoreSnapshot[]) => {
      saved.push(...snapshots)
    }),
  }

  function dataSourceFor(
    rows: Record<string, Partial<IdentityData>>,
    addresses?: string[],
  ): IdentityDataSource {
    return {
      getActiveAddresses: vi.fn(async () => addresses ?? Object.keys(rows)),
      getIdentityData: vi.fn(async (address: string) => ({
        address,
        bondedAmount: '0',
        active: true,
        attestationCount: 0,
        ...rows[address],
      })),
      getIdentityDataBatch: vi.fn(async (requested: string[]) =>
        requested.map((address) => ({
          address,
          bondedAmount: '0',
          active: true,
          attestationCount: 0,
          ...rows[address],
        })),
      ),
    }
  }

  function jobFor(
    rows: Record<string, Partial<IdentityData>>,
    addresses?: string[],
  ): ScoreSnapshotJob {
    return createScoreSnapshotJob(dataSourceFor(rows, addresses), store, computeScore, {
      logger: (message) => logs.push(message),
      ...options,
    })
  }

  return { saved, logs, store, dataSourceFor, jobFor }
}

describe('ScoreSnapshotJob recovery with the hardened scoreComputer', () => {
  it('isolates a corrupt row so every healthy identity in the batch is still saved', async () => {
    const { saved, logs, jobFor } = createHarness()
    const job = jobFor({
      'Ghealthy1': { bondedAmount: '1000', attestationCount: 0 },
      'Gcorrupt': { bondedAmount: 'not-a-number' },
      'Ghealthy2': { bondedAmount: '0', attestationCount: 50 },
    })

    const result = await job.run()

    expect(result.errors).toBe(1)
    expect(result.saved).toBe(2)
    expect(result.processed).toBe(2)
    expect(saved.map((snapshot) => snapshot.address).sort()).toEqual(['Ghealthy1', 'Ghealthy2'])
    expect(saved.find((s) => s.address === 'Ghealthy1')?.score).toBe(60)
    expect(saved.find((s) => s.address === 'Ghealthy2')?.score).toBe(40)
    expect(logs.some((line) => line.includes('[INVALID_BONDED_AMOUNT]'))).toBe(true)
  })

  it('produces the same isolation on the legacy per-identity load path', async () => {
    const { saved, jobFor } = createHarness()
    const job = jobFor({
      'Ghealthy1': { bondedAmount: '1000' },
      'Gcorrupt': { attestationCount: NaN },
      'Ghealthy2': { bondedAmount: '500', attestationCount: 25 },
    })
    delete (job as unknown as { dataSource: IdentityDataSource }).dataSource.getIdentityDataBatch

    const result = await job.run()

    expect(result.errors).toBe(1)
    expect(result.saved).toBe(2)
    expect(saved.map((snapshot) => snapshot.address).sort()).toEqual(['Ghealthy1', 'Ghealthy2'])
  })

  it('clears the staleness on retry once the underlying row is repaired', async () => {
    const { saved, jobFor } = createHarness()
    const corrupt = { bondedAmount: '1e3' }

    const first = await jobFor({ 'Gretry': corrupt, 'Gok': { bondedAmount: '1000' } }).run()
    expect(first.errors).toBe(1)
    expect(saved.map((snapshot) => snapshot.address)).toEqual(['Gok'])

    // Same scheduler, next tick: the row is repaired and the identity gets a
    // snapshot again, so its score is no longer stale-but-current.
    const repaired = await jobFor({ 'Gretry': { bondedAmount: '1000' }, 'Gok': { bondedAmount: '1000' } }).run()
    expect(repaired.errors).toBe(0)
    expect(repaired.saved).toBe(2)
    expect(saved.filter((snapshot) => snapshot.address === 'Gretry')).toHaveLength(1)
    expect(saved.find((snapshot) => snapshot.address === 'Gretry')?.score).toBe(60)
  })

  it('records the definitive zero for an inactive identity whose bond row is corrupt', async () => {
    // Throwing here would leave the previously-persisted score in place and
    // readable as current, which is the staleness this ordering avoids.
    const { saved, jobFor } = createHarness()
    const result = await jobFor({ 'Gslashed': { active: false, bondedAmount: 'corrupt' } }).run()

    expect(result.errors).toBe(0)
    expect(result.saved).toBe(1)
    expect(saved[0]).toMatchObject({ address: 'Gslashed', score: 0 })
  })

  it('preserves the rejection identity when abort mode is enabled', async () => {
    // batchSize 1 so the healthy identity commits in its own batch before the
    // corrupt row aborts the run.
    const { saved, jobFor } = createHarness({ continueOnError: false, batchSize: 1 })
    const job = jobFor({ 'Gfirst': { bondedAmount: '1000' }, 'Gcorrupt': { bondedAmount: '' } })

    let caught: unknown
    try {
      await job.run()
    } catch (error) {
      caught = error
    }

    // Not a wrapped or generic failure: the operator can still read the code and
    // the field off the propagated error.
    expect(caught).toBeInstanceOf(ScoreComputationError)
    expect((caught as ScoreComputationError).code).toBe('INVALID_BONDED_AMOUNT')
    expect((caught as ScoreComputationError).address).toBe('Gcorrupt')
    // The healthy identity committed before the abort is not rolled back or lost.
    expect(saved.map((snapshot) => snapshot.address)).toEqual(['Gfirst'])
  })

  it('never persists a snapshot whose score is outside the documented range', async () => {
    const { saved, jobFor } = createHarness()
    await jobFor({
      'GnegativeBond': { bondedAmount: '-1000', attestationCount: 10 },
      'GnegativeAttestations': { bondedAmount: '0', attestationCount: -50 },
      'GhugeBond': { bondedAmount: '9'.repeat(400), attestationCount: 50 },
      'Gok': { bondedAmount: '333', attestationCount: 17 },
    }).run()

    expect(saved).toHaveLength(4)
    for (const snapshot of saved) {
      expect(Number.isInteger(snapshot.score)).toBe(true)
      expect(snapshot.score).toBeGreaterThanOrEqual(MIN_SCORE)
      expect(snapshot.score).toBeLessThanOrEqual(MAX_SCORE)
      // The persisted snapshot must survive JSON round-tripping.
      expect(JSON.parse(JSON.stringify(snapshot)).score).toBe(snapshot.score)
    }
  })

  it('scores duplicated addresses deterministically without dropping either', async () => {
    const { saved, jobFor } = createHarness()
    // The same address listed twice must produce two identical, well-formed
    // snapshots: the deduplication contract stays explicit rather than
    // depending on which list the data source happened to return.
    const result = await jobFor(
      { 'Gdup': { bondedAmount: '500', attestationCount: 25 } },
      ['Gdup', 'Gdup'],
    ).run()

    expect(result.errors).toBe(0)
    expect(result.processed).toBe(2)
    expect(result.saved).toBe(2)
    expect(saved).toHaveLength(2)
    expect(saved[0].score).toBe(50)
    expect(saved[1].score).toBe(saved[0].score)
    expect(saved[1]).toMatchObject({ address: 'Gdup', bondedAmount: '500', attestationCount: 25 })
  })

  it('produces the same scores on a repeated run of the same batch', async () => {
    const rows = {
      'Ga': { bondedAmount: '333', attestationCount: 17 },
      'Gb': { bondedAmount: '0', attestationCount: 50 },
      'Gc': { bondedAmount: '1000', attestationCount: 0 },
    }
    const first = createHarness()
    const second = createHarness()
    await first.jobFor(rows).run()
    await second.jobFor(rows).run()

    expect(first.saved.map((snapshot) => snapshot.score)).toEqual([33, 40, 60])
    expect(second.saved.map((snapshot) => snapshot.score)).toEqual(
      first.saved.map((snapshot) => snapshot.score),
    )
  })

  it('aggregates every distinct rejection code within a single run', async () => {
    const { logs, jobFor } = createHarness()
    const result = await jobFor({
      'Gbond': { bondedAmount: 'oops' },
      'Gattestations': { bondedAmount: '1000', attestationCount: NaN },
      'Gflag': { active: 'true' as unknown as boolean },
    }).run()

    expect(result.errors).toBe(3)
    expect(result.saved).toBe(0)
    for (const code of ['INVALID_BONDED_AMOUNT', 'INVALID_ATTESTATION_COUNT', 'INVALID_ACTIVE_FLAG']) {
      expect(logs.some((line) => line.includes(`[${code}]`)), code).toBe(true)
    }
  })

  it('keeps concurrent runs over independent sources isolated', async () => {
    const healthy = createHarness()
    const corrupt = createHarness()

    const [goodResult, badResult] = await Promise.all([
      healthy.jobFor({ 'Ga': { bondedAmount: '1000' }, 'Gb': { bondedAmount: '1000' } }).run(),
      corrupt.jobFor({ 'Gc': { bondedAmount: 'bad' }, 'Gd': { bondedAmount: '1000' } }).run(),
    ])

    expect(goodResult).toMatchObject({ errors: 0, saved: 2 })
    expect(badResult).toMatchObject({ errors: 1, saved: 1 })
    expect(healthy.saved.map((s) => s.address).sort()).toEqual(['Ga', 'Gb'])
    expect(corrupt.saved.map((s) => s.address)).toEqual(['Gd'])
  })

  it('keeps a huge batch exact when some rows are rejected', async () => {
    const { saved, logs, jobFor } = createHarness({ batchSize: 25 })
    const rows: Record<string, Partial<IdentityData>> = {}
    for (let i = 0; i < 250; i++) {
      rows[`G${i}`] = i % 50 === 0 ? { bondedAmount: 'bad' } : { bondedAmount: '1000' }
    }

    const result = await jobFor(rows).run()

    // Row accounting stays exact: every rejected row is counted as an error and
    // excluded from `processed`/`saved`, so nothing is double-counted or lost.
    expect(result.errors).toBe(5)
    expect(result.processed).toBe(245)
    expect(result.saved).toBe(245)
    expect(result.saved).toBe(result.processed)
    expect(new Set(saved.map((s) => s.address)).size).toBe(245)
    expect(saved.every((s) => s.score === 60)).toBe(true)
    expect(logs.filter((line) => line.includes('[INVALID_BONDED_AMOUNT]')).length).toBe(5)
  })
})
