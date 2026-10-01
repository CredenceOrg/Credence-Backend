/**
 * Boundary and recovery test coverage for src/lib/pagination.ts
 *
 * These tests cover:
 *   - Boundary values (min/max page, limit, offset, total)
 *   - Invalid / malformed inputs (NaN, Infinity, special chars, XSS)
 *   - Cursor encode/decode edge cases (empty strings, missing fields, tampered HMAC)
 *   - Error accumulation (multiple validation errors in a single call)
 *   - Recovery: deterministic results under duplicate/concurrent calls
 *   - buildPaginationMeta edge cases
 *   - buildCursorPaginationMeta edge cases
 *   - buildCursorEnvelope determinism
 *   - buildLinkHeader boundary cases
 *   - buildPaginationLinks boundary cases
 *   - buildCursorPaginationLinks boundary cases
 *   - PaginationValidationError structure integrity
 */
import { describe, expect, it } from 'vitest'

// Must be set before importing config-dependent modules
process.env.JWT_SECRET = 'boundary-test-secret-32-chars-ok!'
process.env.DB_URL = 'postgres://x:x@localhost/x'
process.env.REDIS_URL = 'redis://localhost:6379'

import {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PaginationValidationError,
  parsePaginationParams,
  buildPaginationMeta,
  buildCursorPaginationMeta,
  buildCursorEnvelope,
  buildLinkHeader,
  buildPaginationLinks,
  buildCursorPaginationLinks,
  encodeCursor,
  decodeCursor,
} from './pagination.js'

// ─────────────────────────────────────────────────────────────────────────────
// 1. parsePaginationParams — Boundary inputs
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePaginationParams — boundary inputs', () => {
  // ── Defaults ──────────────────────────────────────────────────────────────

  it('returns defaults for completely empty query', () => {
    const result = parsePaginationParams({})
    expect(result).toEqual({
      page: DEFAULT_PAGE,
      limit: DEFAULT_LIMIT,
      offset: 0,
      cursor: null,
      decodedCursor: undefined,
    })
  })

  it('returns defaults when all values are undefined', () => {
    const result = parsePaginationParams({
      page: undefined,
      limit: undefined,
      offset: undefined,
      cursor: undefined,
    })
    expect(result).toEqual({
      page: DEFAULT_PAGE,
      limit: DEFAULT_LIMIT,
      offset: 0,
      cursor: null,
      decodedCursor: undefined,
    })
  })

  it('returns defaults when all values are null', () => {
    const result = parsePaginationParams({
      page: null,
      limit: null,
      offset: null,
      cursor: null,
    })
    expect(result).toEqual({
      page: DEFAULT_PAGE,
      limit: DEFAULT_LIMIT,
      offset: 0,
      cursor: null,
      decodedCursor: undefined,
    })
  })

  it('treats empty strings the same as absent values', () => {
    const result = parsePaginationParams({ page: '', limit: '', offset: '', cursor: '' })
    expect(result.page).toBe(DEFAULT_PAGE)
    expect(result.limit).toBe(DEFAULT_LIMIT)
    expect(result.offset).toBe(0)
    expect(result.cursor).toBeNull()
  })

  it('treats whitespace-only strings the same as absent values', () => {
    const result = parsePaginationParams({ page: '  ', limit: '  ', offset: '  ', cursor: '  ' })
    expect(result.page).toBe(DEFAULT_PAGE)
    expect(result.limit).toBe(DEFAULT_LIMIT)
    expect(result.offset).toBe(0)
    expect(result.cursor).toBeNull()
  })

  // ── Valid boundary values ─────────────────────────────────────────────────

  it('accepts page=1 (minimum valid page)', () => {
    const result = parsePaginationParams({ page: '1' })
    expect(result.page).toBe(1)
  })

  it('accepts limit=1 (minimum valid limit)', () => {
    const result = parsePaginationParams({ limit: '1' })
    expect(result.limit).toBe(1)
    expect(result.offset).toBe(0)
  })

  it('accepts limit=MAX_LIMIT (maximum valid limit)', () => {
    const result = parsePaginationParams({ limit: String(MAX_LIMIT) })
    expect(result.limit).toBe(MAX_LIMIT)
  })

  it('accepts offset=0 (minimum valid offset)', () => {
    const result = parsePaginationParams({ offset: '0' })
    expect(result.offset).toBe(0)
  })

  it('accepts very large page numbers', () => {
    const result = parsePaginationParams({ page: '999999' })
    expect(result.page).toBe(999999)
    expect(result.offset).toBe((999999 - 1) * DEFAULT_LIMIT)
  })

  it('accepts very large offset', () => {
    const result = parsePaginationParams({ offset: '1000000' })
    expect(result.offset).toBe(1000000)
  })

  // ── Custom options ────────────────────────────────────────────────────────

  it('respects custom defaultPage option', () => {
    const result = parsePaginationParams({}, { defaultPage: 5 })
    expect(result.page).toBe(5)
    expect(result.offset).toBe(4 * DEFAULT_LIMIT)
  })

  it('respects custom defaultLimit option', () => {
    const result = parsePaginationParams({}, { defaultLimit: 50 })
    expect(result.limit).toBe(50)
  })

  it('respects custom maxLimit option', () => {
    // Should accept limit up to custom max
    const result = parsePaginationParams({ limit: '200' }, { maxLimit: 200 })
    expect(result.limit).toBe(200)
  })

  it('rejects limit above custom maxLimit', () => {
    expect(() =>
      parsePaginationParams({ limit: '201' }, { maxLimit: 200 }),
    ).toThrow(PaginationValidationError)
  })

  // ── Invalid boundary values ───────────────────────────────────────────────

  it('rejects page=0', () => {
    expect(() => parsePaginationParams({ page: '0' })).toThrow(PaginationValidationError)
  })

  it('rejects page=-1', () => {
    expect(() => parsePaginationParams({ page: '-1' })).toThrow(PaginationValidationError)
  })

  it('rejects limit=0', () => {
    expect(() => parsePaginationParams({ limit: '0' })).toThrow(PaginationValidationError)
  })

  it('rejects limit=-1', () => {
    expect(() => parsePaginationParams({ limit: '-1' })).toThrow(PaginationValidationError)
  })

  it('rejects limit=MAX_LIMIT+1', () => {
    expect(() =>
      parsePaginationParams({ limit: String(MAX_LIMIT + 1) }),
    ).toThrow(PaginationValidationError)
  })

  it('rejects offset=-1', () => {
    expect(() => parsePaginationParams({ offset: '-1' })).toThrow(PaginationValidationError)
  })

  it('rejects NaN page', () => {
    expect(() => parsePaginationParams({ page: 'NaN' })).toThrow(PaginationValidationError)
  })

  it('rejects NaN limit', () => {
    expect(() => parsePaginationParams({ limit: 'NaN' })).toThrow(PaginationValidationError)
  })

  it('rejects Infinity limit', () => {
    expect(() => parsePaginationParams({ limit: 'Infinity' })).toThrow(PaginationValidationError)
  })

  it('rejects -Infinity page', () => {
    expect(() => parsePaginationParams({ page: '-Infinity' })).toThrow(PaginationValidationError)
  })

  it('rejects floating point page', () => {
    expect(() => parsePaginationParams({ page: '1.5' })).toThrow(PaginationValidationError)
  })

  it('rejects floating point limit', () => {
    expect(() => parsePaginationParams({ limit: '10.7' })).toThrow(PaginationValidationError)
  })

  it('rejects floating point offset', () => {
    expect(() => parsePaginationParams({ offset: '5.5' })).toThrow(PaginationValidationError)
  })

  it('rejects alphabetic page', () => {
    expect(() => parsePaginationParams({ page: 'abc' })).toThrow(PaginationValidationError)
  })

  it('rejects special characters in limit', () => {
    expect(() => parsePaginationParams({ limit: '<script>' })).toThrow(PaginationValidationError)
  })

  it('rejects XSS-like page input', () => {
    expect(() =>
      parsePaginationParams({ page: '"><img src=x onerror=alert(1)>' }),
    ).toThrow(PaginationValidationError)
  })

  it('rejects SQL injection-like offset input', () => {
    expect(() =>
      parsePaginationParams({ offset: "1; DROP TABLE users--" }),
    ).toThrow(PaginationValidationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. parsePaginationParams — Error accumulation
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePaginationParams — error accumulation', () => {
  it('accumulates errors for both invalid page and limit', () => {
    try {
      parsePaginationParams({ page: '0', limit: String(MAX_LIMIT + 1) })
      expect.fail('Should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PaginationValidationError)
      const details = (error as PaginationValidationError).details
      expect(details.length).toBeGreaterThanOrEqual(2)
      expect(details.some(d => d.path === 'page')).toBe(true)
      expect(details.some(d => d.path === 'limit')).toBe(true)
    }
  })

  it('accumulates errors for invalid page, limit, and offset simultaneously', () => {
    try {
      parsePaginationParams({ page: '-5', limit: '0', offset: '-10' })
      expect.fail('Should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PaginationValidationError)
      const details = (error as PaginationValidationError).details
      expect(details.length).toBeGreaterThanOrEqual(3)
      expect(details.some(d => d.path === 'page')).toBe(true)
      expect(details.some(d => d.path === 'limit')).toBe(true)
      expect(details.some(d => d.path === 'offset')).toBe(true)
    }
  })

  it('accumulates errors for non-integer page and over-max limit', () => {
    try {
      parsePaginationParams({ page: 'abc', limit: '999' })
      expect.fail('Should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PaginationValidationError)
      const details = (error as PaginationValidationError).details
      expect(details.length).toBeGreaterThanOrEqual(2)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. PaginationValidationError — structure integrity
// ─────────────────────────────────────────────────────────────────────────────

describe('PaginationValidationError — structure integrity', () => {
  it('has correct name', () => {
    const err = new PaginationValidationError([{ path: 'page', message: 'bad' }])
    expect(err.name).toBe('PaginationValidationError')
  })

  it('has correct message', () => {
    const err = new PaginationValidationError([{ path: 'page', message: 'bad' }])
    expect(err.message).toBe('Invalid pagination parameters')
  })

  it('is an instance of Error', () => {
    const err = new PaginationValidationError([])
    expect(err).toBeInstanceOf(Error)
  })

  it('preserves detail objects', () => {
    const details = [
      { path: 'page', message: 'too low' },
      { path: 'limit', message: 'too high' },
    ]
    const err = new PaginationValidationError(details)
    expect(err.details).toEqual(details)
    expect(err.details).toHaveLength(2)
  })

  it('details array is the same reference as constructor input', () => {
    const details = [{ path: 'test', message: 'msg' }]
    const err = new PaginationValidationError(details)
    expect(err.details).toBe(details)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cursor encode/decode — boundary and recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('cursor encode/decode — boundary and recovery', () => {
  it('round-trips a valid cursor', () => {
    const ts = '2024-01-01T00:00:00.000Z'
    const id = 'abc-123'
    const encoded = encodeCursor(ts, id)
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual({ t: ts, i: id })
  })

  it('round-trips when timestamp is a Date object', () => {
    const date = new Date('2024-06-15T12:30:00Z')
    const id = 'item-456'
    const encoded = encodeCursor(date, id)
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual({ t: date.toISOString(), i: id })
  })

  it('round-trips with empty-string timestamp', () => {
    const encoded = encodeCursor('', 'id')
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual({ t: '', i: 'id' })
  })

  it('round-trips with empty-string id', () => {
    const encoded = encodeCursor('ts', '')
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual({ t: 'ts', i: '' })
  })

  it('round-trips with unicode characters', () => {
    const encoded = encodeCursor('2024-01-01T00:00:00Z', '日本語テスト-🎉')
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual({ t: '2024-01-01T00:00:00Z', i: '日本語テスト-🎉' })
  })

  it('round-trips with very long strings', () => {
    const longTs = 'a'.repeat(1000)
    const longId = 'b'.repeat(1000)
    const encoded = encodeCursor(longTs, longId)
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual({ t: longTs, i: longId })
  })

  it('round-trips with special JSON characters', () => {
    const encoded = encodeCursor('{"key": "value"}', '"quotes" and \\backslash')
    const decoded = decodeCursor(encoded)
    expect(decoded).toEqual({ t: '{"key": "value"}', i: '"quotes" and \\backslash' })
  })

  it('returns null for completely garbage input', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(decodeCursor('')).toBeNull()
  })

  it('returns null when base64url decodes to non-JSON', () => {
    // base64url encoding of 'hello world' which is not JSON
    const encoded = Buffer.from('hello world', 'utf8').toString('base64url')
    expect(decodeCursor(encoded)).toBeNull()
  })

  it('returns null when decoded JSON lacks t field', () => {
    const payload = JSON.stringify({ i: 'id', h: 'fakehash' })
    const encoded = Buffer.from(payload, 'utf8').toString('base64url')
    expect(decodeCursor(encoded)).toBeNull()
  })

  it('returns null when decoded JSON lacks i field', () => {
    const payload = JSON.stringify({ t: 'ts', h: 'fakehash' })
    const encoded = Buffer.from(payload, 'utf8').toString('base64url')
    expect(decodeCursor(encoded)).toBeNull()
  })

  it('throws PaginationValidationError when signature is missing', () => {
    const payload = JSON.stringify({ t: 'ts', i: 'id' })
    const encoded = Buffer.from(payload, 'utf8').toString('base64url')
    expect(() => decodeCursor(encoded)).toThrow(PaginationValidationError)
    try {
      decodeCursor(encoded)
    } catch (err) {
      expect((err as PaginationValidationError).details[0].message).toBe(
        'Cursor signature missing',
      )
    }
  })

  it('throws PaginationValidationError when signature is tampered', () => {
    const ts = '2024-01-01T00:00:00Z'
    const id = 'test-id'
    const encoded = encodeCursor(ts, id)

    // Decode, tamper with HMAC, re-encode
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    raw.h = raw.h.replace(/[0-9a-f]/, (c: string) =>
      c === '0' ? '1' : '0',
    )
    const tampered = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url')

    expect(() => decodeCursor(tampered)).toThrow(PaginationValidationError)
    try {
      decodeCursor(tampered)
    } catch (err) {
      expect((err as PaginationValidationError).details[0].message).toBe(
        'Cursor has been tampered with',
      )
    }
  })

  it('two encodes of same input produce identical output (deterministic)', () => {
    const ts = '2024-01-01T00:00:00Z'
    const id = 'id-123'
    const a = encodeCursor(ts, id)
    const b = encodeCursor(ts, id)
    expect(a).toBe(b)
  })

  it('different inputs produce different cursors', () => {
    const a = encodeCursor('2024-01-01T00:00:00Z', 'id-1')
    const b = encodeCursor('2024-01-01T00:00:00Z', 'id-2')
    expect(a).not.toBe(b)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. parsePaginationParams — cursor integration boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePaginationParams — cursor integration', () => {
  it('parses a valid encoded cursor', () => {
    const ts = '2024-01-01T00:00:00Z'
    const id = 'item-42'
    const encoded = encodeCursor(ts, id)
    const result = parsePaginationParams({ cursor: encoded })
    expect(result.cursor).toBe(encoded)
    expect(result.decodedCursor).toEqual({ t: ts, i: id })
  })

  it('treats numeric cursor as legacy offset', () => {
    const result = parsePaginationParams({ cursor: '50', limit: '10' })
    expect(result.offset).toBe(50)
    expect(result.page).toBe(6) // floor(50/10)+1
    expect(result.decodedCursor).toBeUndefined()
  })

  it('treats cursor=0 as legacy offset 0', () => {
    const result = parsePaginationParams({ cursor: '0', limit: '10' })
    expect(result.offset).toBe(0)
    expect(result.page).toBe(1)
  })

  it('rejects non-numeric, non-decodable cursor', () => {
    expect(() =>
      parsePaginationParams({ cursor: 'invalid-cursor-string!!!' }),
    ).toThrow(PaginationValidationError)
  })

  it('prefers explicit offset over cursor-as-offset', () => {
    const result = parsePaginationParams({ cursor: '999', offset: '50', limit: '10' })
    expect(result.offset).toBe(50)
  })

  it('ignores empty cursor gracefully', () => {
    const result = parsePaginationParams({ cursor: '' })
    expect(result.cursor).toBeNull()
    expect(result.decodedCursor).toBeUndefined()
  })

  it('ignores whitespace-only cursor', () => {
    const result = parsePaginationParams({ cursor: '   ' })
    expect(result.cursor).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. buildPaginationMeta — boundary cases
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPaginationMeta — boundary cases', () => {
  it('total=0 means no next page', () => {
    const meta = buildPaginationMeta(0, 1, 10)
    expect(meta).toEqual({ page: 1, limit: 10, total: 0, hasNext: false })
  })

  it('total=1 with limit=1 and page=1: no next', () => {
    expect(buildPaginationMeta(1, 1, 1).hasNext).toBe(false)
  })

  it('total=2 with limit=1 and page=1: has next', () => {
    expect(buildPaginationMeta(2, 1, 1).hasNext).toBe(true)
  })

  it('total=2 with limit=1 and page=2: no next', () => {
    expect(buildPaginationMeta(2, 2, 1).hasNext).toBe(false)
  })

  it('total equals page*limit exactly: no next', () => {
    expect(buildPaginationMeta(100, 10, 10).hasNext).toBe(false)
  })

  it('total is one more than page*limit: has next', () => {
    expect(buildPaginationMeta(101, 10, 10).hasNext).toBe(true)
  })

  it('page beyond total items: no next', () => {
    expect(buildPaginationMeta(5, 100, 10).hasNext).toBe(false)
  })

  it('preserves exact values in output', () => {
    const meta = buildPaginationMeta(42, 3, 15)
    expect(meta.page).toBe(3)
    expect(meta.limit).toBe(15)
    expect(meta.total).toBe(42)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. buildCursorPaginationMeta — boundary cases
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCursorPaginationMeta — boundary cases', () => {
  it('returns hasNextPage=false with no cursor', () => {
    const meta = buildCursorPaginationMeta(false, 20)
    expect(meta).toEqual({ limit: 20, hasNextPage: false, nextCursor: undefined })
  })

  it('returns hasNextPage=true with next cursor', () => {
    const meta = buildCursorPaginationMeta(true, 10, 'cursor-abc')
    expect(meta).toEqual({ limit: 10, hasNextPage: true, nextCursor: 'cursor-abc' })
  })

  it('returns hasNextPage=false even when nextCursor is provided', () => {
    // This is caller responsibility — the function just stores what you give it
    const meta = buildCursorPaginationMeta(false, 5, 'some-cursor')
    expect(meta.hasNextPage).toBe(false)
    expect(meta.nextCursor).toBe('some-cursor')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. buildCursorEnvelope — boundary and determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCursorEnvelope — boundary and determinism', () => {
  it('wraps empty data array', () => {
    const env = buildCursorEnvelope([], { limit: 10, hasMore: false })
    expect(env).toEqual({
      data: [],
      page: { nextCursor: null, hasMore: false, limit: 10 },
    })
  })

  it('wraps data with next cursor', () => {
    const env = buildCursorEnvelope([1, 2, 3], {
      limit: 3,
      hasMore: true,
      nextCursor: 'abc',
    })
    expect(env).toEqual({
      data: [1, 2, 3],
      page: { nextCursor: 'abc', hasMore: true, limit: 3 },
    })
  })

  it('defaults nextCursor to null when not provided', () => {
    const env = buildCursorEnvelope(['a'], { limit: 1, hasMore: false })
    expect(env.page.nextCursor).toBeNull()
  })

  it('preserves null nextCursor explicitly', () => {
    const env = buildCursorEnvelope([], { limit: 5, hasMore: false, nextCursor: null })
    expect(env.page.nextCursor).toBeNull()
  })

  it('is deterministic: same input → same output', () => {
    const a = buildCursorEnvelope([1], { limit: 1, hasMore: false, nextCursor: 'x' })
    const b = buildCursorEnvelope([1], { limit: 1, hasMore: false, nextCursor: 'x' })
    expect(a).toEqual(b)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. buildLinkHeader — boundary cases
// ─────────────────────────────────────────────────────────────────────────────

describe('buildLinkHeader — boundary cases', () => {
  it('returns null when total is 0', () => {
    expect(buildLinkHeader({ baseUrl: '/items', page: 1, limit: 10, total: 0 })).toBeNull()
  })

  it('returns null when total is negative', () => {
    expect(buildLinkHeader({ baseUrl: '/items', page: 1, limit: 10, total: -5 })).toBeNull()
  })

  it('single item, single page: first and last, no prev or next', () => {
    const header = buildLinkHeader({ baseUrl: '/items', page: 1, limit: 10, total: 1 })
    expect(header).not.toBeNull()
    expect(header).toContain('rel="first"')
    expect(header).toContain('rel="last"')
    expect(header).not.toContain('rel="prev"')
    expect(header).not.toContain('rel="next"')
  })

  it('first page of multi-page: no prev, has next', () => {
    const header = buildLinkHeader({ baseUrl: '/items', page: 1, limit: 10, total: 25 })!
    expect(header).toContain('rel="first"')
    expect(header).toContain('rel="next"')
    expect(header).toContain('rel="last"')
    expect(header).not.toContain('rel="prev"')
  })

  it('last page of multi-page: has prev, no next', () => {
    const header = buildLinkHeader({ baseUrl: '/items', page: 3, limit: 10, total: 25 })!
    expect(header).toContain('rel="first"')
    expect(header).toContain('rel="prev"')
    expect(header).toContain('rel="last"')
    expect(header).not.toContain('rel="next"')
  })

  it('middle page: has both prev and next', () => {
    const header = buildLinkHeader({ baseUrl: '/items', page: 2, limit: 10, total: 30 })!
    expect(header).toContain('rel="first"')
    expect(header).toContain('rel="prev"')
    expect(header).toContain('rel="next"')
    expect(header).toContain('rel="last"')
  })

  it('total exactly equals limit (one page)', () => {
    const header = buildLinkHeader({ baseUrl: '/items', page: 1, limit: 10, total: 10 })!
    expect(header).not.toContain('rel="prev"')
    expect(header).not.toContain('rel="next"')
    expect(header).toContain('rel="first"')
    expect(header).toContain('rel="last"')
  })

  it('total = limit + 1 (just barely two pages)', () => {
    const header = buildLinkHeader({ baseUrl: '/items', page: 1, limit: 10, total: 11 })!
    expect(header).toContain('rel="next"')
    expect(header).toContain('page=2')
  })

  it('limit = 1, total = 1 (exact single item)', () => {
    const header = buildLinkHeader({ baseUrl: '/items', page: 1, limit: 1, total: 1 })!
    expect(header).not.toContain('rel="next"')
    expect(header).not.toContain('rel="prev"')
  })

  it('limit = 1, total = 2 (two pages of one item each)', () => {
    const header = buildLinkHeader({ baseUrl: '/items', page: 1, limit: 1, total: 2 })!
    expect(header).toContain('rel="next"')
    expect(header).toContain('page=2')
    expect(header).toContain('rel="last"')
  })

  it('preserves baseUrl path exactly', () => {
    const header = buildLinkHeader({
      baseUrl: '/api/v2/organizations/123/items',
      page: 1,
      limit: 10,
      total: 20,
    })!
    expect(header).toContain('/api/v2/organizations/123/items?')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. buildPaginationLinks — boundary cases
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPaginationLinks — boundary cases', () => {
  const baseUrl = 'https://api.example.com/items'

  it('returns only self when total is 0', () => {
    const links = buildPaginationLinks(`${baseUrl}?page=1&limit=20`, 1, 20, 0)
    expect(links.self).toBeDefined()
    expect(links.first).toBeUndefined()
    expect(links.prev).toBeUndefined()
    expect(links.next).toBeUndefined()
    expect(links.last).toBeUndefined()
  })

  it('returns only self for negative total', () => {
    const links = buildPaginationLinks(`${baseUrl}?page=1&limit=20`, 1, 20, -10)
    expect(links.first).toBeUndefined()
    expect(links.next).toBeUndefined()
    expect(links.last).toBeUndefined()
  })

  it('single page result (total <= limit): self only', () => {
    const links = buildPaginationLinks(`${baseUrl}?page=1&limit=20`, 1, 20, 15)
    expect(links.self).toBeDefined()
    expect(links.first).toBeUndefined()
    expect(links.next).toBeUndefined()
  })

  it('total equals limit exactly: single page, no nav links', () => {
    const links = buildPaginationLinks(`${baseUrl}?page=1&limit=10`, 1, 10, 10)
    expect(links.next).toBeUndefined()
    expect(links.prev).toBeUndefined()
  })

  it('total = limit + 1: two pages, page 1 has next', () => {
    const links = buildPaginationLinks(`${baseUrl}?page=1&limit=10`, 1, 10, 11)
    expect(links.next).toBeDefined()
    expect(links.next).toContain('page=2')
  })

  it('strips offset param from self link', () => {
    const links = buildPaginationLinks(`${baseUrl}?offset=10&limit=10`, 2, 10, 30)
    expect(links.self).not.toContain('offset')
    expect(links.self).toContain('page=2')
  })

  it('preserves non-pagination query params', () => {
    const links = buildPaginationLinks(
      `${baseUrl}?status=active&sort=name&page=1&limit=10`,
      1,
      10,
      50,
    )
    expect(links.self).toContain('status=active')
    expect(links.self).toContain('sort=name')
    if (links.next) {
      expect(links.next).toContain('status=active')
      expect(links.next).toContain('sort=name')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. buildCursorPaginationLinks — boundary cases
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCursorPaginationLinks — boundary cases', () => {
  const baseUrl = 'https://api.example.com/items'

  it('no next cursor → self only', () => {
    const links = buildCursorPaginationLinks(`${baseUrl}?limit=20`, 20, null)
    expect(links.self).toBeDefined()
    expect(links.next).toBeUndefined()
  })

  it('undefined next cursor → self only', () => {
    const links = buildCursorPaginationLinks(`${baseUrl}?limit=20`, 20, undefined)
    expect(links.next).toBeUndefined()
  })

  it('empty string next cursor → self only (falsy)', () => {
    const links = buildCursorPaginationLinks(`${baseUrl}?limit=20`, 20, '')
    expect(links.next).toBeUndefined()
  })

  it('valid next cursor → self and next', () => {
    const links = buildCursorPaginationLinks(`${baseUrl}?limit=20`, 20, 'cursor-abc')
    expect(links.self).toBeDefined()
    expect(links.next).toBeDefined()
    expect(links.next).toContain('cursor=cursor-abc')
  })

  it('strips existing cursor from self link', () => {
    const links = buildCursorPaginationLinks(
      `${baseUrl}?cursor=old-cursor&limit=20`,
      20,
      'new-cursor',
    )
    expect(links.self).not.toContain('cursor')
    expect(links.next).toContain('cursor=new-cursor')
  })

  it('preserves other query params in self', () => {
    const links = buildCursorPaginationLinks(
      `${baseUrl}?filter=active&limit=10`,
      10,
      'next-c',
    )
    expect(links.self).toContain('filter=active')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 12. Recovery / Determinism — concurrent and duplicate calls
// ─────────────────────────────────────────────────────────────────────────────

describe('recovery and determinism', () => {
  it('parsePaginationParams is idempotent for same input', () => {
    const input = { page: '5', limit: '25', offset: '100' }
    const a = parsePaginationParams(input)
    const b = parsePaginationParams(input)
    expect(a).toEqual(b)
  })

  it('concurrent calls to parsePaginationParams yield consistent results', () => {
    const inputs = Array.from({ length: 100 }, () => ({
      page: '3',
      limit: '10',
    }))
    const results = inputs.map(q => parsePaginationParams(q))
    for (const r of results) {
      expect(r.page).toBe(3)
      expect(r.limit).toBe(10)
      expect(r.offset).toBe(20)
    }
  })

  it('buildPaginationMeta is idempotent', () => {
    const a = buildPaginationMeta(100, 5, 10)
    const b = buildPaginationMeta(100, 5, 10)
    expect(a).toEqual(b)
  })

  it('encodeCursor is deterministic across calls', () => {
    const results = Array.from({ length: 50 }, () =>
      encodeCursor('2024-01-01T00:00:00Z', 'id-1'),
    )
    const first = results[0]
    for (const r of results) {
      expect(r).toBe(first)
    }
  })

  it('decodeCursor is deterministic for the same valid input', () => {
    const encoded = encodeCursor('2024-01-01T00:00:00Z', 'id-1')
    const results = Array.from({ length: 50 }, () => decodeCursor(encoded))
    for (const r of results) {
      expect(r).toEqual({ t: '2024-01-01T00:00:00Z', i: 'id-1' })
    }
  })

  it('decodeCursor consistently returns null for invalid input', () => {
    const results = Array.from({ length: 50 }, () => decodeCursor('garbage'))
    for (const r of results) {
      expect(r).toBeNull()
    }
  })

  it('buildLinkHeader is deterministic', () => {
    const opts = { baseUrl: '/items', page: 2, limit: 10, total: 50 }
    const a = buildLinkHeader(opts)
    const b = buildLinkHeader(opts)
    expect(a).toBe(b)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 13. Offset/page derivation — boundary arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe('offset/page derivation — boundary arithmetic', () => {
  it('offset=0 with limit=1 → page=1', () => {
    const r = parsePaginationParams({ offset: '0', limit: '1' })
    expect(r.page).toBe(1)
    expect(r.offset).toBe(0)
  })

  it('offset=1 with limit=1 → page=2', () => {
    const r = parsePaginationParams({ offset: '1', limit: '1' })
    expect(r.page).toBe(2)
    expect(r.offset).toBe(1)
  })

  it('offset=9 with limit=10 → page=1 (within first page)', () => {
    const r = parsePaginationParams({ offset: '9', limit: '10' })
    expect(r.page).toBe(1)
  })

  it('offset=10 with limit=10 → page=2 (start of second page)', () => {
    const r = parsePaginationParams({ offset: '10', limit: '10' })
    expect(r.page).toBe(2)
  })

  it('offset=19 with limit=10 → page=2 (end of second page)', () => {
    const r = parsePaginationParams({ offset: '19', limit: '10' })
    expect(r.page).toBe(2)
  })

  it('page=1 with limit=10 → offset=0', () => {
    const r = parsePaginationParams({ page: '1', limit: '10' })
    expect(r.offset).toBe(0)
  })

  it('page=2 with limit=10 → offset=10', () => {
    const r = parsePaginationParams({ page: '2', limit: '10' })
    expect(r.offset).toBe(10)
  })

  it('page takes precedence in offset calculation when both page and offset are given', () => {
    // When both page and explicit offset are provided, offset is the explicit value
    const r = parsePaginationParams({ page: '3', limit: '10', offset: '5' })
    expect(r.page).toBe(3)
    expect(r.offset).toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 14. Exported constants — sanity checks
// ─────────────────────────────────────────────────────────────────────────────

describe('exported constants — sanity checks', () => {
  it('DEFAULT_PAGE is 1', () => {
    expect(DEFAULT_PAGE).toBe(1)
  })

  it('DEFAULT_LIMIT is 20', () => {
    expect(DEFAULT_LIMIT).toBe(20)
  })

  it('MAX_LIMIT is 100', () => {
    expect(MAX_LIMIT).toBe(100)
  })

  it('MAX_LIMIT >= DEFAULT_LIMIT', () => {
    expect(MAX_LIMIT).toBeGreaterThanOrEqual(DEFAULT_LIMIT)
  })

  it('DEFAULT_PAGE >= 1', () => {
    expect(DEFAULT_PAGE).toBeGreaterThanOrEqual(1)
  })

  it('DEFAULT_LIMIT >= 1', () => {
    expect(DEFAULT_LIMIT).toBeGreaterThanOrEqual(1)
  })
})
