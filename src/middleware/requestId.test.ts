import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requestIdMiddleware } from './requestId.js'
import { tracingContext, logger } from '../utils/logger.js'

describe('requestIdMiddleware', () => {
  let req: any
  let res: any
  let next: any

  beforeEach(() => {
    req = {
      header: vi.fn(),
    }
    res = {
      setHeader: vi.fn(),
    }
    next = vi.fn()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('should generate new IDs if none provided', () => {
    req.header.mockReturnValue(undefined)

    requestIdMiddleware(req, res, next)

    expect(req.correlationId).toBeDefined()
    expect(req.requestId).toBeDefined()
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', req.correlationId)
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', req.requestId)
    expect(next).toHaveBeenCalled()
  })

  it('should use existing correlation ID from header', () => {
    const existingId = 'existing-correlation-id'
    req.header.mockReturnValue(existingId)

    requestIdMiddleware(req, res, next)

    expect(req.correlationId).toBe(existingId)
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', existingId)
  })

  it('should propagate IDs to logger via tracingContext', () => {
    req.header.mockReturnValue('test-correlation')
    
    requestIdMiddleware(req, res, () => {
      logger.info('test message')
    })

    const consoleSpy = vi.spyOn(console, 'log')
    const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0]
    
    expect(lastCall).toContain('[CorrelationID: test-correlation]')
    expect(lastCall).toContain('test message')
  })
})
