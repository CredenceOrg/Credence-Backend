/**
 * @module lib/idempotencyGuard
 * @description Idempotent guard for at-least-once message processing.
 * 
 * Prevents duplicate side effects when the same message is delivered more than once
 * by persisting processed-message markers in Redis with TTL-based expiration.
 * 
 * @example
 * ```ts
 * const guard = new IdempotencyGuard(cacheService, { ttlSeconds: 86400 })
 * 
 * const result = await guard.process('attestation', messageId, async () => {
 *   // Side effect logic here
 *   return await store.create(data)
 * })
 * 
 * if (result.executed) {
 *   console.log('Processed:', result.value)
 * } else {
 *   console.log('Duplicate skipped')
 * }
 * ```
 */

import type { CacheService } from '../cache/redis.js'
import { recordIdempotencyCheck } from '../middleware/metrics.js'

/**
 * Result of an idempotent operation.
 */
export interface IdempotentResult<T> {
  /** Whether the handler was executed (false if duplicate). */
  executed: boolean
  /** Return value from handler if executed, undefined otherwise. */
  value?: T
  /** Whether this was a duplicate message. */
  isDuplicate: boolean
}

/**
 * Configuration for idempotency guard.
 */
export interface IdempotencyGuardConfig {
  /** TTL for processed message markers in seconds (default: 86400 = 24 hours). */
  ttlSeconds?: number
  /** Optional logger function for debugging. */
  logger?: (message: string) => void
}

/**
 * Metrics for idempotency guard operations.
 */
export interface IdempotencyMetrics {
  /** Total number of messages processed. */
  processed: number
  /** Number of duplicate messages detected. */
  duplicates: number
  /** Number of new messages executed. */
  executed: number
  /** Number of errors during guard operations. */
  errors: number
}

/**
 * Idempotent guard for at-least-once message processing.
 * 
 * Uses Redis to persist processed-message markers with TTL, ensuring that
 * duplicate message deliveries are detected and skipped even across restarts.
 * 
 * The guard is keyed by handler type and message ID, allowing different
 * handlers to process the same message independently.
 */
export class IdempotencyGuard {
  private readonly ttlSeconds: number
  private readonly logger: (message: string) => void
  private readonly metrics: IdempotencyMetrics = {
    processed: 0,
    duplicates: 0,
    executed: 0,
    errors: 0,
  }

  constructor(
    private readonly cache: CacheService,
    config: IdempotencyGuardConfig = {}
  ) {
    this.ttlSeconds = config.ttlSeconds ?? 86400 // 24 hours default
    this.logger = config.logger ?? (() => {})
  }

  /**
   * Process a message idempotently.
   * 
   * Checks if the message has been processed before. If not, executes the handler
   * and marks the message as processed. If the message was already processed,
   * short-circuits and returns without executing the handler.
   * 
   * @param handlerType - Type of handler (e.g., 'attestation', 'withdrawal', 'webhook')
   * @param messageId - Unique message identifier
   * @param handler - Async function to execute if message is new
   * @returns Result indicating whether handler was executed and its return value
   */
  async process<T>(
    handlerType: string,
    messageId: string,
    handler: () => Promise<T>
  ): Promise<IdempotentResult<T>> {
    this.metrics.processed++

    const markerKey = this.getMarkerKey(handlerType, messageId)

    try {
      // Check if message was already processed
      const exists = await this.cache.exists('idempotency', markerKey)

      if (exists) {
        this.metrics.duplicates++
        this.logger(`[IdempotencyGuard] Duplicate detected: ${handlerType}:${messageId}`)
        
        // Track duplicate in metrics
        try {
          recordIdempotencyCheck(handlerType, 'duplicate')
        } catch {
          // Metrics failure should not affect processing
        }
        
        return {
          executed: false,
          isDuplicate: true,
        }
      }

      // Mark as processing (write marker BEFORE executing handler for safety)
      const marked = await this.cache.set(
        'idempotency',
        markerKey,
        { processedAt: new Date().toISOString() },
        this.ttlSeconds
      )

      if (!marked) {
        this.metrics.errors++
        this.logger(`[IdempotencyGuard] Failed to write marker: ${handlerType}:${messageId}`)
        // Proceed anyway to avoid blocking on Redis failures
      }

      // Execute handler
      const value = await handler()
      this.metrics.executed++
      this.logger(`[IdempotencyGuard] Executed: ${handlerType}:${messageId}`)

      // Track execution in metrics
      try {
        recordIdempotencyCheck(handlerType, 'executed')
      } catch {
        // Metrics failure should not affect processing
      }

      return {
        executed: true,
        value,
        isDuplicate: false,
      }
    } catch (error) {
      this.metrics.errors++
      this.logger(
        `[IdempotencyGuard] Error processing ${handlerType}:${messageId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
      throw error
    }
  }

  /**
   * Check if a message has been processed without executing handler.
   * 
   * @param handlerType - Type of handler
   * @param messageId - Unique message identifier
   * @returns True if message was already processed
   */
  async isProcessed(handlerType: string, messageId: string): Promise<boolean> {
    const markerKey = this.getMarkerKey(handlerType, messageId)
    try {
      return await this.cache.exists('idempotency', markerKey)
    } catch (error) {
      this.metrics.errors++
      this.logger(
        `[IdempotencyGuard] Error checking processed status: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
      return false // Fail open to avoid blocking
    }
  }

  /**
   * Manually mark a message as processed (useful for migration or recovery).
   * 
   * @param handlerType - Type of handler
   * @param messageId - Unique message identifier
   * @returns True if marker was set successfully
   */
  async markAsProcessed(handlerType: string, messageId: string): Promise<boolean> {
    const markerKey = this.getMarkerKey(handlerType, messageId)
    try {
      return await this.cache.set(
        'idempotency',
        markerKey,
        { processedAt: new Date().toISOString() },
        this.ttlSeconds
      )
    } catch (error) {
      this.metrics.errors++
      this.logger(
        `[IdempotencyGuard] Error marking as processed: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
      return false
    }
  }

  /**
   * Get current metrics snapshot.
   */
  getMetrics(): Readonly<IdempotencyMetrics> {
    return { ...this.metrics }
  }

  /**
   * Reset metrics (useful for testing).
   */
  resetMetrics(): void {
    this.metrics.processed = 0
    this.metrics.duplicates = 0
    this.metrics.executed = 0
    this.metrics.errors = 0
  }

  /**
   * Generate Redis key for processed message marker.
   */
  private getMarkerKey(handlerType: string, messageId: string): string {
    return `${handlerType}:${messageId}`
  }
}
