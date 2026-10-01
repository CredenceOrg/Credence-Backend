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
 *
 * ## Invariants
 *
 * 1. **Single-flight.** At most one cleanup cycle runs concurrently within a
 *    single sweeper instance. A concurrent `run()` call returns a no-op
 *    result with `skipped = true` rather than deleting rows twice.
 * 2. **Dry-run is read-only.** When `dryRun` is true no DELETE statement is
 *    issued; `deletedCount` is always 0.
 * 3. **Bounded batching.** Deletion proceeds in batches of at most
 *    `batchSize` rows and terminates when a batch returns fewer rows than
 *    `remaining` or when the database reports zero rows deleted (concurrent
 *    deletion by another process), so the loop cannot spin forever.
 * 4. **Fresh clock per batch.** Each batch uses `NOW()` so rows that expire
 *    during a long sweep are still correctly reclaimed.
 * 5. **Failure is surfaced.** Errors are logged and rethrown from `run()`;
 *    the `running` flag is always reset in `finally`, allowing the next
 *    scheduled tick to retry.
 * 6. **No sensitive data in logs.** Log messages contain only counts, durations
 *    and error messages.
 *
 * ## Boundary and recovery behavior

 *
 * - `expiredCount == 0`: no delete is attempted.
 * - `expiredCount > 0` but `DELETE` affects 0 rows (concurrent deletion):
 *   the loop exits immediately without lossing the remaining rows.
 * - `DELETE` fails midway: the error is rethrown and `running` is reset,
 *   so the next tick retries from the current database state.
 * - `countResult.rows` is empty or malformed: treated as zero expired
 *   rows rather than NaN or an exception.
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
  /** True when the cycle was skipped because another run was in flight. */
  skipped: boolean
}

function parseCount(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return 0
  const parsed = typeof value === 'number' ? value : parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
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
 * // ...
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
      return {
        expiredCount: 0,
        deletedCount: 0,
        dryRun: this.dryRun,
        durationMs: 0,
        skipped: true,
      }
    }

    this.running = true
    const startTime = Date.now()

    try {
      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM idempotent_job_attempts
         WHERE expires_at <= NOW()`,
      )

      const expiredCount = parseCount(countResult.rows[0]?.count)

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
             )
             RETURNING 1`,
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

          // Stop when the database reports no more rows (concurrent deletion
          // or empty result set) or when the batch was not full.
          if (batchDeleted === 0 || batchDeleted < this.batchSize) {
            if (batchDeleted === 0 && remaining > 0) {
              this.logger(
                `[ExpiredSessionsSweeper] No rows deleted in batch; ${remaining} rows may have been removed concurrently`,
              )
            }
            break
          }
        }
      }

      const durationMs = Date.now() - startTime

      this.logger(
        `[ExpiredSessionsSweeper] Completed: expired=${expiredCount} deleted=${deletedCount} duration=${durationMs}ms`,
      )

      return { expiredCount, deletedCount, dryRun: this.dryRun, durationMs, skipped: false }
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
