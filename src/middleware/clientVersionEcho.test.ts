import { describe, it, expect, vi } from 'vitest'
import { Request, Response } from 'express'
import { clientVersionEchoMiddleware } from './clientVersionEcho.js'
import { HEADER_CLIENT_VERSION } from '../config/constants.js'

describe('clientVersionEchoMiddleware', () => {
  it('should echo the client version if present', () => {
    const req = {
      get: vi.fn().mockReturnValue('v1.0.0'),
    } as unknown as Request

    const res = {
      setHeader: vi.fn(),
    } as unknown as Response

    const next = vi.fn()

    clientVersionEchoMiddleware(req, res, next)

    expect(req.get).toHaveBeenCalledWith(HEADER_CLIENT_VERSION)
    expect(res.setHeader).toHaveBeenCalledWith(HEADER_CLIENT_VERSION, 'v1.0.0')
    expect(next).toHaveBeenCalled()
  })

  it('should not echo if client version is missing', () => {
    const req = {
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as Request

    const res = {
      setHeader: vi.fn(),
    } as unknown as Response

    const next = vi.fn()

    clientVersionEchoMiddleware(req, res, next)

    expect(req.get).toHaveBeenCalledWith(HEADER_CLIENT_VERSION)
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })
})
