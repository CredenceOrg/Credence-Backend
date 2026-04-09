import { Request, Response, NextFunction } from 'express'
import { errorHandler, ErrorResponse } from './errorHandler.js'
import { LockTimeoutError, LockTimeoutPolicy } from '../db/transaction.js'
import { InsufficientFundsError } from '../db/repositories/bondsRepository.js'

describe('errorHandler', () => {
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let mockNext: NextFunction
  let jsonSpy: jest.Mock
  let statusSpy: jest.Mock

  beforeEach(() => {
    mockRequest = {}
    jsonSpy = jest.fn()
    statusSpy = jest.fn().mockReturnValue({ json: jsonSpy })
    mockResponse = {
      status: statusSpy,
      json: jsonSpy,
    }
    mockNext = jest.fn()
  })

  describe('LockTimeoutError', () => {
    it('should return 409 with LOCK_TIMEOUT code', () => {
      const error = new LockTimeoutError(
        'Lock timeout after 5000ms',
        LockTimeoutPolicy.CRITICAL,
        5000
      )

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      expect(statusSpy).toHaveBeenCalledWith(409)
      expect(jsonSpy).toHaveBeenCalledWith({
        code: 'LOCK_TIMEOUT',
        message: 'Resource is currently locked by another operation',
        details: {
          policy: LockTimeoutPolicy.CRITICAL,
          timeoutMs: 5000,
        },
        retryable: true,
        retryAfterMs: 1000,
      })
    })

    it('should mark as retryable', () => {
      const error = new LockTimeoutError(
        'Lock timeout',
        LockTimeoutPolicy.DEFAULT,
        2000
      )

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      const response = jsonSpy.mock.calls[0][0] as ErrorResponse
      expect(response.retryable).toBe(true)
      expect(response.retryAfterMs).toBe(1000)
    })
  })

  describe('InsufficientFundsError', () => {
    it('should return 422 with INSUFFICIENT_FUNDS code', () => {
      const error = new InsufficientFundsError(123, '500', '600')

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      expect(statusSpy).toHaveBeenCalledWith(422)
      expect(jsonSpy).toHaveBeenCalledWith({
        code: 'INSUFFICIENT_FUNDS',
        message: expect.stringContaining('Insufficient funds'),
        details: {
          bondId: 123,
          available: '500',
          requested: '600',
        },
        retryable: false,
      })
    })

    it('should mark as non-retryable', () => {
      const error = new InsufficientFundsError(1, '100', '200')

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      const response = jsonSpy.mock.calls[0][0] as ErrorResponse
      expect(response.retryable).toBe(false)
    })
  })

  describe('PostgreSQL errors', () => {
    it('should handle unique constraint violation (23505)', () => {
      const error = Object.assign(new Error('Duplicate key'), {
        code: '23505',
      })

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      expect(statusSpy).toHaveBeenCalledWith(409)
      expect(jsonSpy).toHaveBeenCalledWith({
        code: 'DUPLICATE_ENTRY',
        message: 'Resource already exists',
        retryable: false,
      })
    })

    it('should handle foreign key violation (23503)', () => {
      const error = Object.assign(new Error('Foreign key violation'), {
        code: '23503',
      })

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      expect(statusSpy).toHaveBeenCalledWith(422)
      expect(jsonSpy).toHaveBeenCalledWith({
        code: 'INVALID_REFERENCE',
        message: 'Referenced resource does not exist',
        retryable: false,
      })
    })

    it('should handle serialization failure (40001)', () => {
      const error = Object.assign(new Error('Serialization failure'), {
        code: '40001',
      })

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      expect(statusSpy).toHaveBeenCalledWith(409)
      const response = jsonSpy.mock.calls[0][0] as ErrorResponse
      expect(response.code).toBe('SERIALIZATION_FAILURE')
      expect(response.retryable).toBe(true)
      expect(response.retryAfterMs).toBe(500)
    })

    it('should handle deadlock (40P01)', () => {
      const error = Object.assign(new Error('Deadlock detected'), {
        code: '40P01',
      })

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      expect(statusSpy).toHaveBeenCalledWith(409)
      const response = jsonSpy.mock.calls[0][0] as ErrorResponse
      expect(response.code).toBe('DEADLOCK_DETECTED')
      expect(response.retryable).toBe(true)
      expect(response.retryAfterMs).toBe(1000)
    })
  })

  describe('ValidationError', () => {
    it('should return 400 for validation errors', () => {
      const error = new Error('Invalid input')
      error.name = 'ValidationError'

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      expect(statusSpy).toHaveBeenCalledWith(400)
      expect(jsonSpy).toHaveBeenCalledWith({
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
        retryable: false,
      })
    })
  })

  describe('Unknown errors', () => {
    it('should return 500 for unknown errors', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()
      const error = new Error('Unknown error')

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      )

      expect(statusSpy).toHaveBeenCalledWith(500)
      expect(jsonSpy).toHaveBeenCalledWith({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        retryable: false,
      })
      expect(consoleErrorSpy).toHaveBeenCalledWith('Unhandled error:', error)

      consoleErrorSpy.mockRestore()
    })
  })
})
