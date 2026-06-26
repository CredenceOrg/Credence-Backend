/**
 * @module jobs/idempotencyKeySweeper
 * @description Background job to clean up expired idempotency keys.
 * 
 * Runs periodically to remove keys that have passed their TTL,
 * preventing unbounded growth of the idempotency_keys table.
 */

import type { Queryable } from '../db/repositories/queryable.js'

export interface IdempotencySweeperConfig {
  /** Run interval in milliseconds (default: 3600000 = 1 hour) */
  intervalMs?: number
  /** Maximum number of keys to delete per run (default: 10000) */
  batchSize?: number
  /** Enable dry-run mode (count but don't delete) */
  dryRun?: boolean
  /** Logger function */
  logger?: (message: string) => void
}

export interface SweeperResult {
  /** Number of expired keys found */
  expiredCount: number
  /** Number of keys deleted */
  deletedCount: number
  /** Whether this was a dry run */
  dryRun: boolean
  /** Duration in milliseconds */
  durationMs: number
}

/**
 * Background job that periodically deletes expired idempotency keys.
 * 
 * The sweeper:
 * 1. Counts keys where expires_at <= NOW()
 * 2. Deletes them in batches to avoid long-running transactions
 * 3. Logs the results for monitoring
 * 
 * @example
 * ```typescript
 * const sweeper = new IdempotencyKeySweeper(db, {
 *   intervalMs: 3600000, // Run every hour
 *   batchSize: 10000,
 *   logger: console.log,
 * })
 * 
 * // Start the periodic job
 * sweeper.start()
 * 
 * // Or run once manually
 * const result = await sweeper.run()
 * console.log(`Deleted ${result.deletedCount} expired keys`)
 * ```
 */
export class IdempotencyKeySweeper {
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly dryRun: boolean
  private readonly logger: (message: string) => void
  private interval: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly db: Queryable,
    config: IdempotencySweeperConfig = {}
  ) {
    this.intervalMs = config.intervalMs ?? 3600000 // 1 hour default
    this.batchSize = config.batchSize ?? 10000
    this.dryRun = config.dryRun ?? false
    this.logger = config.logger ?? (() => {})
  }

  /**
   * Start the periodic sweeper job.
   */
  start(): void {
    if (this.interval) {
      this.logger('[IdempotencySweeper] Already running')
      return
    }

    this.logger(`[IdempotencySweeper] Starting periodic cleanup every ${this.intervalMs}ms`)
    
    // Run immediately on start
    this.run().catch((err) => {
      this.logger(`[IdempotencySweeper] Error in initial run: ${err}`)
    })

    // Schedule periodic runs
    this.interval = setInterval(() => {
      this.run().catch((err) => {
        this.logger(`[IdempotencySweeper] Error in scheduled run: ${err}`)
      })
    }, this.intervalMs)
  }

  /**
   * Stop the periodic sweeper job.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
      this.logger('[IdempotencySweeper] Stopped')
    }
  }

  /**
   * Run a single cleanup cycle.
   * 
   * @returns Result containing counts of expired and deleted keys
   */
  async run(): Promise<SweeperResult> {
    if (this.running) {
      this.logger('[IdempotencySweeper] Already running, skipping')
      return { expiredCount: 0, deletedCount: 0, dryRun: this.dryRun, durationMs: 0 }
    }

    this.running = true
    const startTime = Date.now()

    try {
      // Count expired keys
      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM idempotency_keys WHERE expires_at <= NOW()`
      )
      
      const expiredCount = parseInt(countResult.rows[0]?.count ?? '0', 10)

      this.logger(
        `[IdempotencySweeper] Found ${expiredCount} expired keys${this.dryRun ? ' (dry-run)' : ''}`
      )

      let deletedCount = 0

      if (!this.dryRun && expiredCount > 0) {
        // Delete in batches
        let remaining = expiredCount
        
        while (remaining > 0) {
          const deleteResult = await this.db.query(
            `
            DELETE FROM idempotency_keys
            WHERE ctid IN (
              SELECT ctid FROM idempotency_keys
              WHERE expires_at <= NOW()
              LIMIT $1
            )
            `,
            [this.batchSize]
          )
          
          const batchDeleted = deleteResult.rowCount ?? 0
          deletedCount += batchDeleted
          remaining -= batchDeleted

          if (batchDeleted > 0) {
            this.logger(
              `[IdempotencySweeper] Deleted batch of ${batchDeleted} keys (total: ${deletedCount})`
            )
          }

          // Stop if we deleted fewer than batch size (no more expired keys)
          if (batchDeleted < this.batchSize) {
            break
          }
        }
      }

      const durationMs = Date.now() - startTime
      
      this.logger(
        `[IdempotencySweeper] Completed: expired=${expiredCount} deleted=${deletedCount} duration=${durationMs}ms`
      )

      return {
        expiredCount,
        deletedCount,
        dryRun: this.dryRun,
        durationMs,
      }
    } catch (error) {
      const durationMs = Date.now() - startTime
      this.logger(
        `[IdempotencySweeper] Error after ${durationMs}ms: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    } finally {
      this.running = false
    }
  }

  /**
   * Check if the sweeper is currently running.
   */
  isRunning(): boolean {
    return this.running
  }
}

/**
 * Standalone function to run a single cleanup cycle.
 * Useful for one-off executions or testing.
 */
export async function sweepExpiredIdempotencyKeys(
  db: Queryable,
  config?: IdempotencySweeperConfig
): Promise<SweeperResult> {
  const sweeper = new IdempotencyKeySweeper(db, config)
  return sweeper.run()
}
