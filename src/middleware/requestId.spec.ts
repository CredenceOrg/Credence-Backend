import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requestIdMiddleware } from './requestId.js'
import { tracingContext, logger } from '../utils/logger.js'

describe('RequestId Middleware', () => {
  let mockReq: any
  let mockRes: any
  let nextFunction: (err?: any) => void

  beforeEach(() => {
    mockReq = { 
      header: vi.fn().mockReturnValue(null),
      correlationId: undefined,
      requestId: undefined
    }
    mockRes = { setHeader: vi.fn() }
    nextFunction = vi.fn()
    // Mock console to avoid noisy logs during tests
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('should generate a new Request-ID and Correlation-ID if none exist', () => {
    requestIdMiddleware(mockReq, mockRes, nextFunction)

    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'x-request-id',
      expect.any(String)
    )
    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'x-correlation-id',
      expect.any(String)
    )
    expect(nextFunction).toHaveBeenCalled()
  })

  it('should preserve an existing Correlation-ID from headers', () => {
    const existingId = 'existing-corr-123'
    mockReq.header.mockReturnValue(existingId)

    requestIdMiddleware(mockReq, mockRes, nextFunction)

    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'x-correlation-id',
      existingId
    )
  })

  it('should propagate IDs to logger via tracingContext', () => {
    const testCorrelationId = 'test-propagation-id'
    mockReq.header.mockReturnValue(testCorrelationId)
    
    requestIdMiddleware(mockReq, mockRes, () => {
      logger.info('checking propagation')
    })

    const consoleSpy = vi.spyOn(console, 'log')
    const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0]
    
    expect(lastCall).toContain(`[CorrelationID: ${testCorrelationId}]`)
    expect(lastCall).toContain('checking propagation')
  })
})
