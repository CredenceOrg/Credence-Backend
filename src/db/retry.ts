import { type PoolClient } from 'pg'
import { logger } from '../utils/logger.js'

/**
 * PostgreSQL error codes that indicate transient, retryable failures.
 * These errors can occur due to concurrent transactions and should be retried.
 */
export const RETRYABLE_ERROR_CODES = {
  /** Serialization failure - concurrent transaction conflict */
  SERIALIZATION_FAILURE: '40001',
  /** Deadlock detected - transactions waiting on each other */
  DEADLOCK_DETECTED: '40P01',
  /** Transaction rollback */
  TRANSACTION_ROLLBACK: '40000',
  /** Transaction integrity constraint violation due to concurrent access */
  TRANSACTION_INTEGRITY_CONSTRAINT_VIOLATION: '40002',
  /** Transaction completion unknown (e.g., network failure during commit) */
  TRANSACTION_COMPLETION_UNKNOWN: '40003',
} as const

/**
 * Network error codes that indicate transient connection issues.
 */
export const TRANSIENT_NETWORK_ERRORS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
] as const

/**
 * Non-retryable error codes that indicate permanent failures.
 * These should fail fast without retrying.
 */
export const NON_RETRYABLE_ERROR_CODES = {
  /** Unique constraint violation */
  UNIQUE_VIOLATION: '23505',
  /** Foreign key constraint violation */
  FOREIGN_KEY_VIOLATION: '23503',
  /** Not null constraint violation */
  NOT_NULL_VIOLATION: '23502',
  /** Check constraint violation */
  CHECK_VIOLATION: '23514',
  /** Invalid text representation */
  INVALID_TEXT_REPRESENTATION: '22P02',
  /** Numeric value out of range */
  NUMERIC_VALUE_OUT_OF_RANGE: '22003',
  /** Division by zero */
  DIVISION_BY_ZERO: '22012',
  /** Invalid parameter value */
  INVALID_PARAMETER_VALUE: '22023',
  /** Undefined column */
  UNDEFINED_COLUMN: '42703',
  /** Undefined table */
  UNDEFINED_TABLE: '42P01',
} as const

/**
 * Configuration options for retryable transactions.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Initial backoff delay in milliseconds (default: 50) */
  initialBackoffMs?: number
  /** Maximum backoff delay in milliseconds (default: 1000) */
  maxBackoffMs?: number
  /** Human-readable operation name for logging (default: 'database operation') */
  operationName?: string
  /** Enable debug logging of retry attempts (default: false) */
  debugLogging?: boolean
}

/**
 * Error thrown when max retries are exhausted.
 */
export class MaxRetriesExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: Error,
    public readonly operationName: string,
  ) {
    super(
      `Max retries (${attempts}) exhausted for ${operationName}: ${lastError.message}`
    )
    this.name = 'MaxRetriesExhaustedError'
  }
}

/**
 * Checks if an error is a transient PostgreSQL error that should be retried.
 */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const pgError = error as { code?: string; errno?: string; syscall?: string }

  // Check for retryable PostgreSQL error codes
  if (pgError.code) {
    const retryableCodes = Object.values(RETRYABLE_ERROR_CODES)
    if (retryableCodes.includes(pgError.code as any)) {
      return true
    }

    // Fast-fail on non-retryable constraint violations
    const nonRetryableCodes = Object.values(NON_RETRYABLE_ERROR_CODES)
    if (nonRetryableCodes.includes(pgError.code as any)) {
      return false
    }
  }

  // Check for transient network errors
  if (pgError.errno) {
    const transientErrors = TRANSIENT_NETWORK_ERRORS as readonly string[]
    if (transientErrors.includes(pgError.errno)) {
      return true
    }
  }

  return false
}

/**
 * Calculates exponential backoff delay with full jitter.
 * 
 * Formula: delay = random(0, min(maxBackoffMs, initialBackoffMs * 2^attempt))
 * 
 * Full jitter prevents thundering herd problems where many clients
 * retry simultaneously after a transient failure.
 */
export function calculateBackoffMs(
  attempt: number,
  initialBackoffMs: number,
  maxBackoffMs: number
): number {
  const exponentialDelay = initialBackoffMs * Math.pow(2, attempt)
  const cappedDelay = Math.min(maxBackoffMs, exponentialDelay)
  // Full jitter: random value between 0 and cappedDelay
  return Math.floor(Math.random() * cappedDelay)
}

/**
 * Sleep for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wraps a database transaction function with exponential backoff retry logic.
 * 
 * This function automatically retries transient PostgreSQL errors (serialization
 * failures, deadlocks, connection timeouts) while failing fast on permanent
 * errors (constraint violations, invalid data).
 * 
 * **CRITICAL IDEMPOTENCY REQUIREMENT:**
 * The `fn` callback MUST be idempotent. It will be re-executed multiple times
 * on transient failures. Any side effects (sending emails, webhooks, calling
 * external APIs) MUST occur AFTER the transaction commits successfully, not
 * inside the retried block.
 * 
 * @example
 * ```typescript
 * const result = await withRetryableTransaction(
 *   pool,
 *   async (client) => {
 *     // This block may execute multiple times
 *     const result = await repository.updateBalance(client, userId, amount)
 *     return result
 *   },
 *   { maxRetries: 5, operationName: 'update-user-balance' }
 * )
 * // Side effects go here, after successful commit
 * await sendNotification(result)
 * ```
 * 
 * @param pool - PostgreSQL connection pool
 * @param fn - Idempotent transaction function to execute
 * @param options - Retry configuration options
 * @returns Result from the transaction function
 * @throws {MaxRetriesExhaustedError} When max retries are exhausted
 * @throws {Error} When a non-retryable error occurs
 */
export async function withRetryableTransaction<T>(
  pool: { connect(): Promise<PoolClient> },
  fn: (client: PoolClient) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialBackoffMs = 50,
    maxBackoffMs = 1000,
    operationName = 'database operation',
    debugLogging = false,
  } = options

  let lastError: Error | undefined
  let attempt = 0

  while (attempt <= maxRetries) {
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')

      // Success! Log if this was a retry
      if (attempt > 0) {
        logger.info({
          message: `${operationName} succeeded after ${attempt} retries`,
          operationName,
          attempts: attempt,
        })
      }

      return result
    } catch (error) {
      // Always rollback on error
      await client.query('ROLLBACK').catch(() => {
        // Swallow rollback errors - connection may be dead
      })

      lastError = error instanceof Error ? error : new Error(String(error))

      // Check if this is a retryable error
      if (!isRetryableError(error)) {
        if (debugLogging) {
          logger.debug({
            message: `${operationName} failed with non-retryable error`,
            operationName,
            errorCode: (error as any)?.code,
            errorMessage: lastError.message,
          })
        }
        throw error
      }

      // Check if we've exhausted retries
      if (attempt >= maxRetries) {
        logger.warn({
          message: `${operationName} failed after ${attempt} retries`,
          operationName,
          attempts: attempt,
          errorCode: (error as any)?.code,
          errorMessage: lastError.message,
        })
        throw new MaxRetriesExhaustedError(attempt, lastError, operationName)
      }

      // Calculate backoff and retry
      const backoffMs = calculateBackoffMs(attempt, initialBackoffMs, maxBackoffMs)
      
      if (debugLogging) {
        logger.debug({
          message: `${operationName} attempt ${attempt + 1} failed, retrying after ${backoffMs}ms`,
          operationName,
          attempt: attempt + 1,
          maxRetries,
          backoffMs,
          errorCode: (error as any)?.code,
          errorMessage: lastError.message,
        })
      }

      await sleep(backoffMs)
      attempt++
    } finally {
      client.release()
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new MaxRetriesExhaustedError(
    attempt,
    lastError ?? new Error('Unknown error'),
    operationName
  )
}

/**
 * Wrapper for TransactionManager.withTransaction that adds retry logic.
 * 
 * This allows existing code using TransactionManager to opt-in to retry
 * behavior without major refactoring.
 * 
 * @example
 * ```typescript
 * import { withRetryableTransactionManager } from './db/retry.js'
 * 
 * const result = await withRetryableTransactionManager(
 *   transactionManager,
 *   async (client) => {
 *     return await repository.criticalWrite(client, data)
 *   },
 *   { maxRetries: 5 }
 * )
 * ```
 */
export async function withRetryableTransactionManager<T>(
  transactionManager: { withTransaction: <R>(fn: (client: PoolClient) => Promise<R>, options?: any) => Promise<R> },
  fn: (client: PoolClient) => Promise<T>,
  retryOptions: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialBackoffMs = 50,
    maxBackoffMs = 1000,
    operationName = 'database operation',
    debugLogging = false,
  } = retryOptions

  let lastError: Error | undefined
  let attempt = 0

  while (attempt <= maxRetries) {
    try {
      const result = await transactionManager.withTransaction(fn)

      // Success! Log if this was a retry
      if (attempt > 0) {
        logger.info({
          message: `${operationName} succeeded after ${attempt} retries`,
          operationName,
          attempts: attempt,
        })
      }

      return result
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Check if this is a retryable error
      if (!isRetryableError(error)) {
        if (debugLogging) {
          logger.debug({
            message: `${operationName} failed with non-retryable error`,
            operationName,
            errorCode: (error as any)?.code,
            errorMessage: lastError.message,
          })
        }
        throw error
      }

      // Check if we've exhausted retries
      if (attempt >= maxRetries) {
        logger.warn({
          message: `${operationName} failed after ${attempt} retries`,
          operationName,
          attempts: attempt,
          errorCode: (error as any)?.code,
          errorMessage: lastError.message,
        })
        throw new MaxRetriesExhaustedError(attempt, lastError, operationName)
      }

      // Calculate backoff and retry
      const backoffMs = calculateBackoffMs(attempt, initialBackoffMs, maxBackoffMs)
      
      if (debugLogging) {
        logger.debug({
          message: `${operationName} attempt ${attempt + 1} failed, retrying after ${backoffMs}ms`,
          operationName,
          attempt: attempt + 1,
          maxRetries,
          backoffMs,
          errorCode: (error as any)?.code,
          errorMessage: lastError.message,
        })
      }

      await sleep(backoffMs)
      attempt++
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new MaxRetriesExhaustedError(
    attempt,
    lastError ?? new Error('Unknown error'),
    operationName
  )
}
