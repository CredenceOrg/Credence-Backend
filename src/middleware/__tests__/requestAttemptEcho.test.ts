import { describe, it, expect, vi } from 'vitest'
import { Request, Response } from 'express'
import { requestAttemptEchoMiddleware } from '../requestAttemptEcho.js'
import { HEADER_REQUEST_ATTEMPT } from '../../config/constants.js'

describe('requestAttemptEchoMiddleware', () => {
  it('should echo the request attempt if present', () => {
    const req = {
      get: vi.fn().mockReturnValue('3'),
    } as unknown as Request

    const res = {
      setHeader: vi.fn(),
    } as unknown as Response

    const next = vi.fn()

    requestAttemptEchoMiddleware(req, res, next)

    expect(req.get).toHaveBeenCalledWith(HEADER_REQUEST_ATTEMPT)
    expect(res.setHeader).toHaveBeenCalledWith(HEADER_REQUEST_ATTEMPT, '3')
    expect(next).toHaveBeenCalled()
  })

  it('should not echo if request attempt is missing', () => {
    const req = {
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as Request

    const res = {
      setHeader: vi.fn(),
    } as unknown as Response

    const next = vi.fn()

    requestAttemptEchoMiddleware(req, res, next)

    expect(req.get).toHaveBeenCalledWith(HEADER_REQUEST_ATTEMPT)
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })
})