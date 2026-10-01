import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PoolClient } from 'pg'
import {
  withRetryableTransaction,
  withRetryableTransactionManager,
  isRetryableError,
  calculateBackoffMs,
  classifyConflict,
  sanitizeErrorMessage,
  ConflictError,
  MaxRetriesExhaustedError,
  RETRYABLE_ERROR_CODES,
  NON_RETRYABLE_ERROR_CODES,
  TRANSIENT_NETWORK_ERRORS,
} from '../retry.js'
import { logger } from '../../utils/logger.js'

// Mock logger to avoid console noise and verify logging invariants
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

describe('retry module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // =========================================================================
  // 1. isRetryableError & Error Classification
  // =========================================================================
  describe('isRetryableError', () => {
    it('should identify PostgreSQL serialization failure as retryable', () => {
      expect(isRetryableError({ code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE })).toBe(true)
    })

    it('should identify deadlock detected as retryable', () => {
      expect(isRetryableError({ code: RETRYABLE_ERROR_CODES.DEADLOCK_DETECTED })).toBe(true)
    })

    it('should identify transaction rollback variants as retryable', () => {
      expect(isRetryableError({ code: RETRYABLE_ERROR_CODES.TRANSACTION_ROLLBACK })).toBe(true)
      expect(isRetryableError({ code: RETRYABLE_ERROR_CODES.TRANSACTION_INTEGRITY_CONSTRAINT_VIOLATION })).toBe(true)
      expect(isRetryableError({ code: RETRYABLE_ERROR_CODES.TRANSACTION_COMPLETION_UNKNOWN })).toBe(true)
    })

    it('should identify PostgreSQL lock timeout (55P03) as retryable', () => {
      expect(isRetryableError({ code: '55P03' })).toBe(true)
    })

    it('should identify transient network error codes as retryable', () => {
      for (const errno of TRANSIENT_NETWORK_ERRORS) {
        expect(isRetryableError({ errno })).toBe(true)
      }
    })

    // Non-retryable constraint violations
    it('should identify unique constraint violation as non-retryable', () => {
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.UNIQUE_VIOLATION })).toBe(false)
    })

    it('should identify foreign key violation as non-retryable', () => {
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.FOREIGN_KEY_VIOLATION })).toBe(false)
    })

    it('should identify not null violation as non-retryable', () => {
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.NOT_NULL_VIOLATION })).toBe(false)
    })

    it('should identify check constraint violation as non-retryable', () => {
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.CHECK_VIOLATION })).toBe(false)
    })

    it('should identify data syntax and range violations as non-retryable', () => {
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.INVALID_TEXT_REPRESENTATION })).toBe(false)
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.NUMERIC_VALUE_OUT_OF_RANGE })).toBe(false)
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.DIVISION_BY_ZERO })).toBe(false)
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.INVALID_PARAMETER_VALUE })).toBe(false)
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.UNDEFINED_COLUMN })).toBe(false)
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.UNDEFINED_TABLE })).toBe(false)
    })

    // Permission and Authorization states
    it('should identify permission and authorization violations as non-retryable', () => {
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.INSUFFICIENT_PRIVILEGE })).toBe(false)
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.INVALID_AUTHORIZATION_SPECIFICATION })).toBe(false)
      expect(isRetryableError({ code: NON_RETRYABLE_ERROR_CODES.INVALID_PASSWORD })).toBe(false)
    })

    // Boundary and invalid inputs
    it('should return false for unknown error codes', () => {
      expect(isRetryableError({ code: 'XX999' })).toBe(false)
    })

    it('should return false for null and undefined', () => {
      expect(isRetryableError(null)).toBe(false)
      expect(isRetryableError(undefined)).toBe(false)
    })

    it('should return false for primitives and non-object inputs', () => {
      expect(isRetryableError('error string')).toBe(false)
      expect(isRetryableError(12345)).toBe(false)
      expect(isRetryableError(true)).toBe(false)
      expect(isRetryableError(Symbol('error'))).toBe(false)
    })

    it('should return false for empty objects or objects without code/errno', () => {
      expect(isRetryableError({})).toBe(false)
      expect(isRetryableError({ message: 'generic failure' })).toBe(false)
    })
  })

  // =========================================================================
  // 2. calculateBackoffMs (Boundary & Jitter Behavior)
  // =========================================================================
  describe('calculateBackoffMs', () => {
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should calculate exponential backoff deterministically with mocked random', () => {
      // 50 * 2^0 = 50, with 0.5 random = 25
      expect(calculateBackoffMs(0, 50, 1000)).toBe(25)
      // 50 * 2^1 = 100, with 0.5 random = 50
      expect(calculateBackoffMs(1, 50, 1000)).toBe(50)
      // 50 * 2^2 = 200, with 0.5 random = 100
      expect(calculateBackoffMs(2, 50, 1000)).toBe(100)
    })

    it('should cap delay at maxBackoffMs', () => {
      // 50 * 2^10 = 51200, capped at 1000, with 0.5 random = 500
      expect(calculateBackoffMs(10, 50, 1000)).toBe(500)
    })

    it('should handle boundary case: negative attempt', () => {
      // Negative attempt clamped to 0: 50 * 2^0 = 50, with 0.5 random = 25
      expect(calculateBackoffMs(-1, 50, 1000)).toBe(25)
      expect(calculateBackoffMs(-99, 50, 1000)).toBe(25)
    })

    it('should handle boundary case: non-integer / decimal attempt', () => {
      // 1.8 floored to 1: 50 * 2^1 = 100, with 0.5 random = 50
      expect(calculateBackoffMs(1.8, 50, 1000)).toBe(50)
    })

    it('should handle boundary case: large attempt without integer overflow', () => {
      // Attempt >= 31 should safely cap at maxBackoffMs without producing Infinity or NaN
      const backoff = calculateBackoffMs(100, 50, 1000)
      expect(Number.isFinite(backoff)).toBe(true)
      expect(backoff).toBe(500) // capped at 1000, * 0.5 = 500
    })

    it('should handle boundary case: NaN or infinite attempt', () => {
      expect(calculateBackoffMs(NaN, 50, 1000)).toBe(25)
      expect(calculateBackoffMs(Infinity, 50, 1000)).toBe(25)
    })

    it('should handle boundary case: zero or negative initialBackoffMs', () => {
      expect(calculateBackoffMs(2, 0, 1000)).toBe(0)
      expect(calculateBackoffMs(2, -50, 1000)).toBe(0)
    })

    it('should handle boundary case: maxBackoffMs smaller than initialBackoffMs', () => {
      // When max < initial, max is clamped to initial (100). Delay = 100 * 0.5 = 50
      expect(calculateBackoffMs(0, 100, 10)).toBe(50)
    })

    it('should produce full jitter across iterations', () => {
      vi.restoreAllMocks()
      const backoffs = new Set<number>()
      for (let i = 0; i < 100; i++) {
        backoffs.add(calculateBackoffMs(2, 50, 1000))
      }
      expect(backoffs.size).toBeGreaterThan(10)
    })
  })

  // =========================================================================
  // 3. classifyConflict & Stale State Mapping
  // =========================================================================
  describe('classifyConflict', () => {
    it('should classify serialization failure', () => {
      expect(classifyConflict({ code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE })).toBe('serialization_failure')
      expect(classifyConflict({ code: RETRYABLE_ERROR_CODES.TRANSACTION_ROLLBACK })).toBe('serialization_failure')
    })

    it('should classify deadlock detected', () => {
      expect(classifyConflict({ code: RETRYABLE_ERROR_CODES.DEADLOCK_DETECTED })).toBe('deadlock')
    })

    it('should classify lock timeout (55P03)', () => {
      expect(classifyConflict({ code: '55P03' })).toBe('lock_timeout')
    })

    it('should classify optimistic lock / stale states', () => {
      expect(classifyConflict({ name: 'OptimisticLockError' })).toBe('optimistic_lock')
      expect(classifyConflict({ code: 'OPTIMISTIC_LOCK_CONFLICT' })).toBe('optimistic_lock')
      expect(classifyConflict({ code: 'optimistic_lock_conflict' })).toBe('optimistic_lock')
      expect(classifyConflict({ conflictCode: 'optimistic_lock' })).toBe('optimistic_lock')
    })

    it('should return undefined for non-conflict errors and non-objects', () => {
      expect(classifyConflict({ code: '23505' })).toBeUndefined()
      expect(classifyConflict(new Error('general error'))).toBeUndefined()
      expect(classifyConflict(null)).toBeUndefined()
      expect(classifyConflict(undefined)).toBeUndefined()
      expect(classifyConflict('error string')).toBeUndefined()
    })
  })

  // =========================================================================
  // 4. sanitizeErrorMessage & Credential Protection
  // =========================================================================
  describe('sanitizeErrorMessage', () => {
    it('should redact postgres connection URIs containing credentials', () => {
      const sensitive = 'Failed to connect to postgresql://admin:super_secret_pw@db.internal:5432/production'
      const sanitized = sanitizeErrorMessage(sensitive)
      expect(sanitized).not.toContain('super_secret_pw')
      expect(sanitized).toContain('postgresql://admin:***@db.internal:5432/production')
    })

    it('should redact password and secret query parameters or key-value pairs', () => {
      const msg = 'DB error: password=mysecretpassword with token=xyz123abc'
      const sanitized = sanitizeErrorMessage(msg)
      expect(sanitized).not.toContain('mysecretpassword')
      expect(sanitized).not.toContain('xyz123abc')
      expect(sanitized).toContain('password=***')
      expect(sanitized).toContain('token=***')
    })

    it('should return empty string for non-string or falsy input', () => {
      expect(sanitizeErrorMessage('')).toBe('')
      expect(sanitizeErrorMessage(null as any)).toBe('')
      expect(sanitizeErrorMessage(undefined as any)).toBe('')
    })
  })

  // =========================================================================
  // 5. withRetryableTransaction: Success, Loading, Recovery, Boundary & Security
  // =========================================================================
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

    it('should execute successfully on first attempt and commit', async () => {
      const mockFn = vi.fn().mockResolvedValue('success')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        operationName: 'test-first-try',
      })

      expect(result).toBe('success')
      expect(mockPool.connect).toHaveBeenCalledTimes(1)
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN')
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
      expect(mockFn).toHaveBeenCalledWith(mockClient)
      expect(mockClient.release).toHaveBeenCalledTimes(1)
    })

    // Recovery from transient errors
    it('should retry on serialization failure and recover successfully', async () => {
      const serializationError = Object.assign(new Error('Serialization failure'), {
        code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE,
      })

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(serializationError)
        .mockResolvedValue('recovered')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        maxRetries: 2,
        initialBackoffMs: 1,
        operationName: 'test-ser-recovery',
      })

      expect(result).toBe('recovered')
      expect(mockFn).toHaveBeenCalledTimes(2)
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
      expect(mockClient.release).toHaveBeenCalledTimes(2)
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('succeeded after 1 retries'),
          attempts: 1,
        })
      )
    })

    it('should retry on deadlock detected and recover', async () => {
      const deadlockError = Object.assign(new Error('Deadlock detected'), {
        code: RETRYABLE_ERROR_CODES.DEADLOCK_DETECTED,
      })

      const mockFn = vi.fn().mockRejectedValueOnce(deadlockError).mockResolvedValue('deadlock-recovered')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        maxRetries: 3,
        initialBackoffMs: 1,
        operationName: 'test-deadlock-recovery',
      })

      expect(result).toBe('deadlock-recovered')
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    it('should retry on transient network connection error (ECONNRESET) and recover', async () => {
      const connError = Object.assign(new Error('Connection reset'), {
        errno: 'ECONNRESET',
      })

      const mockFn = vi.fn().mockRejectedValueOnce(connError).mockResolvedValue('network-recovered')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        maxRetries: 3,
        initialBackoffMs: 1,
        operationName: 'test-conn-recovery',
      })

      expect(result).toBe('network-recovered')
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    // Loading State & Connection Checkout Boundary
    it('should retry and recover when pool.connect() transiently fails (Loading State)', async () => {
      const connError = Object.assign(new Error('Pool connection timeout'), {
        errno: 'ETIMEDOUT',
      })

      // Fail connect on attempt 0, succeed on attempt 1
      mockPool.connect = vi
        .fn()
        .mockRejectedValueOnce(connError)
        .mockResolvedValue(mockClient)

      const mockFn = vi.fn().mockResolvedValue('pool-recovery-success')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        maxRetries: 2,
        initialBackoffMs: 1,
        operationName: 'test-pool-connect-recovery',
      })

      expect(result).toBe('pool-recovery-success')
      expect(mockPool.connect).toHaveBeenCalledTimes(2)
      // Client release only called for the successful connection
      expect(mockClient.release).toHaveBeenCalledTimes(1)
      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should fail fast without retry if pool.connect() fails with a non-retryable error', async () => {
      const authError = Object.assign(new Error('password authentication failed for user "app"'), {
        code: NON_RETRYABLE_ERROR_CODES.INVALID_PASSWORD,
      })

      mockPool.connect = vi.fn().mockRejectedValue(authError)
      const mockFn = vi.fn()

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          operationName: 'test-pool-auth-fail',
        })
      ).rejects.toThrow('password authentication failed')

      expect(mockPool.connect).toHaveBeenCalledTimes(1)
      expect(mockFn).not.toHaveBeenCalled()
      expect(mockClient.release).not.toHaveBeenCalled()
    })

    it('should recover when client.query("BEGIN") fails transiently', async () => {
      const beginError = Object.assign(new Error('Connection reset on BEGIN'), {
        errno: 'ECONNRESET',
      })

      let callCount = 0
      mockClient.query = vi.fn().mockImplementation((sql: string) => {
        if (sql === 'BEGIN' && callCount === 0) {
          callCount++
          return Promise.reject(beginError)
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      })

      const mockFn = vi.fn().mockResolvedValue('begin-recovered')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        maxRetries: 2,
        initialBackoffMs: 1,
        operationName: 'test-begin-recovery',
      })

      expect(result).toBe('begin-recovered')
      expect(mockClient.release).toHaveBeenCalledTimes(2)
    })

    // Permission State Fast-Fail
    it('should fail fast on INSUFFICIENT_PRIVILEGE (42501) without retrying (Permission State)', async () => {
      const permError = Object.assign(new Error('permission denied for table secret_records'), {
        code: NON_RETRYABLE_ERROR_CODES.INSUFFICIENT_PRIVILEGE,
      })

      const mockFn = vi.fn().mockRejectedValue(permError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          operationName: 'test-permission-denied',
        })
      ).rejects.toThrow('permission denied')

      expect(mockFn).toHaveBeenCalledTimes(1)
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
      expect(mockClient.release).toHaveBeenCalledTimes(1)
    })

    it('should fail fast on INVALID_AUTHORIZATION_SPECIFICATION (28000) without retrying', async () => {
      const authSpecError = Object.assign(new Error('invalid authorization specification'), {
        code: NON_RETRYABLE_ERROR_CODES.INVALID_AUTHORIZATION_SPECIFICATION,
      })

      const mockFn = vi.fn().mockRejectedValue(authSpecError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          operationName: 'test-auth-spec-fail',
        })
      ).rejects.toThrow('invalid authorization specification')

      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    // Non-retryable Data & Constraint Rejection
    it('should fail fast on unique constraint violation without retrying', async () => {
      const uniqueError = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: NON_RETRYABLE_ERROR_CODES.UNIQUE_VIOLATION,
      })

      const mockFn = vi.fn().mockRejectedValue(uniqueError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          operationName: 'test-unique',
        })
      ).rejects.toThrow('duplicate key value')

      expect(mockFn).toHaveBeenCalledTimes(1)
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
      expect(mockClient.release).toHaveBeenCalledTimes(1)
    })

    it('should fail fast on foreign key violation without retrying', async () => {
      const fkError = Object.assign(new Error('foreign key violation'), {
        code: NON_RETRYABLE_ERROR_CODES.FOREIGN_KEY_VIOLATION,
      })

      const mockFn = vi.fn().mockRejectedValue(fkError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          operationName: 'test-fk',
        })
      ).rejects.toThrow('foreign key violation')

      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should fail fast on not null violation without retrying', async () => {
      const notNullError = Object.assign(new Error('null value in column violates not-null constraint'), {
        code: NON_RETRYABLE_ERROR_CODES.NOT_NULL_VIOLATION,
      })

      const mockFn = vi.fn().mockRejectedValue(notNullError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 3,
          operationName: 'test-not-null',
        })
      ).rejects.toThrow('null value in column')

      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    // Retry Exhaustion: ConflictError vs MaxRetriesExhaustedError
    it('should throw ConflictError with retry metadata when concurrency conflict retries are exhausted', async () => {
      const serializationError = Object.assign(new Error('could not serialize access due to concurrent update'), {
        code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE,
      })

      const mockFn = vi.fn().mockRejectedValue(serializationError)

      let caught: unknown
      try {
        await withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 2,
          initialBackoffMs: 1,
          operationName: 'test-exhausted-conflict',
        })
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(ConflictError)
      const conflict = caught as ConflictError
      expect(conflict.conflictCode).toBe('serialization_failure')
      expect(conflict.attempts).toBe(2)
      expect(typeof conflict.retryAfterSeconds).toBe('number')
      expect(conflict.cause).toBe(serializationError)
      expect(mockFn).toHaveBeenCalledTimes(3) // initial + 2 retries
    })

    it('should throw ConflictError with lock_timeout conflictCode when 55P03 is exhausted', async () => {
      const lockError = Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      })

      const mockFn = vi.fn().mockRejectedValue(lockError)

      let caught: unknown
      try {
        await withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 1,
          initialBackoffMs: 1,
          operationName: 'test-exhausted-lock',
        })
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(ConflictError)
      expect((caught as ConflictError).conflictCode).toBe('lock_timeout')
      expect((caught as ConflictError).attempts).toBe(1)
    })

    it('should throw MaxRetriesExhaustedError when non-conflict transient error retries are exhausted', async () => {
      const connError = Object.assign(new Error('Connection reset by peer'), {
        errno: 'ECONNRESET',
      })

      const mockFn = vi.fn().mockRejectedValue(connError)

      let caught: unknown
      try {
        await withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 2,
          initialBackoffMs: 1,
          operationName: 'test-exhausted-network',
        })
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(MaxRetriesExhaustedError)
      expect(caught).not.toBeInstanceOf(ConflictError)
      const exhausted = caught as MaxRetriesExhaustedError
      expect(exhausted.attempts).toBe(2)
      expect(exhausted.lastError).toBe(connError)
      expect(exhausted.operationName).toBe('test-exhausted-network')
      expect(mockFn).toHaveBeenCalledTimes(3)
    })

    // Adverse condition: Rollback fails
    it('should release client even when rollback fails', async () => {
      const connError = Object.assign(new Error('Transient network error'), {
        errno: 'ECONNRESET',
      })

      const mockFn = vi.fn().mockRejectedValue(connError)
      const rollbackError = new Error('Rollback failed because connection died')

      vi.mocked(mockClient.query).mockImplementation((sql: string) => {
        if (sql === 'ROLLBACK') {
          return Promise.reject(rollbackError)
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      })

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 0,
          operationName: 'test-rollback-fail',
        })
      ).rejects.toThrow(MaxRetriesExhaustedError)

      expect(mockClient.release).toHaveBeenCalledTimes(1)
    })

    // Custom isRetryable predicate
    it('should respect custom isRetryable predicate option', async () => {
      const customError = new Error('CUSTOM_TRANSIENT_CONDITION')

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(customError)
        .mockResolvedValue('custom-predicate-success')

      const result = await withRetryableTransaction(mockPool, mockFn, {
        maxRetries: 2,
        initialBackoffMs: 1,
        isRetryable: (err) => (err as Error).message === 'CUSTOM_TRANSIENT_CONDITION',
        operationName: 'test-custom-predicate',
      })

      expect(result).toBe('custom-predicate-success')
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    // Sanitization of sensitive data in error messages
    it('should sanitize credentials in logged and constructed errors', async () => {
      const sensitiveError = Object.assign(
        new Error('Failed connecting with password=super_secret_db_password token=auth123'),
        { errno: 'ECONNRESET' }
      )

      const mockFn = vi.fn().mockRejectedValue(sensitiveError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 0,
          debugLogging: true,
          operationName: 'test-sanitization',
        })
      ).rejects.toThrow(MaxRetriesExhaustedError)

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: expect.not.stringContaining('super_secret_db_password'),
        })
      )
    })

    // Boundary configuration options
    it('should handle maxRetries = 0 by executing exactly 1 attempt', async () => {
      const serializationError = Object.assign(new Error('Serialization failure'), {
        code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE,
      })

      const mockFn = vi.fn().mockRejectedValue(serializationError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: 0,
          operationName: 'test-zero-retries',
        })
      ).rejects.toThrow(ConflictError)

      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should clamp negative maxRetries to 0', async () => {
      const serializationError = Object.assign(new Error('Serialization failure'), {
        code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE,
      })

      const mockFn = vi.fn().mockRejectedValue(serializationError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: -5,
          operationName: 'test-negative-retries',
        })
      ).rejects.toThrow(ConflictError)

      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should handle invalid NaN options safely with defaults', async () => {
      const connError = Object.assign(new Error('Connection reset'), {
        errno: 'ECONNRESET',
      })

      const mockFn = vi.fn().mockRejectedValue(connError)

      await expect(
        withRetryableTransaction(mockPool, mockFn, {
          maxRetries: NaN,
          initialBackoffMs: -10,
          maxBackoffMs: NaN,
          operationName: 'test-nan-options',
        })
      ).rejects.toThrow(MaxRetriesExhaustedError)

      // With default maxRetries = 3, initial attempt + 3 retries = 4
      expect(mockFn).toHaveBeenCalledTimes(4)
    })
  })

  // =========================================================================
  // 6. withRetryableTransactionManager: Boundaries & Contracts
  // =========================================================================
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

      const result = await withRetryableTransactionManager(mockTransactionManager, mockFn, {
        operationName: 'test-tm-first',
      })

      expect(result).toBe('success')
      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(1)
      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('should retry on serialization failure and recover', async () => {
      const serializationError = Object.assign(new Error('Serialization failure'), {
        code: RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE,
      })

      const mockFn = vi.fn().mockResolvedValue('tm-recovered')

      vi.mocked(mockTransactionManager.withTransaction)
        .mockRejectedValueOnce(serializationError)
        .mockImplementation((fn) => fn({} as any))

      const result = await withRetryableTransactionManager(mockTransactionManager, mockFn, {
        maxRetries: 2,
        initialBackoffMs: 1,
        operationName: 'test-tm-ser-recovery',
      })

      expect(result).toBe('tm-recovered')
      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(2)
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('succeeded after 1 retries'),
          attempts: 1,
        })
      )
    })

    it('should fail fast on permission error (42501)', async () => {
      const permError = Object.assign(new Error('permission denied'), {
        code: NON_RETRYABLE_ERROR_CODES.INSUFFICIENT_PRIVILEGE,
      })

      vi.mocked(mockTransactionManager.withTransaction).mockRejectedValue(permError)

      await expect(
        withRetryableTransactionManager(mockTransactionManager, vi.fn(), {
          maxRetries: 3,
          operationName: 'test-tm-perm-fail',
        })
      ).rejects.toThrow('permission denied')

      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(1)
    })

    it('should throw ConflictError when deadlock conflict retries are exhausted', async () => {
      const deadlockError = Object.assign(new Error('Deadlock detected'), {
        code: RETRYABLE_ERROR_CODES.DEADLOCK_DETECTED,
      })

      vi.mocked(mockTransactionManager.withTransaction).mockRejectedValue(deadlockError)

      let caught: unknown
      try {
        await withRetryableTransactionManager(mockTransactionManager, vi.fn(), {
          maxRetries: 2,
          initialBackoffMs: 1,
          operationName: 'test-tm-deadlock-exhausted',
        })
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(ConflictError)
      expect((caught as ConflictError).conflictCode).toBe('deadlock')
      expect((caught as ConflictError).attempts).toBe(2)
      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(3)
    })

    it('should throw MaxRetriesExhaustedError when network error retries are exhausted', async () => {
      const connError = Object.assign(new Error('Connection reset'), {
        errno: 'ECONNRESET',
      })

      vi.mocked(mockTransactionManager.withTransaction).mockRejectedValue(connError)

      let caught: unknown
      try {
        await withRetryableTransactionManager(mockTransactionManager, vi.fn(), {
          maxRetries: 2,
          initialBackoffMs: 1,
          operationName: 'test-tm-conn-exhausted',
        })
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(MaxRetriesExhaustedError)
      expect(caught).not.toBeInstanceOf(ConflictError)
      expect((caught as MaxRetriesExhaustedError).attempts).toBe(2)
      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(3)
    })

    it('should respect custom isRetryable predicate', async () => {
      const customTransientError = new Error('SPECIAL_RETRYABLE_ERROR')

      const mockFn = vi.fn().mockResolvedValue('tm-custom-predicate-ok')

      vi.mocked(mockTransactionManager.withTransaction)
        .mockRejectedValueOnce(customTransientError)
        .mockImplementation((fn) => fn({} as any))

      const result = await withRetryableTransactionManager(mockTransactionManager, mockFn, {
        maxRetries: 2,
        initialBackoffMs: 1,
        isRetryable: (err) => (err as Error).message === 'SPECIAL_RETRYABLE_ERROR',
        operationName: 'test-tm-custom',
      })

      expect(result).toBe('tm-custom-predicate-ok')
      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(2)
    })

    it('should clamp boundary maxRetries = 0 and negative values safely', async () => {
      const connError = Object.assign(new Error('ETIMEDOUT'), { errno: 'ETIMEDOUT' })
      vi.mocked(mockTransactionManager.withTransaction).mockRejectedValue(connError)

      await expect(
        withRetryableTransactionManager(mockTransactionManager, vi.fn(), {
          maxRetries: -3,
          operationName: 'test-tm-negative',
        })
      ).rejects.toThrow(MaxRetriesExhaustedError)

      expect(mockTransactionManager.withTransaction).toHaveBeenCalledTimes(1)
    })
  })

  // =========================================================================
  // 7. Error Classes: MaxRetriesExhaustedError & ConflictError Metadata
  // =========================================================================
  describe('Error Classes', () => {
    it('MaxRetriesExhaustedError should preserve attempts, lastError, and operationName', () => {
      const cause = new Error('connection lost')
      const err = new MaxRetriesExhaustedError(3, cause, 'charge-wallet')

      expect(err.name).toBe('MaxRetriesExhaustedError')
      expect(err.attempts).toBe(3)
      expect(err.lastError).toBe(cause)
      expect(err.operationName).toBe('charge-wallet')
      expect(err.message).toContain('Max retries (3) exhausted for charge-wallet: connection lost')
    })

    it('ConflictError should preserve ConflictRetryInfo and cause', () => {
      const cause = new Error('conflict detected')
      const err = new ConflictError(
        'conflict failure',
        {
          retryAfterSeconds: 2,
          attempts: 3,
          conflictCode: 'optimistic_lock',
        },
        cause
      )

      expect(err.name).toBe('ConflictError')
      expect(err.retryAfterSeconds).toBe(2)
      expect(err.attempts).toBe(3)
      expect(err.conflictCode).toBe('optimistic_lock')
      expect(err.cause).toBe(cause)
      expect(err.message).toBe('conflict failure')
    })
  })
})
