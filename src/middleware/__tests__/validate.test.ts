import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { validate, formatZodErrors } from '../validate.js'
import { ValidationError, ErrorCode } from '../../lib/errors.js'
import type { Request, Response } from 'express'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function makeReq(overrides: Partial<{ params: any; query: any; body: any }> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request
}

function makeRes(): Response {
  return {} as Response
}

// ─────────────────────────────────────────────────────────────────────────────
// validate() middleware
// ─────────────────────────────────────────────────────────────────────────────
describe('validate middleware', () => {
  // ── Happy paths ────────────────────────────────────────────────────────────
  it('passes valid request and assigns/coerces all three sources', () => {
    const paramsSchema = z.object({ id: z.coerce.number() })
    const querySchema  = z.object({ search: z.string().optional(), page: z.coerce.number().default(1) })
    const bodySchema   = z.object({ name: z.string(), active: z.boolean() }).strip()

    const middleware = validate({ params: paramsSchema, query: querySchema, body: bodySchema })
    const req = makeReq({
      params: { id: '42' },
      query:  { search: 'hello' },
      body:   { name: 'Alice', active: true, extra: 'stripped' },
    })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()             // no error arg
    expect(req.validated).toEqual({
      params: { id: 42 },
      query:  { search: 'hello', page: 1 },
      body:   { name: 'Alice', active: true },
    })
    // Coerced values are written back onto the request object
    expect(req.params).toEqual({ id: 42 })
    expect(req.query).toEqual({ search: 'hello', page: 1 })
    expect(req.body).toEqual({ name: 'Alice', active: true })
  })

  it('skips validation when no schemas are provided and still calls next()', () => {
    const middleware = validate({})
    const req = makeReq({ body: { anything: true } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.validated).toEqual({})
  })

  it('validates only body when only body schema is provided', () => {
    const bodySchema = z.object({ value: z.number() })
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: { value: 5 } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.validated?.body).toEqual({ value: 5 })
    expect(req.validated?.params).toBeUndefined()
    expect(req.validated?.query).toBeUndefined()
  })

  it('validates only params when only params schema is provided', () => {
    const paramsSchema = z.object({ slug: z.string().min(1) })
    const middleware = validate({ params: paramsSchema })
    const req = makeReq({ params: { slug: 'hello-world' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.validated?.params).toEqual({ slug: 'hello-world' })
  })

  it('validates only query when only query schema is provided', () => {
    const querySchema = z.object({ q: z.string() })
    const middleware = validate({ query: querySchema })
    const req = makeReq({ query: { q: 'search-term' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.validated?.query).toEqual({ q: 'search-term' })
  })

  // ── Validation failures ────────────────────────────────────────────────────
  it('fails validation and calls next with ValidationError (invalid_type + value_too_small)', () => {
    const bodySchema = z.object({
      name: z.string(),
      age:  z.number().min(18).max(100),
    })
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: { name: 123, age: 10 } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    expect(next).toHaveBeenCalledTimes(1)
    const err = next.mock.calls[0][0]
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.code).toBe(ErrorCode.VALIDATION_FAILED)
    expect(err.details).toEqual([
      { path: 'name', message: 'Invalid input: expected string, received number', code: ErrorCode.INVALID_TYPE },
      { path: 'age',  message: 'Too small: expected number to be >=18',           code: ErrorCode.VALUE_TOO_SMALL },
    ])
  })

  it('accumulates errors from params AND body when both fail', () => {
    const paramsSchema = z.object({ id: z.string().min(1) })
    const bodySchema   = z.object({ value: z.number() })
    const middleware   = validate({ params: paramsSchema, body: bodySchema })
    const req = makeReq({ params: { id: '' }, body: { value: 'bad' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    const err = next.mock.calls[0][0]
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.details.length).toBe(2)               // one from params, one from body
  })

  it('reports field_required for missing required fields', () => {
    const bodySchema = z.object({ email: z.string() })
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: {} })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    const err = next.mock.calls[0][0]
    expect(err.details[0].code).toBe(ErrorCode.FIELD_REQUIRED)
    expect(err.details[0].path).toBe('email')
  })

  it('reports unexpected_field for strict schemas with extra keys', () => {
    const bodySchema = z.object({ name: z.string() }).strict()
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: { name: 'Alice', extra: 'bad' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    const err = next.mock.calls[0][0]
    expect(err.details[0].code).toBe(ErrorCode.UNEXPECTED_FIELD)
  })

  it('reports value_too_large for numbers above max', () => {
    const bodySchema = z.object({ num: z.number().max(5) })
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: { num: 10 } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    const err = next.mock.calls[0][0]
    expect(err.details[0].code).toBe(ErrorCode.VALUE_TOO_LARGE)
  })

  it('reports invalid_format for email validation failure', () => {
    const bodySchema = z.object({ email: z.string().email() })
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: { email: 'not-an-email' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    const err = next.mock.calls[0][0]
    expect(err.details[0].code).toBe(ErrorCode.INVALID_FORMAT)
  })

  it('reports invalid_address for path containing "address" with format error', () => {
    const bodySchema = z.object({ userAddress: z.string().uuid() })
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: { userAddress: 'not-a-uuid' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    const err = next.mock.calls[0][0]
    expect(err.details[0].code).toBe(ErrorCode.INVALID_ADDRESS)
  })

  it('reports invalid_type for enum validation failure', () => {
    const bodySchema = z.object({ role: z.enum(['admin', 'user']) })
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: { role: 'guest' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    const err = next.mock.calls[0][0]
    expect(err.details[0].code).toBe(ErrorCode.INVALID_TYPE)
  })

  // ── Edge cases ─────────────────────────────────────────────────────────────
  it('rewrites req.query with coerced values on successful query validation', () => {
    const querySchema = z.object({ limit: z.coerce.number().default(10) })
    const middleware = validate({ query: querySchema })
    const req = makeReq({ query: { limit: '25' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.query).toEqual({ limit: 25 })
    expect(req.validated?.query).toEqual({ limit: 25 })
  })

  it('coerces query string numbers correctly before handler', () => {
    const querySchema = z.object({ page: z.coerce.number().int().min(1) })
    const middleware  = validate({ query: querySchema })
    const req = makeReq({ query: { page: '3' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.validated?.query?.page).toBe(3)
    expect(typeof req.validated?.query?.page).toBe('number')
  })

  it('strips unknown fields from body by default (strip mode)', () => {
    const bodySchema = z.object({ name: z.string() }) // strip mode (default)
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: { name: 'Alice', secret: 'injected' } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.body).toEqual({ name: 'Alice' })
    expect((req.body as any).secret).toBeUndefined()
  })

  it('handles nested object validation errors with dotted path', () => {
    const bodySchema = z.object({
      user: z.object({ name: z.string() }),
    })
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: { user: { name: 123 } } })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    const err = next.mock.calls[0][0]
    expect(err.details[0].path).toBe('user.name')
    expect(err.details[0].code).toBe(ErrorCode.INVALID_TYPE)
  })

  it('reports path as (root) when error is at root level', () => {
    const bodySchema = z.string()
    const middleware = validate({ body: bodySchema })
    const req = makeReq({ body: 42 })
    const next = vi.fn()

    middleware(req, makeRes(), next)

    const err = next.mock.calls[0][0]
    expect(err.details[0].path).toBe('(root)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// formatZodErrors() standalone
// ─────────────────────────────────────────────────────────────────────────────
describe('formatZodErrors', () => {
  it('maps INVALID_STELLAR_ADDRESS refinement message', () => {
    const schema = z.string().refine(() => false, { message: 'INVALID_STELLAR_ADDRESS' })
    const result = schema.safeParse('GABC')
    expect(result.success).toBe(false)
    if (!result.success) {
      const formatted = formatZodErrors(result.error)
      expect(formatted[0].code).toBe(ErrorCode.INVALID_STELLAR_ADDRESS)
    }
  })

  it('maps custom error containing "address" to invalid_address', () => {
    const schema = z.string().refine(() => false, { message: 'invalid address format' })
    const result = schema.safeParse('bad')
    expect(result.success).toBe(false)
    if (!result.success) {
      const formatted = formatZodErrors(result.error)
      expect(formatted[0].code).toBe(ErrorCode.INVALID_ADDRESS)
    }
  })

  it('maps custom refinement message containing both "stellar" and "address" to invalid_stellar_address', () => {
    const schema = z.string().refine(() => false, { message: 'invalid stellar address provided' })
    const result = schema.safeParse('GABC')
    expect(result.success).toBe(false)
    if (!result.success) {
      const formatted = formatZodErrors(result.error)
      expect(formatted[0].code).toBe(ErrorCode.INVALID_STELLAR_ADDRESS)
    }
  })

  it('maps generic custom refinement to validation_failed', () => {
    const schema = z.string().refine(() => false, { message: 'generic problem' })
    const result = schema.safeParse('x')
    expect(result.success).toBe(false)
    if (!result.success) {
      const formatted = formatZodErrors(result.error)
      expect(formatted[0].code).toBe(ErrorCode.VALIDATION_FAILED)
    }
  })

  it('maps value_too_small for string min length', () => {
    const schema = z.string().min(5)
    const result = schema.safeParse('ab')
    expect(result.success).toBe(false)
    if (!result.success) {
      const formatted = formatZodErrors(result.error)
      expect(formatted[0].code).toBe(ErrorCode.VALUE_TOO_SMALL)
    }
  })

  it('maps value_too_large for string max length', () => {
    const schema = z.string().max(3)
    const result = schema.safeParse('toolong')
    expect(result.success).toBe(false)
    if (!result.success) {
      const formatted = formatZodErrors(result.error)
      expect(formatted[0].code).toBe(ErrorCode.VALUE_TOO_LARGE)
    }
  })
})
