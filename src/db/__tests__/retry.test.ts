import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PoolClient } from 'pg'
import {
  withRetryableTransaction,
  isRetryableError,
  calculateBackoffMs,
  MaxRetriesExhaustedError,
  RETRYABLE_ERROR_CODES,
  NON_RETRYABLE_ERROR_CODES,
  withRetryableTransactionManager,
} from '../retry.js'

// Mock logger to avoid console noise during tests
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

describe('retry', () => {
  describe('isRetryableError', () => {
    it('should identify serialization failure as retryable', () => {
      const error = { code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE }
      expect(isRetryableError(error)).toBe(true)
    })

    it('should identify deadlock detected as retryable', () => {
      const error = { code: RETRYABLE_ERROR_CODES.DEADLOCK_DETECTED }
      expect(isRetryableError(error)).toBe(true)
    })

    it('should identify transaction rollback as retryable', () => {
      const error = { code: RETRYABLE_ERROR_CODES.TRANSACTION_ROLLBACK }
      expect(isRetryableError(error)).toBe(true)
    })

    it('should identify ECONNRESET as retryable', () => {
      const error = { errno: 'ECONNRESET' }
      expect(isRetryableError(error)).toBe(true)
    })

    it('should identify ETIMEDOUT as retryable', () => {
      const error = { errno: 'ETIMEDOUT' }
      expect(isRetryableError(error)).toBe(true)
    })

    it('should identify unique constraint violation as non-retryable', () => {
      const error = { code: NON_RETRYABLE_ERROR_CODES.UNIQUE_VIOLATION }
      expect(isRetryableError(error)).toBe(false)
    })

    it('should identify foreign key violation as non-retryable', () => {
      const error = { code: NON_RETRYABLE_ERROR_CODES.FOREIGN_KEY_VIOLATION }
      expect(isRetryableError(error)).toBe(false)
    })

    it('should identify not null violation as non-retryable', () => {
      const error = { code: NON_RETRYABLE_ERROR_CODES.NOT_NULL_VIOLATION }
      expect(isRetryableError(error)).toBe(false)
    })

    it('should identify check constraint violation as non-retryable', () => {
      const error = { code: NON_RETRYABLE_ERROR_CODES.CHECK_VIOLATION }
      expect(isRetryableError(error)).toBe(false)
    })

    it('should return false for unknown error codes', () => {
      const error = { code: 'XX999' }
      expect(isRetryableError(error)).toBe(false)
    })

    it('should return false for null or undefined', () => {
      expect(isRetryableError(null)).toBe(false)
      expect(isRetryableError(undefined)).toBe(false)
    })

    it('should return false for non-object errors', () => {
      expect(isRetryableError('error string')).toBe(false)
      expect(isRetryableError(123)).toBe(false)
    })
  })

  describe('calculateBackoffMs', () => {
    beforeEach(() => {
      // Mock Math.random for deterministic tests
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should calculate exponential backoff for attempt 0', () => {
      const backoff = calculateBackoffMs(0, 50, 1000)
      // 50 * 2^0 = 50, with 0.5 random: 25
      expect(backoff).toBe(25)
    })

    it('should calculate exponential backoff for attempt 1', () => {
      const backoff = calculateBackoffMs(1, 50, 1000)
      // 50 * 2^1 = 100, with 0.5 random: 50
      expect(backoff).toBe(50)
    })

    it('should calculate exponential backoff for attempt 2', () => {
      const backoff = calculateBackoffMs(2, 50, 1000)
      // 50 * 2^2 = 200, with 0.5 random: 100
      expect(backoff).toBe(100)
    })

    it('should cap at maxBackoffMs', () => {
      const backoff = calculateBackoffMs(10, 50, 1000)
      // 50 * 2^10 = 51200, capped at 1000, with 0.5 random: 500
      expect(backoff).toBe(500)
    })

    it('should produce different values with full jitter', () => {
      vi.restoreAllMocks() // Remove mock to test randomness
      
      const backoffs = new Set<number>()
      for (let i = 0; i < 100; i++) {
        backoffs.add(calculateBackoffMs(2, 50, 1000))
      }
      
      // With full jitter, we should get multiple different values
      expect(backoffs.size).toBeGreaterThan(10)
    })
  })

  describe('withRetryableTransaction', () => {
    let mockClient: PoolClient
    let mockPool: { connect: () => Promise<PoolClient> }

    beforeEach(() => {
      mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: vi.fn(),
      } as unknown as PoolClient

      mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
      }
    })

    it('should execute successfully on first attempt', async () => {
      const mockFn = vi.fn().mockResolvedValue('success')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        operationName: 'test-operation',
      })

      expect(result).toBe('success')
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN')
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
      expect(mockFn).toHaveBeenCalledTimes(1)
      expect(mockClient.release).toHaveBeenCalledTimes(1)
    })

    it('should retry on serialization failure and eventually succeed', async () => {
      const serializationError = new Error('Serialization failure')
      ;(serializationError as any).code = RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(serializationError)
        .mockRejectedValueOnce(serializationError)
        .mockResolvedValue('success')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        maxRetries: 3,
        initialBackoffMs: 10,
        operationName: 'test-retry',
      })

      expect(result).toBe('success')
      expect(mockFn).toHaveBeenCalledTimes(3)
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
      expect(mockClient.release).toHaveBeenCalledTimes(3)
    })

    it('should retry on deadlock detected and eventually succeed', async () => {
      const deadlockError = new Error('Deadlock detected')
      ;(deadlockError as any).code = RETRYABLE_ERROR_CODES.DEADLOCK_DETECTED

      const mockFn = vi.fn().mockRejectedValueOnce(deadlockError).mockResolvedValue('success')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        maxRetries: 3,
        initialBackoffMs: 10,
        operationName: 'test-deadlock',
      })

      expect(result).toBe('success')
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    it('should throw MaxRetriesExhaustedError when max retries exceeded', async () => {
      const serializationError = new Error('Serialization failure')
      ;(serializationError as any).code = RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE

      const mockFn = vi.fn().mockRejectedValue(serializationError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          initialBackoffMs: 10,
          operationName: 'test-exhausted',
        })
      ).rejects.toThrow(MaxRetriesExhaustedError)

      // Should attempt: initial + 3 retries = 4 times
      expect(mockFn).toHaveBeenCalledTimes(4)
    })

    it('should fail fast on unique constraint violation without retrying', async () => {
      const uniqueError = new Error('Unique constraint violation')
      ;(uniqueError as any).code = NON_RETRYABLE_ERROR_CODES.UNIQUE_VIOLATION

      const mockFn = vi.fn().mockRejectedValue(uniqueError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          initialBackoffMs: 10,
          operationName: 'test-unique',
        })
      ).rejects.toThrow('Unique constraint violation')

      // Should only attempt once (no retries)
      expect(mockFn).toHaveBeenCalledTimes(1)
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
    })

    it('should fail fast on foreign key violation without retrying', async () => {
      const fkError = new Error('Foreign key violation')
      ;(fkError as any).code = NON_RETRYABLE_ERROR_CODES.FOREIGN_KEY_VIOLATION

      const mockFn = vi.fn().mockRejectedValue(fkError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          initialBackoffMs: 10,
          operationName: 'test-fk',
        })
      ).rejects.toThrow('Foreign key violation')

      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should fail fast on not null violation without retrying', async () => {
      const notNullError = new Error('Not null violation')
      ;(notNullError as any).code = NON_RETRYABLE_ERROR_CODES.NOT_NULL_VIOLATION

      const mockFn = vi.fn().mockRejectedValue(notNullError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          operationName: 'test-not-null',
        })
      ).rejects.toThrow('Not null violation')

      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should handle connection reset errors with retry', async () => {
      const connError = new Error('Connection reset')
      ;(connError as any).errno = 'ECONNRESET'

      const mockFn = vi.fn().mockRejectedValueOnce(connError).mockResolvedValue('success')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        maxRetries: 3,
        initialBackoffMs: 10,
        operationName: 'test-conn-reset',
      })

      expect(result).toBe('success')
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    it('should release client even when rollback fails', async () => {
      const testError = new Error('Test error')
      ;(testError as any).code = RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE

      const mockFn = vi.fn().mockRejectedValue(testError)
      const rollbackError = new Error('Rollback failed')
      
      vi.mocked(mockClient.query).mockImplementation((sql: string) => {
        if (sql === 'ROLLBACK') {
          return Promise.reject(rollbackError)
        }
        return Promise.resolve({} as any)
      })

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 0,
          operationName: 'test-rollback-fail',
        })
      ).rejects.toThrow(MaxRetriesExhaustedError)

      // Client should still be released despite rollback failure
      expect(mockClient.release).toHaveBeenCalled()
    })

    it('should pass client to transaction function', async () => {
      const mockFn = vi.fn().mockImplementation((client) => {
        expect(client).toBe(mockClient)
        return Promise.resolve('success')
      })

      await withRetryableTransaction(mockPool, mockFn, {
        operationName: 'test-client-pass',
      })

      expect(mockFn).toHaveBeenCalledWith(mockClient)
    })

    it('should respect custom retry options', async () => {
      const serializationError = new Error('Serialization failure')
      ;(serializationError as any).code = RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE

      const mockFn = vi.fn().mockRejectedValue(serializationError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 1,
          initialBackoffMs: 5,
          maxBackoffMs: 50,
          operationName: 'custom-retry',
        })
      ).rejects.toThrow(MaxRetriesExhaustedError)

      // Should attempt: initial + 1 retry = 2 times
      expect(mockFn).toHaveBeenCalledTimes(2)
    })
  })

  describe('withRetryableTransactionManager', () => {
    let mockTransactionManager: {
      withTransaction: <R>(fn: (client: PoolClient) => Promise<R>) => Promise<R>
    }

    beforeEach(() => {
      mockTransactionManager = {
        withTransaction: vi.fn(),
      }
    })

    it('should execute successfully on first attempt', async () => {
      const mockFn = vi.fn().mockResolvedValue('success')
      vi.mocked(mockTransactionManager.withTransaction).mockImplementation((fn) => fn({} as any))

      const result = await withRetryableTransactionManager(
        mockTransactionManager,
        mockFn,
        { operationName: 'test-tm' }
      )

      expect(result).toBe('success')
      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(1)
      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should retry on serialization failure', async () => {
      const serializationError = new Error('Serialization failure')
      ;(serializationError as any).code = RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE

      const mockFn = vi.fn().mockResolvedValue('success')
      
      vi.mocked(mockTransactionManager.withTransaction)
        .mockRejectedValueOnce(serializationError)
        .mockImplementation((fn) => fn({} as any))

      const result = await withRetryableTransactionManager(
        mockTransactionManager,
        mockFn,
        { maxRetries: 3, initialBackoffMs: 10, operationName: 'test-tm-retry' }
      )

      expect(result).toBe('success')
      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(2)
    })

    it('should fail fast on non-retryable errors', async () => {
      const uniqueError = new Error('Unique constraint violation')
      ;(uniqueError as any).code = NON_RETRYABLE_ERROR_CODES.UNIQUE_VIOLATION

      vi.mocked(mockTransactionManager.withTransaction).mockRejectedValue(uniqueError)

      await expect(
        withRetryableTransactionManager(
          mockTransactionManager,
          vi.fn(),
          { maxRetries: 3, operationName: 'test-tm-unique' }
        )
      ).rejects.toThrow('Unique constraint violation')

      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(1)
    })

    it('should throw MaxRetriesExhaustedError when max retries exceeded', async () => {
      const deadlockError = new Error('Deadlock detected')
      ;(deadlockError as any).code = RETRYABLE_ERROR_CODES.DEADLOCK_DETECTED

      vi.mocked(mockTransactionManager.withTransaction).mockRejectedValue(deadlockError)

      await expect(
        withRetryableTransactionManager(
          mockTransactionManager,
          vi.fn(),
          { maxRetries: 2, initialBackoffMs: 10, operationName: 'test-tm-exhausted' }
        )
      ).rejects.toThrow(MaxRetriesExhaustedError)

      // Should attempt: initial + 2 retries = 3 times
      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(3)
    })
  })

  describe('MaxRetriesExhaustedError', () => {
    it('should contain correct metadata', () => {
      const lastError = new Error('Last error message')
      const error = new MaxRetriesExhaustedError(3, lastError, 'test-operation')

      expect(error.name).toBe('MaxRetriesExhaustedError')
      expect(error.attempts).toBe(3)
      expect(error.lastError).toBe(lastError)
      expect(error.operationName).toBe('test-operation')
      expect(error.message).toContain('Max retries (3) exhausted')
      expect(error.message).toContain('test-operation')
      expect(error.message).toContain('Last error message')
    })
  })
})
