import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long'

import {
  buildPaginationLinks,
  buildCursorPaginationLinks,
  buildPaginationMeta,
  decodeCursor,
  encodeCursor,
  MAX_LIMIT,
  PaginationValidationError,
  parsePaginationParams,
} from './pagination.js'


describe('pagination helpers', () => {
  describe('parsePaginationParams', () => {
    it('returns default page, limit, and offset when the query is empty', () => {
      expect(parsePaginationParams({})).toMatchObject({ page: 1, limit: 20, offset: 0 })
    })

    it('parses explicit page and limit values', () => {
      expect(parsePaginationParams({ page: '3', limit: '10' })).toMatchObject({
        page: 3,
        limit: 10,
        offset: 20,
      })
    })

    it('derives page from offset for backward-compatible callers', () => {
      expect(parsePaginationParams({ limit: '10', offset: '20' })).toMatchObject({
        page: 3,
        limit: 10,
        offset: 20,
      })
    })

    it('supports cursor as an offset alias', () => {
      expect(parsePaginationParams({ limit: '5', cursor: '10' })).toMatchObject({
        page: 3,
        limit: 5,
        offset: 10,
      })
    })

    it('uses a custom default limit when provided', () => {
      expect(parsePaginationParams({}, { defaultLimit: 50 })).toMatchObject({
        page: 1,
        limit: 50,
        offset: 0,
      })
    })

    it('throws for values above the hard max limit', () => {
      expect(() => parsePaginationParams({ limit: '101' })).toThrow(PaginationValidationError)
    })

    it('throws for non-integer values', () => {
      expect(() => parsePaginationParams({ page: '1.5' })).toThrow(PaginationValidationError)
    })

    it('throws for negative values', () => {
      expect(() => parsePaginationParams({ offset: '-1' })).toThrow(PaginationValidationError)
    })
  })

  describe('buildPaginationMeta', () => {
    it('returns hasNext=false when the page exhausts the collection', () => {
      expect(buildPaginationMeta(20, 2, 10)).toEqual({
        page: 2,
        limit: 10,
        total: 20,
        hasNext: false,
      })
    })

    it('returns hasNext=true when more results remain', () => {
      expect(buildPaginationMeta(21, 2, 10)).toEqual({
        page: 2,
        limit: 10,
        total: 21,
        hasNext: true,
      })
    })
  })

  describe('buildPaginationLinks', () => {
    it('returns only self when total is zero', () => {
      const links = buildPaginationLinks('https://api.example.com/items?page=1&limit=20', 1, 20, 0)
      expect(links.self).toBe('https://api.example.com/items?page=1&limit=20')
      expect(links.first).toBeUndefined()
      expect(links.prev).toBeUndefined()
      expect(links.next).toBeUndefined()
      expect(links.last).toBeUndefined()
    })

    it('returns only self on a single-page result', () => {
      const links = buildPaginationLinks('https://api.example.com/items?page=1&limit=20', 1, 20, 5)
      expect(links.self).toContain('page=1')
      expect(links.first).toBeUndefined()
      expect(links.prev).toBeUndefined()
      expect(links.next).toBeUndefined()
      expect(links.last).toBeUndefined()
    })

    it('includes first, next, last on first page with multiple pages', () => {
      const links = buildPaginationLinks('https://api.example.com/items?page=1&limit=10', 1, 10, 25)
      expect(links.self).toContain('page=1')
      expect(links.first).toContain('page=1')
      expect(links.prev).toBeUndefined()
      expect(links.next).toContain('page=2')
      expect(links.last).toContain('page=3')
    })

    it('includes first, prev, next, last on a middle page', () => {
      const links = buildPaginationLinks('https://api.example.com/items?page=2&limit=10', 2, 10, 50)
      expect(links.self).toContain('page=2')
      expect(links.first).toContain('page=1')
      expect(links.prev).toContain('page=1')
      expect(links.next).toContain('page=3')
      expect(links.last).toContain('page=5')
    })

    it('includes first, prev, last on last page', () => {
      const links = buildPaginationLinks('https://api.example.com/items?page=5&limit=10', 5, 10, 50)
      expect(links.self).toContain('page=5')
      expect(links.first).toContain('page=1')
      expect(links.prev).toContain('page=4')
      expect(links.next).toBeUndefined()
      expect(links.last).toContain('page=5')
    })

    it('preserves existing query params in the URL', () => {
      const links = buildPaginationLinks('https://api.example.com/items?status=active&page=1&limit=10', 1, 10, 30)
      expect(links.self).toContain('status=active')
      expect(links.next).toContain('status=active')
      expect(links.next).toContain('page=2')
    })

    it('strips offset param and uses page instead', () => {
      const links = buildPaginationLinks('https://api.example.com/items?offset=10&limit=10', 2, 10, 30)
      expect(links.self).toContain('page=2')
      expect(links.self).not.toContain('offset')
      expect(links.next).toContain('page=3')
      expect(links.next).not.toContain('offset')
    })
  })

  describe('buildCursorPaginationLinks', () => {
    it('returns only self when there is no next cursor', () => {
      const links = buildCursorPaginationLinks('https://api.example.com/items?limit=20', 20, null)
      expect(links.self).toBe('https://api.example.com/items?limit=20')
      expect(links.next).toBeUndefined()
    })

    it('returns self and next when a next cursor is provided', () => {
      const links = buildCursorPaginationLinks('https://api.example.com/items?limit=20', 20, 'cursor123')
      expect(links.self).toContain('limit=20')
      expect(links.self).not.toContain('cursor')
      expect(links.next).toContain('cursor=cursor123')
    })

    it('strips cursor from self link', () => {
      const links = buildCursorPaginationLinks('https://api.example.com/items?cursor=old&limit=20', 20, 'newCursor')
      expect(links.self).not.toContain('cursor')
      expect(links.next).toContain('cursor=newCursor')
    })
  })

  describe('Property-based tests', () => {
    it('offset always equals (page - 1) * limit for valid inputs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: MAX_LIMIT }),
          (page, limit) => {
            const result = parsePaginationParams({ page: String(page), limit: String(limit) })
            expect(result.offset).toBe((result.page - 1) * result.limit)
          },
        ),
      )
    })

    it('limit is always clamped to [1, MAX_LIMIT]', () => {
      fc.assert(
        fc.property(fc.integer(), (limit) => {
          try {
            const result = parsePaginationParams({ limit: String(limit) })
            expect(result.limit).toBeGreaterThanOrEqual(1)
            expect(result.limit).toBeLessThanOrEqual(MAX_LIMIT)
          } catch (error) {
            if (error instanceof PaginationValidationError) {
              expect(error.details.some((d) => d.path === 'limit')).toBe(true)
            } else {
              throw error
            }
          }
        }),
      )
    })

    it('valid encoded cursors round-trip correctly', () => {
      fc.assert(
        fc.property(fc.uuid(), fc.uuid(), (timestamp, id) => {
          const encoded = encodeCursor(timestamp, id)
          const decoded = decodeCursor(encoded)
          expect(decoded).toEqual({ t: timestamp, i: id })
        }),
      )
    })

    it('prefers explicit cursor encoding over legacy offset fallback', () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          fc.uuid(),
          fc.integer({ min: 0, max: 1000 }),
          fc.integer({ min: 1, max: MAX_LIMIT }),
          (timestamp, id, offset, limit) => {
            const encoded = encodeCursor(timestamp, id)
            const result = parsePaginationParams({
              cursor: encoded,
              offset: String(offset),
              limit: String(limit),
            })
            expect(result.offset).not.toBe(offset)
            expect(result.page).toBe(Math.floor(result.offset / limit) + 1)
          },
        ),
      )
    })

    it('numeric cursor with no offset is treated as legacy offset', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 1000 }),
          fc.integer({ min: 1, max: MAX_LIMIT }),
          (offset, limit) => {
            const result = parsePaginationParams({
              cursor: String(offset),
              limit: String(limit),
            })
            expect(result.offset).toBe(offset)
            expect(result.page).toBe(Math.floor(offset / limit) + 1)
          },
        ),
      )
    })

    it('non-numeric, non-decodable cursor yields Invalid cursor format error', () => {
      fc.assert(
        fc.property(
          fc
            .string({ minLength: 1, maxLength: 100 })
            .filter((s) => !/^\d+$/.test(s))
            .filter(
              (s) =>
                !try_decode_base64url(s),
            ),
          fc.integer({ min: 1, max: MAX_LIMIT }),
          (cursor, limit) => {
            expect(() => parsePaginationParams({ cursor, limit: String(limit) })).toThrow(
              PaginationValidationError,
            )
          },
        ),
      )
    })

    it('corrupted cursor decodes to null', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }).filter((s) => !is_valid_base64url(s)), (cursor) => {
          const decoded = decodeCursor(cursor)
          expect(decoded).toBeNull()
        }),
      )
    })

    it('accumulates multiple validation errors', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.integer({ min: -100, max: 0 }),
            fc.integer({ min: MAX_LIMIT + 1, max: MAX_LIMIT + 1000 }),
          ),
          ([page, limit]) => {
            expect(() => parsePaginationParams({ page: String(page), limit: String(limit) })).toThrow(
              (error: unknown) => {
                if (error instanceof PaginationValidationError) {
                  expect(error.details.length).toBeGreaterThanOrEqual(2)
                  return true
                }
                return false
              },
            )
          },
        ),
      )
    })

    it('handles empty string and undefined gracefully', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: MAX_LIMIT }), (limit) => {
          const result1 = parsePaginationParams({ page: '', limit: String(limit) })
          expect(result1.page).toBe(1)

          const result2 = parsePaginationParams({ page: undefined, limit: String(limit) })
          expect(result2.page).toBe(1)

          const result3 = parsePaginationParams({ limit: String(limit), offset: '' })
          expect(result3.offset).toBe(0)
        }),
      )
    })

    it('maintains invariant: offset < page * limit and offset >= (page - 1) * limit', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: MAX_LIMIT }),
          fc.integer({ min: 0, max: 10000 }),
          (page, limit, offset) => {
            try {
              const result = parsePaginationParams({
                page: String(page),
                limit: String(limit),
                offset: String(offset),
              })
              const lowerBound = (result.page - 1) * result.limit
              const upperBound = result.page * result.limit
              expect(result.offset).toBeGreaterThanOrEqual(lowerBound)
              expect(result.offset).toBeLessThan(upperBound)
            } catch (error) {
              if (!(error instanceof PaginationValidationError)) {
                throw error
              }
            }
          },
        ),
      )
    })
  })

  describe('buildLinkHeader', () => {
    const baseUrl = '/api/items'

    it('returns_null_when_total_is_zero', () => {
      const header = buildLinkHeader({ baseUrl, page: 1, limit: 10, total: 0 })
      expect(header).toBeNull()
    })

    it('first_page_has_no_prev_link', () => {
      const header = buildLinkHeader({ baseUrl, page: 1, limit: 10, total: 50 })
      expect(header).not.toBeNull()
      expect(header).not.toContain('rel="prev"')
      expect(header).toContain('rel="first"')
      expect(header).toContain('rel="next"')
      expect(header).toContain('rel="last"')
      expect(header).toBe(
        '</api/items?page=1&limit=10>; rel="first", </api/items?page=2&limit=10>; rel="next", </api/items?page=5&limit=10>; rel="last"',
      )
    })

    it('last_page_has_no_next_link', () => {
      const header = buildLinkHeader({ baseUrl, page: 5, limit: 10, total: 50 })
      expect(header).not.toBeNull()
      expect(header).not.toContain('rel="next"')
      expect(header).toContain('rel="first"')
      expect(header).toContain('rel="prev"')
      expect(header).toContain('rel="last"')
      expect(header).toBe(
        '</api/items?page=1&limit=10>; rel="first", </api/items?page=4&limit=10>; rel="prev", </api/items?page=5&limit=10>; rel="last"',
      )
    })

    it('middle_page_has_both_prev_and_next_links', () => {
      const header = buildLinkHeader({ baseUrl, page: 3, limit: 10, total: 50 })
      expect(header).toBe(
        '</api/items?page=1&limit=10>; rel="first", </api/items?page=2&limit=10>; rel="prev", </api/items?page=4&limit=10>; rel="next", </api/items?page=5&limit=10>; rel="last"',
      )
    })

    it('single_page_has_neither_prev_nor_next_link', () => {
      const header = buildLinkHeader({ baseUrl, page: 1, limit: 10, total: 5 })
      expect(header).not.toContain('rel="prev"')
      expect(header).not.toContain('rel="next"')
      expect(header).toContain('rel="first"')
      expect(header).toContain('rel="last"')
      expect(header).toBe(
        '</api/items?page=1&limit=10>; rel="first", </api/items?page=1&limit=10>; rel="last"',
      )
    })
  })
})


function try_decode_base64url(s: string): boolean {
  try {
    Buffer.from(s, 'base64url')
    return true
  } catch {
    return false
  }
}

function is_valid_base64url(s: string): boolean {
  return /^[A-Za-z0-9_-]*$/.test(s)
}
