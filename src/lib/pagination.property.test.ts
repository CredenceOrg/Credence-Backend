/**
 * Property-based tests for src/lib/pagination.ts
 *
 * Fixed seed ensures deterministic CI runs. Each suite targets one invariant:
 *   1. Round-trip: decode(encode(c)) === c for all valid DecodedCursor values.
 *   2. Tamper-rejection: any single-byte mutation of an encoded cursor throws
 *      PaginationValidationError – never returns a wrong cursor.
 *   3. parsePositiveInteger (via parsePaginationParams): accepts only positive
 *      integers, rejects floats, negatives, zero, and non-numeric strings.
 *   4. Limit clamping: parsed limit always lands within [1, MAX_LIMIT].
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

// Must be set before importing the config-dependent module.
process.env.JWT_SECRET = 'property-test-secret-32-chars-ok!'
process.env.DB_URL = 'postgres://x:x@localhost/x'
process.env.REDIS_URL = 'redis://localhost:6379'

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PaginationValidationError,
  decodeCursor,
  encodeCursor,
  parsePaginationParams,
} from './pagination.js'

const SEED = 0xc0ffee

/** Arbitrary for valid DecodedCursor fields: any non-empty string pair. */
const validCursorArb = fc.record({
  t: fc.string({ minLength: 1, maxLength: 200 }),
  i: fc.string({ minLength: 1, maxLength: 200 }),
})

// ---------------------------------------------------------------------------
// 1. Round-trip
// ---------------------------------------------------------------------------

describe('cursor round-trip: decode(encode(c)) === c', () => {
  it('holds for arbitrary timestamp strings and ids', () => {
    fc.assert(
      fc.property(validCursorArb, ({ t, i }) => {
        const encoded = encodeCursor(t, i)
        const decoded = decodeCursor(encoded)
        expect(decoded).toEqual({ t, i })
      }),
      { seed: SEED },
    )
  })

  it('holds when timestamp is a Date object', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date(0), max: new Date('2100-01-01') }),
        fc.uuid(),
        (date, id) => {
          const encoded = encodeCursor(date, id)
          const decoded = decodeCursor(encoded)
          expect(decoded).toEqual({ t: date.toISOString(), i: id })
        },
      ),
      { seed: SEED },
    )
  })
})

// ---------------------------------------------------------------------------
// 2. Tamper-rejection: single-byte mutation
// ---------------------------------------------------------------------------

describe('tamper-rejection: single-byte mutation of an encoded cursor', () => {
  /**
   * Mutates one byte of a Buffer at `position` by XOR-ing with `delta`.
   * `delta` is clamped to [1, 255] so the byte actually changes.
   */
  function mutateByte(buf: Buffer, position: number, delta: number): Buffer {
    const copy = Buffer.from(buf)
    copy[position] = (copy[position] ^ ((delta & 0xff) || 1)) & 0xff
    return copy
  }

  it('always throws PaginationValidationError, never returns a wrong cursor', () => {
    fc.assert(
      fc.property(
        validCursorArb,
        fc.integer({ min: 1, max: 255 }), // delta ≥ 1: byte always changes
        ({ t, i }, delta) => {
          const encoded = encodeCursor(t, i)
          const raw = Buffer.from(encoded, 'utf8')

          for (let pos = 0; pos < raw.length; pos++) {
            const mutated = mutateByte(raw, pos, delta).toString('utf8')

            // Skip mutations that only flip base64url padding bits: those change
            // the encoded string but not the decoded payload, so the HMAC still
            // matches and decodeCursor correctly returns the original value.
            // This is not a bypass — the content is identical.
            const origPayload = Buffer.from(encoded, 'base64url').toString('utf8')
            let mutPayload: string
            try {
              mutPayload = Buffer.from(mutated, 'base64url').toString('utf8')
            } catch {
              continue // mutation made the string un-decodeable → acceptable
            }
            if (origPayload === mutPayload) continue // padding-only flip → safe

            // The mutation changed the decoded payload — decodeCursor must reject it.
            let result: ReturnType<typeof decodeCursor> | undefined
            let thrown: unknown
            try {
              result = decodeCursor(mutated)
            } catch (err) {
              thrown = err
            }

            if (thrown !== undefined) {
              if (!(thrown instanceof PaginationValidationError)) throw thrown
            } else if (result !== null) {
              throw new Error(
                `Tamper bypass: mutated cursor decoded successfully at pos=${pos}, delta=${delta}, ` +
                `original={t:${JSON.stringify(t)},i:${JSON.stringify(i)}}`,
              )
            }
          }
        },
      ),
      { seed: SEED, numRuns: 50 },
    )
  })
})

// ---------------------------------------------------------------------------
// 3. parsePositiveInteger (exercised through parsePaginationParams)
// ---------------------------------------------------------------------------

describe('parsePositiveInteger semantics via parsePaginationParams', () => {
  it('accepts positive integers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_LIMIT }), (n) => {
        const result = parsePaginationParams({ limit: String(n) })
        expect(result.limit).toBe(n)
      }),
      { seed: SEED },
    )
  })

  it('rejects floats', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noInteger: true, noNaN: true }),
        (f) => {
          expect(() => parsePaginationParams({ limit: String(f) })).toThrow(
            PaginationValidationError,
          )
        },
      ),
      { seed: SEED },
    )
  })

  it('rejects negative integers', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e6, max: -1 }), (n) => {
        expect(() => parsePaginationParams({ limit: String(n) })).toThrow(
          PaginationValidationError,
        )
      }),
      { seed: SEED },
    )
  })

  it('rejects zero', () => {
    expect(() => parsePaginationParams({ limit: '0' })).toThrow(PaginationValidationError)
  })

  it('rejects non-numeric strings', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1 })
          .filter((s) => s.trim() !== '' && Number.isNaN(Number(s))),
        (s) => {
          expect(() => parsePaginationParams({ limit: s })).toThrow(PaginationValidationError)
        },
      ),
      { seed: SEED },
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Limit clamping
// ---------------------------------------------------------------------------

describe('limit clamping: parsed limit always in [DEFAULT_LIMIT, MAX_LIMIT]', () => {
  it('uses DEFAULT_LIMIT when limit is absent', () => {
    const result = parsePaginationParams({})
    expect(result.limit).toBe(DEFAULT_LIMIT)
  })

  it('valid limits [1, MAX_LIMIT] are returned as-is', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_LIMIT }), (n) => {
        const result = parsePaginationParams({ limit: String(n) })
        expect(result.limit).toBe(n)
        expect(result.limit).toBeGreaterThanOrEqual(1)
        expect(result.limit).toBeLessThanOrEqual(MAX_LIMIT)
      }),
      { seed: SEED },
    )
  })

  it('limits above MAX_LIMIT are rejected', () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_LIMIT + 1, max: MAX_LIMIT + 10_000 }), (n) => {
        expect(() => parsePaginationParams({ limit: String(n) })).toThrow(
          PaginationValidationError,
        )
      }),
      { seed: SEED },
    )
  })
})
