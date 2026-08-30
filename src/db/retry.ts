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
 * Retry contract metadata attached to conflict errors.
 *
 * When a concurrent-write conflict is detected (optimistic lock, lock timeout,
 * or serialization failure), callers receive this information to decide whether
 * to retry immediately or surface a `Retry-After` header to the HTTP client.
 *
 * @example HTTP handler usage:
 * ```typescript
 * } catch (err) {
 *   if (err instanceof ConflictError) {
 *     res.set('Retry-After', String(err.retryAfterSeconds))
 *     return res.status(409).json({ error: err.message, code: err.conflictCode })
 *   }
 * }
 * ```
 */
export interface ConflictRetryInfo {
  /**
   * Recommended delay in seconds before the client retries the operation.
   * Derived from the last backoff window used internally.
   */
  retryAfterSeconds: number
  /**
   * Number of attempts that were made before giving up.
   */
  attempts: number
  /**
   * Machine-readable conflict classification.
   * - `'serialization_failure'` – concurrent transaction conflict (PG 40001)
   * - `'deadlock'`              – deadlock detected (PG 40P01)
   * - `'lock_timeout'`          – row lock not acquired in time (PG 55P03)
   * - `'optimistic_lock'`       – application-level version mismatch
   */
  conflictCode: 'serialization_failure' | 'deadlock' | 'lock_timeout' | 'optimistic_lock'
}

/**
 * Thrown when a concurrency conflict cannot be resolved after all retries are
 * exhausted, OR when a conflict error needs to be surfaced to an HTTP caller
 * with explicit `Retry-After` semantics.
 *
 * Distinct from `MaxRetriesExhaustedError` in that it carries structured
 * conflict metadata the HTTP layer can use to set `Retry-After` and return
 * a `409 Conflict` with a stable `conflictCode`.
 */
export class ConflictError extends Error implements ConflictRetryInfo {
  public readonly retryAfterSeconds: number
  public readonly attempts: number
  public readonly conflictCode: ConflictRetryInfo['conflictCode']

  constructor(
    message: string,
    info: ConflictRetryInfo,
    public readonly cause?: Error,
  ) {
    super(message)
    this.name = 'ConflictError'
    this.retryAfterSeconds = info.retryAfterSeconds
    this.attempts = info.attempts
    this.conflictCode = info.conflictCode
  }
}

/**
 * Checks if an error is a transient PostgreSQL error that should be retried.
 *
 * Includes PG code 55P03 (lock_not_available / lock_timeout) so that
 * `withRetryableTransaction` retries on lock contention and—after exhausting
 * all attempts—surfaces a `ConflictError` with `conflictCode = 'lock_timeout'`
 * instead of re-throwing the raw PG error.  This mirrors the semantics already
 * in place for serialization failures and deadlocks.
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

    // Lock timeout (55P03) is a retryable concurrency conflict.
    // classifyConflict() already maps it to 'lock_timeout'; we must also
    // declare it retryable so the retry loop does not exit early.
    if (pgError.code === '55P03') {
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
 * Maps a raw error to a machine-readable `conflictCode` for `ConflictError`.
 * Returns `undefined` for errors that are not conflict-related.
 */
export function classifyConflict(error: unknown): ConflictRetryInfo['conflictCode'] | undefined {
  if (!error || typeof error !== 'object') return undefined
  const pg = error as { code?: string }
  switch (pg.code) {
    case RETRYABLE_ERROR_CODES.SERIALIZATION_FAILURE:
    case RETRYABLE_ERROR_CODES.TRANSACTION_ROLLBACK:
    case RETRYABLE_ERROR_CODES.TRANSACTION_INTEGRITY_CONSTRAINT_VIOLATION:
    case RETRYABLE_ERROR_CODES.TRANSACTION_COMPLETION_UNKNOWN:
      return 'serialization_failure'
    case RETRYABLE_ERROR_CODES.DEADLOCK_DETECTED:
      return 'deadlock'
    case '55P03': // lock_timeout (PG_LOCK_TIMEOUT_CODE)
      return 'lock_timeout'
    default:
      return undefined
  }
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
  let lastBackoffMs = 0
  let lastConflictCode: ConflictRetryInfo['conflictCode'] | undefined

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
      lastConflictCode = classifyConflict(error) ?? lastConflictCode

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

        // Surface a ConflictError with retry-after semantics when the failure
        // was due to a concurrency conflict (serialization failure, deadlock,
        // or lock timeout). This allows HTTP handlers to set Retry-After and
        // return 409 rather than an opaque 500.
        if (lastConflictCode) {
          throw new ConflictError(
            `${operationName} failed after ${attempt} retries due to concurrent conflict: ${lastError.message}`,
            {
              retryAfterSeconds: Math.ceil(lastBackoffMs / 1000) || 1,
              attempts: attempt,
              conflictCode: lastConflictCode,
            },
            lastError,
          )
        }

        throw new MaxRetriesExhaustedError(attempt, lastError, operationName)
      }

      // Calculate backoff and retry
      lastBackoffMs = calculateBackoffMs(attempt, initialBackoffMs, maxBackoffMs)

      if (debugLogging) {
        logger.debug({
          message: `${operationName} attempt ${attempt + 1} failed, retrying after ${lastBackoffMs}ms`,
          operationName,
          attempt: attempt + 1,
          maxRetries,
          backoffMs: lastBackoffMs,
          errorCode: (error as any)?.code,
          errorMessage: lastError.message,
        })
      }

      await sleep(lastBackoffMs)
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
  let lastBackoffMs = 0
  let lastConflictCode: ConflictRetryInfo['conflictCode'] | undefined

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
      lastConflictCode = classifyConflict(error) ?? lastConflictCode

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

        // Surface a ConflictError with retry-after semantics when exhausted
        // due to a concurrency conflict.
        if (lastConflictCode) {
          throw new ConflictError(
            `${operationName} failed after ${attempt} retries due to concurrent conflict: ${lastError.message}`,
            {
              retryAfterSeconds: Math.ceil(lastBackoffMs / 1000) || 1,
              attempts: attempt,
              conflictCode: lastConflictCode,
            },
            lastError,
          )
        }

        throw new MaxRetriesExhaustedError(attempt, lastError, operationName)
      }

      // Calculate backoff and retry
      lastBackoffMs = calculateBackoffMs(attempt, initialBackoffMs, maxBackoffMs)
      
      if (debugLogging) {
        logger.debug({
          message: `${operationName} attempt ${attempt + 1} failed, retrying after ${lastBackoffMs}ms`,
          operationName,
          attempt: attempt + 1,
          maxRetries,
          backoffMs: lastBackoffMs,
          errorCode: (error as any)?.code,
          errorMessage: lastError.message,
        })
      }

      await sleep(lastBackoffMs)
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
