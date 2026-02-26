import { requestIdMiddleware } from './requestId.js'

describe('RequestId Middleware', () => {
  let mockReq: any
  let mockRes: any
  let nextFunction: jest.Mock

  beforeEach(() => {
    mockReq = { header: jest.fn().mockReturnValue(null) }
    mockRes = { setHeader: jest.fn() }
    nextFunction = jest.fn()
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
})
