import { describe, it, expect, vi } from 'vitest'
import { Request, Response } from 'express'
import { responseTimeMiddleware } from '../responseTime.js'
import { HEADER_RESPONSE_TIME_MS } from '../../config/constants.js'

describe('responseTimeMiddleware', () => {
  it('should set x-response-time-ms with elapsed time on response end', () => {
    const req = {} as Request

    const headers: Record<string, string> = {}
    const setHeader = vi.fn((name: string, value: string) => {
      headers[name] = value
    })

    const res = {
      setHeader,
      end: vi.fn(),
      get headersSent() { return false },
    } as unknown as Response

    const next = vi.fn()

    responseTimeMiddleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(setHeader).not.toHaveBeenCalled()

    res.end()

    expect(setHeader).toHaveBeenCalledWith(
      HEADER_RESPONSE_TIME_MS,
      expect.any(String),
    )
    expect(Number(headers[HEADER_RESPONSE_TIME_MS])).toBeGreaterThanOrEqual(0)
  })

  it('should not set header if headers were already sent', () => {
    const req = {} as Request

    let headersSent = true
    const setHeader = vi.fn()

    const res = {
      setHeader,
      end: vi.fn(),
      get headersSent() { return headersSent },
    } as unknown as Response

    const next = vi.fn()

    responseTimeMiddleware(req, res, next)

    res.end()

    expect(setHeader).not.toHaveBeenCalled()
  })

  it('should preserve the original end return value', () => {
    const req = {} as Request
    const expectedReturn = {} as Response

    const res = {
      setHeader: vi.fn(),
      end: vi.fn().mockReturnValue(expectedReturn),
      get headersSent() { return false },
    } as unknown as Response

    const next = vi.fn()

    responseTimeMiddleware(req, res, next)

    const returnValue = res.end()
    expect(returnValue).toBe(expectedReturn)
  })

  it('should call the original end with provided arguments', () => {
    const req = {} as Request

    const originalEnd = vi.fn()
    const res = {
      setHeader: vi.fn(),
      end: originalEnd,
      get headersSent() { return false },
    } as unknown as Response

    const next = vi.fn()

    responseTimeMiddleware(req, res, next)

    const chunk = Buffer.from('test')
    const encoding = 'utf8'
    res.end(chunk, encoding)

    expect(originalEnd).toHaveBeenCalledWith(chunk, encoding)
  })
})
