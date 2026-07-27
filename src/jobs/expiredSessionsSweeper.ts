/**
 * @module jobs/expiredSessionsSweeper
 * @description Background job that periodically deletes expired session rows
 * (idempotent_job_attempts) from the database.
 *
 * Rows whose `expires_at` has passed are removed in configurable batches
 * to avoid long-running transactions and lock contention.
 *
 * The TTL applied when inserting rows is governed by `SESSION_TTL_SECONDS`
 * (see {@link config/constants}).  This sweeper only reads `expires_at` so
 * it stays correct regardless of how the TTL was set at write time.
 */

import type { Queryable } from '../db/repositories/queryable.js'

export interface ExpiredSessionsSweeperConfig {
  /** Run interval in milliseconds (default: 3 600 000 = 1 hour). */
  intervalMs?: number
  /** Maximum rows to delete per batch (default: 5 000). */
  batchSize?: number
  /** When true, count but do not delete. Default: false. */
  dryRun?: boolean
  /** Logger function. */
  logger?: (message: string) => void
}

export interface SweeperResult {
  /** Number of expired rows found before deletion. */
  expiredCount: number
  /** Number of rows actually deleted. */
  deletedCount: number
  /** Whether this was a dry run. */
  dryRun: boolean
  /** Wall-clock duration in milliseconds. */
  durationMs: number
}

/**
 * Periodically sweeps `idempotent_job_attempts` rows whose `expires_at`
 * has passed.
 *
 * @example
 * ```typescript
 * const sweeper = new ExpiredSessionsSweeper(db, {
 *   intervalMs: 3_600_000,
 *   batchSize: 5_000,
 *   logger: console.log,
 * })
 *
 * sweeper.start()
 * // …
 * sweeper.stop()
 * ```
 */
export class ExpiredSessionsSweeper {
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly dryRun: boolean
  private readonly logger: (message: string) => void
  private interval: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly db: Queryable,
    config: ExpiredSessionsSweeperConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 3_600_000
    this.batchSize = config.batchSize ?? 5_000
    this.dryRun = config.dryRun ?? false
    this.logger = config.logger ?? (() => {})
  }

  /** Start the periodic sweeper. */
  start(): void {
    if (this.interval) {
      this.logger('[ExpiredSessionsSweeper] Already running')
      return
    }

    this.logger(
      `[ExpiredSessionsSweeper] Starting periodic cleanup every ${this.intervalMs}ms`,
    )

    this.run().catch((err) => {
      this.logger(`[ExpiredSessionsSweeper] Error in initial run: ${err}`)
    })

    this.interval = setInterval(() => {
      this.run().catch((err) => {
        this.logger(`[ExpiredSessionsSweeper] Error in scheduled run: ${err}`)
      })
    }, this.intervalMs)
  }

  /** Stop the periodic sweeper. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
      this.logger('[ExpiredSessionsSweeper] Stopped')
    }
  }

  /** Execute a single cleanup cycle. */
  async run(): Promise<SweeperResult> {
    if (this.running) {
      this.logger('[ExpiredSessionsSweeper] Already running, skipping')
      return { expiredCount: 0, deletedCount: 0, dryRun: this.dryRun, durationMs: 0 }
    }

    this.running = true
    const startTime = Date.now()

    try {
      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM idempotent_job_attempts
         WHERE expires_at <= NOW()`,
      )

      const expiredCount = parseInt(countResult.rows[0]?.count ?? '0', 10)

      this.logger(
        `[ExpiredSessionsSweeper] Found ${expiredCount} expired session rows${this.dryRun ? ' (dry-run)' : ''}`,
      )

      let deletedCount = 0

      if (!this.dryRun && expiredCount > 0) {
        let remaining = expiredCount

        while (remaining > 0) {
          const deleteResult = await this.db.query(
            `DELETE FROM idempotent_job_attempts
             WHERE ctid IN (
               SELECT ctid FROM idempotent_job_attempts
               WHERE expires_at <= NOW()
               LIMIT $1
             )`,
            [this.batchSize],
          )

          const batchDeleted = deleteResult.rowCount ?? 0
          deletedCount += batchDeleted
          remaining -= batchDeleted

          if (batchDeleted > 0) {
            this.logger(
              `[ExpiredSessionsSweeper] Deleted batch of ${batchDeleted} rows (total: ${deletedCount})`,
            )
          }

          if (batchDeleted < this.batchSize) break
        }
      }

      const durationMs = Date.now() - startTime

      this.logger(
        `[ExpiredSessionsSweeper] Completed: expired=${expiredCount} deleted=${deletedCount} duration=${durationMs}ms`,
      )

      return { expiredCount, deletedCount, dryRun: this.dryRun, durationMs }
    } catch (error) {
      const durationMs = Date.now() - startTime
      this.logger(
        `[ExpiredSessionsSweeper] Error after ${durationMs}ms: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    } finally {
      this.running = false
    }
  }

  /** Whether the sweeper is currently mid-run. */
  isRunning(): boolean {
    return this.running
  }
}

/**
 * Convenience function: run a single sweep cycle without starting the timer.
 * Useful in tests and one-off invocations.
 */
export async function sweepExpiredSessions(
  db: Queryable,
  config?: ExpiredSessionsSweeperConfig,
): Promise<SweeperResult> {
  const sweeper = new ExpiredSessionsSweeper(db, config)
  return sweeper.run()
}
