import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { validate } from './validate.js'

describe('validate middleware', () => {
  const mockNext = vi.fn<NextFunction>()
  const mockStatus = vi.fn()
  const mockJson = vi.fn()
  const res = {
    status: mockStatus,
    json: mockJson,
  } as unknown as Response

  beforeEach(() => {
    vi.clearAllMocks()
    mockStatus.mockReturnValue(res)
    mockJson.mockReturnValue(res)
  })

  it('calls next() when params validation passes', () => {
    const schema = z.object({ id: z.string().min(1) })
    const middleware = validate({ params: schema })
    const req = { params: { id: 'abc' }, query: {}, body: {} } as Request
    middleware(req, res, mockNext)
    expect(mockNext).toHaveBeenCalledOnce()
    expect(mockStatus).not.toHaveBeenCalled()
    expect(req.validated?.params).toEqual({ id: 'abc' })
  })

  it('returns 400 with details when params validation fails', () => {
    const schema = z.object({ id: z.string().min(1) })
    const middleware = validate({ params: schema })
    const req = { params: { id: '' }, query: {}, body: {} } as Request
    middleware(req, res, mockNext)
    expect(mockNext).not.toHaveBeenCalled()
    expect(mockStatus).toHaveBeenCalledWith(400)
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.objectContaining({ path: expect.any(String), message: expect.any(String) }),
        ]),
      }),
    )
  })

  it('validates query and attaches to req.validated.query', () => {
    const schema = z.object({ limit: z.coerce.number().min(1) })
    const middleware = validate({ query: schema })
    const req = { params: {}, query: { limit: '10' }, body: {} } as Request
    middleware(req, res, mockNext)
    expect(mockNext).toHaveBeenCalledOnce()
    expect(req.validated?.query).toEqual({ limit: 10 })
  })

  it('returns 400 when query validation fails', () => {
    const schema = z.object({ limit: z.coerce.number().min(1) })
    const middleware = validate({ query: schema })
    const req = { params: {}, query: { limit: '0' }, body: {} } as Request
    middleware(req, res, mockNext)
    expect(mockStatus).toHaveBeenCalledWith(400)
    expect(mockJson.mock.calls[0][0].details).toBeDefined()
  })

  it('validates body and attaches to req.validated.body', () => {
    const schema = z.object({ name: z.string() })
    const middleware = validate({ body: schema })
    const req = { params: {}, query: {}, body: { name: 'foo' } } as Request
    middleware(req, res, mockNext)
    expect(mockNext).toHaveBeenCalledOnce()
    expect(req.validated?.body).toEqual({ name: 'foo' })
  })

  it('returns 400 when body validation fails (missing required)', () => {
    const schema = z.object({ name: z.string().min(1) })
    const middleware = validate({ body: schema })
    const req = { params: {}, query: {}, body: {} } as Request
    middleware(req, res, mockNext)
    expect(mockStatus).toHaveBeenCalledWith(400)
    expect(mockJson.mock.calls[0][0].error).toBe('Validation failed')
  })

  it('validates params + query + body together', () => {
    const middleware = validate({
      params: z.object({ address: z.string() }),
      query: z.object({ limit: z.coerce.number() }),
      body: z.object({ value: z.string() }),
    })
    const req = {
      params: { address: '0xabc' },
      query: { limit: '5' },
      body: { value: 'v' },
    } as Request
    middleware(req, res, mockNext)
    expect(mockNext).toHaveBeenCalledOnce()
    expect(req.validated?.params).toEqual({ address: '0xabc' })
    expect(req.validated?.query).toEqual({ limit: 5 })
    expect(req.validated?.body).toEqual({ value: 'v' })
  })

  it('collects all errors when multiple sources fail', () => {
    const middleware = validate({
      params: z.object({ id: z.string().min(1) }),
      body: z.object({ name: z.string().min(1) }),
    })
    const req = {
      params: { id: '' },
      query: {},
      body: { name: '' },
    } as Request
    middleware(req, res, mockNext)
    expect(mockStatus).toHaveBeenCalledWith(400)
    const details = mockJson.mock.calls[0][0].details as Array<{ path: string; message: string }>
    expect(details.length).toBeGreaterThanOrEqual(2)
  })

  it('calls next() when no schemas provided (no-op)', () => {
    const middleware = validate({})
    const req = { params: {}, query: {}, body: {} } as Request
    middleware(req, res, mockNext)
    expect(mockNext).toHaveBeenCalledOnce()
    expect(req.validated).toEqual({})
  })
})
