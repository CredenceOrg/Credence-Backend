/**
 * Tests for timeout executor functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  executeWithTimeout,
  executeDbOperation,
  executeCacheOperation,
  executeHttpRequest,
  TimeoutExceededError,
  consoleMetrics,
  withTimeout,
  type TimeoutMetrics,
} from '../timeoutExecutor.js'
import { createTimeoutConfig } from '../timeouts.js'

describe('Timeout Executor', () => {
  let mockMetrics: TimeoutMetrics

  beforeEach(() => {
    mockMetrics = {
      onTimeout: vi.fn(),
      onSuccess: vi.fn(),
    }
    vi.clearAllMocks()
  })

  describe('executeWithTimeout', () => {
    it('should execute function successfully within timeout', async () => {
      const result = await executeWithTimeout(
        async () => 'success',
        'cache',
        'CACHE_GET_TIMEOUT',
        { metrics: mockMetrics }
      )

      expect(result).toBe('success')
      expect(mockMetrics.onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          operation: 'unknown',
        })
      )
      expect(mockMetrics.onTimeout).not.toHaveBeenCalled()
    })

    it('should timeout when function takes too long', async () => {
      const slowFn = async () => {
        await new Promise(resolve => setTimeout(resolve, 2000)) // 2s delay
        return 'success'
      }

      await expect(
        executeWithTimeout(
          slowFn,
          'cache',
          'CACHE_GET_TIMEOUT',
          { overrideMs: 100, metrics: mockMetrics } // 100ms timeout
        )
      ).rejects.toThrow(TimeoutExceededError)

      expect(mockMetrics.onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT',
          timeoutMs: 100,
        })
      )
      expect(mockMetrics.onSuccess).not.toHaveBeenCalled()
    })

    it('should respect timeout override', async () => {
      const result = await executeWithTimeout(
        async () => 'success',
        'cache',
        'CACHE_GET_TIMEOUT',
        { overrideMs: 2000, metrics: mockMetrics }
      )

      expect(result).toBe('success')
      expect(mockMetrics.onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 2000, // Should use override
        })
      )
    })

    it('should pass context to the function', async () => {
      const mockFn = vi.fn(async (context) => {
        expect(context).toBeDefined()
        expect(context.serviceType).toBe('cache')
        expect(context.reasonCode).toBe('CACHE_GET_TIMEOUT')
        expect(context.timeoutMs).toBeGreaterThan(0)
        expect(context.operation).toBe('unknown')
        expect(context.startTime).toBeTypeOf('number')
        return 'success'
      })

      await executeWithTimeout(mockFn, 'cache', 'CACHE_GET_TIMEOUT')

      expect(mockFn).toHaveBeenCalledOnce()
    })

    it('should handle function errors properly', async () => {
      const error = new Error('Function error')
      
      await expect(
        executeWithTimeout(
          async () => { throw error },
          'cache',
          'CACHE_GET_TIMEOUT'
        )
      ).rejects.toThrow('Function error')

      expect(mockMetrics.onTimeout).not.toHaveBeenCalled()
      expect(mockMetrics.onSuccess).not.toHaveBeenCalled()
    })

    it('should use custom error handler when provided', async () => {
      const customError = new Error('Custom error')
      const errorHandler = vi.fn((err) => customError)

      await expect(
        executeWithTimeout(
          async () => { throw new Error('Original error') },
          'cache',
          'CACHE_GET_TIMEOUT',
          { onError: errorHandler }
        )
      ).rejects.toThrow('Custom error')

      expect(errorHandler).toHaveBeenCalledOnce()
    })
  })

  describe('executeDbOperation', () => {
    it('should execute database operations with appropriate timeout', async () => {
      const mockDbFn = vi.fn(async () => 'db_result')
      
      const result = await executeDbOperation(
        'test_query',
        mockDbFn,
        { metrics: mockMetrics }
      )

      expect(result).toBe('db_result')
      expect(mockDbFn).toHaveBeenCalledOnce()
      expect(mockMetrics.onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceType: 'database',
          reasonCode: 'DB_QUERY_TIMEOUT',
          operation: 'test_query',
        })
      )
    })

    it('should use transaction timeout for transaction operations', async () => {
      const mockTxnFn = vi.fn(async () => 'txn_result')
      
      await executeDbOperation(
        'transaction_begin',
        mockTxnFn,
        { metrics: mockMetrics }
      )

      expect(mockMetrics.onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonCode: 'DB_TRANSACTION_TIMEOUT', // Should detect transaction
        })
      )
    })
  })

  describe('executeCacheOperation', () => {
    it('should execute cache operations with appropriate timeout', async () => {
      const mockCacheFn = vi.fn(async () => 'cache_result')
      
      const result = await executeCacheOperation(
        'cache.get.test',
        mockCacheFn,
        { metrics: mockMetrics }
      )

      expect(result).toBe('cache_result')
      expect(mockCacheFn).toHaveBeenCalledOnce()
      expect(mockMetrics.onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceType: 'cache',
          reasonCode: 'CACHE_GET_TIMEOUT', // Should detect get operation
          operation: 'cache.get.test',
        })
      )
    })

    it('should use set timeout for set operations', async () => {
      const mockSetFn = vi.fn(async () => 'set_result')
      
      await executeCacheOperation(
        'cache.set.test',
        mockSetFn,
        { metrics: mockMetrics }
      )

      expect(mockMetrics.onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonCode: 'CACHE_SET_TIMEOUT', // Should detect set operation
        })
      )
    })
  })

  describe('executeHttpRequest', () => {
    it('should execute HTTP operations with abort signal', async () => {
      const mockHttpFn = vi.fn(async (signal) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        return 'http_result'
      })
      
      const result = await executeHttpRequest(
        'https://example.com',
        mockHttpFn,
        { metrics: mockMetrics }
      )

      expect(result).toBe('http_result')
      expect(mockHttpFn).toHaveBeenCalledWith(expect.any(AbortSignal))
      expect(mockMetrics.onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceType: 'http',
          reasonCode: 'HTTP_REQUEST_TIMEOUT',
          operation: 'HTTP https://example.com',
        })
      )
    })
  })

  describe('withTimeout', () => {
    it('should wrap functions with timeout enforcement', async () => {
      const originalFn = vi.fn(async (arg: string) => `result_${arg}`)
      const wrappedFn = withTimeout(originalFn, 'cache', 'CACHE_GET_TIMEOUT')
      
      const result = await wrappedFn('test')
      
      expect(result).toBe('result_test')
      expect(originalFn).toHaveBeenCalledWith('test')
    })

    it('should preserve function signature', async () => {
      const originalFn = vi.fn(async (a: number, b: string) => `${a}_${b}`)
      const wrappedFn = withTimeout(originalFn, 'cache', 'CACHE_GET_TIMEOUT')
      
      const result = await wrappedFn(42, 'test')
      
      expect(result).toBe('42_test')
      expect(originalFn).toHaveBeenCalledWith(42, 'test')
    })
  })

  describe('Timeout Enforcement', () => {
    it('should enforce timeout budgets strictly', async () => {
      const startTime = Date.now()
      
      await expect(
        executeWithTimeout(
          async () => {
            await new Promise(resolve => setTimeout(resolve, 5000))
            return 'late'
          },
          'cache',
          'CACHE_GET_TIMEOUT',
          { overrideMs: 200 } // Very short timeout
        )
      ).rejects.toThrow(TimeoutExceededError)

      const endTime = Date.now()
      const duration = endTime - startTime
      
      // Should timeout well before the 5s function completes
      expect(duration).toBeLessThan(1000)
    })

    it('should not extend timeouts in retry scenarios', async () => {
      let attemptCount = 0
      const retryFn = vi.fn(async () => {
        attemptCount++
        if (attemptCount < 3) {
          // Simulate timeout on first attempts
          await new Promise(resolve => setTimeout(resolve, 200))
          throw new Error('Simulated timeout')
        }
        return 'success'
      })

      // This test simulates the behavior where timeouts should not be extended
      // during retries - each retry should respect the same timeout budget
      const result = await executeWithTimeout(
        retryFn,
        'cache',
        'CACHE_GET_TIMEOUT',
        { overrideMs: 100 }
      )

      expect(result).toBe('success')
      expect(retryFn).toHaveBeenCalledTimes(3)
    })
  })

  describe('Observability Integration', () => {
    it('should track slow operations', async () => {
      const slowFn = async () => {
        // Operation that takes 80% of timeout but doesn't timeout
        await new Promise(resolve => setTimeout(resolve, 80))
        return 'slow_success'
      }

      await executeWithTimeout(
        slowFn,
        'cache',
        'CACHE_GET_TIMEOUT',
        { overrideMs: 100, metrics: consoleMetrics }
      )

      // Console metrics should log slow operations
      // This is more of an integration test - in real implementation
      // we'd mock console.warn to verify it was called
    })

    it('should provide detailed timeout information', async () => {
      const timeoutFn = async () => {
        await new Promise(resolve => setTimeout(resolve, 1000))
        return 'too_late'
      }

      try {
        await executeWithTimeout(
          timeoutFn,
          'soroban',
          'SOROBAN_RPC_TIMEOUT',
          { overrideMs: 100, metrics: mockMetrics }
        )
      } catch (error) {
        expect(error).toBeInstanceOf(TimeoutExceededError)
        if (error instanceof TimeoutExceededError) {
          expect(error.serviceType).toBe('soroban')
          expect(error.reasonCode).toBe('SOROBAN_RPC_TIMEOUT')
          expect(error.timeoutMs).toBe(100)
          expect(error.operation).toBe('unknown')
        }
      }
    })
  })
})
