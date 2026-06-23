/**
 * @module jobs/requestSnapshotsSweeper
 * @description Background job to clean up expired request snapshots.
 *
 * Runs periodically to remove snapshots that have passed their TTL,
 * preventing unbounded growth of the request_snapshots table and ensuring
 * compliance with data minimization policies.
 */

import type { Queryable } from '../db/repositories/queryable.js'

export interface RequestSnapshotsSweeperConfig {
  /** Retention window in days (default: 14) */
  retentionDays?: number
  /** Run interval in milliseconds (default: 86400000 = 24 hours) */
  intervalMs?: number
  /** Maximum number of snapshots to delete per batch (default: 5000) */
  batchSize?: number
  /** Enable dry-run mode (count but don't delete) */
  dryRun?: boolean
  /** Logger function */
  logger?: (message: string) => void
  /** Metrics callback for recording deleted counts */
  onMetric?: (metric: { name: string; value: number; labels?: Record<string, string> }) => void
}

export interface SweeperResult {
  /** Number of expired snapshots found */
  expiredCount: number
  /** Number of snapshots deleted */
  deletedCount: number
  /** Whether this was a dry run */
  dryRun: boolean
  /** Duration in milliseconds */
  durationMs: number
}

/**
 * Background job that periodically deletes expired request snapshots.
 *
 * The sweeper:
 * 1. Counts snapshots where created_at <= NOW() - interval
 * 2. Deletes them in batches to avoid long-running transactions
 * 3. Emits metrics for monitoring
 * 4. Logs the results for observability
 *
 * @example
 * ```typescript
 * const sweeper = new RequestSnapshotsSweeper(db, {
 *   retentionDays: 14,
 *   intervalMs: 86400000, // Run every 24 hours
 *   batchSize: 5000,
 *   logger: console.log,
 *   onMetric: (metric) => prometheus.record(metric),
 * })
 *
 * // Start the periodic job
 * sweeper.start()
 *
 * // Or run once manually
 * const result = await sweeper.run()
 * console.log(`Deleted ${result.deletedCount} expired snapshots`)
 * ```
 */
export class RequestSnapshotsSweeper {
  private readonly retentionDays: number
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly dryRun: boolean
  private readonly logger: (message: string) => void
  private readonly onMetric: (metric: { name: string; value: number; labels?: Record<string, string> }) => void
  private interval: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly db: Queryable,
    config: RequestSnapshotsSweeperConfig = {}
  ) {
    this.retentionDays = config.retentionDays ?? 14
    this.intervalMs = config.intervalMs ?? 86400000 // 24 hours default
    this.batchSize = config.batchSize ?? 5000
    this.dryRun = config.dryRun ?? false
    this.logger = config.logger ?? (() => {})
    this.onMetric = config.onMetric ?? (() => {})
  }

  /**
   * Start the periodic sweeper job.
   */
  start(): void {
    if (this.interval) {
      this.logger('[RequestSnapshotsSweeper] Already running')
      return
    }

    this.logger(
      `[RequestSnapshotsSweeper] Starting periodic cleanup every ${this.intervalMs}ms (retention: ${this.retentionDays} days)`
    )

    // Run immediately on start
    this.run().catch((err) => {
      this.logger(`[RequestSnapshotsSweeper] Error in initial run: ${err}`)
    })

    // Schedule periodic runs
    this.interval = setInterval(() => {
      this.run().catch((err) => {
        this.logger(`[RequestSnapshotsSweeper] Error in scheduled run: ${err}`)
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
      this.logger('[RequestSnapshotsSweeper] Stopped')
    }
  }

  /**
   * Run a single cleanup cycle.
   *
   * @returns Result containing counts of expired and deleted snapshots
   */
  async run(): Promise<SweeperResult> {
    if (this.running) {
      this.logger('[RequestSnapshotsSweeper] Already running, skipping')
      return { expiredCount: 0, deletedCount: 0, dryRun: this.dryRun, durationMs: 0 }
    }

    this.running = true
    const startTime = Date.now()

    try {
      // Count expired snapshots
      const countResult = await this.db.query<{ count: string }>(
        `
        SELECT COUNT(*)::text as count FROM request_snapshots
        WHERE created_at < now() - interval '1 day' * $1
        `,
        [this.retentionDays]
      )

      const expiredCount = parseInt(countResult.rows[0]?.count ?? '0', 10)

      this.logger(
        `[RequestSnapshotsSweeper] Found ${expiredCount} expired snapshots${this.dryRun ? ' (dry-run)' : ''}`
      )

      let deletedCount = 0

      if (!this.dryRun && expiredCount > 0) {
        // Delete in batches
        let remaining = expiredCount

        while (remaining > 0) {
          const deleteResult = await this.db.query(
            `
            DELETE FROM request_snapshots
            WHERE ctid IN (
              SELECT ctid FROM request_snapshots
              WHERE created_at < now() - interval '1 day' * $1
              LIMIT $2
            )
            `,
            [this.retentionDays, this.batchSize]
          )

          const batchDeleted = deleteResult.rowCount ?? 0
          deletedCount += batchDeleted
          remaining -= batchDeleted

          if (batchDeleted > 0) {
            this.logger(
              `[RequestSnapshotsSweeper] Deleted batch of ${batchDeleted} snapshots (total: ${deletedCount})`
            )
          }

          // Stop if we deleted fewer than batch size (no more expired snapshots)
          if (batchDeleted < this.batchSize) {
            break
          }
        }

        // Emit metric for deleted snapshots
        this.onMetric({
          name: 'request_snapshots_deleted_total',
          value: deletedCount,
        })
      }

      const durationMs = Date.now() - startTime

      this.logger(
        `[RequestSnapshotsSweeper] Completed: expired=${expiredCount} deleted=${deletedCount} duration=${durationMs}ms`
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
        `[RequestSnapshotsSweeper] Error after ${durationMs}ms: ${error instanceof Error ? error.message : String(error)}`
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
export async function sweepExpiredRequestSnapshots(
  db: Queryable,
  config?: RequestSnapshotsSweeperConfig
): Promise<SweeperResult> {
  const sweeper = new RequestSnapshotsSweeper(db, config)
  return sweeper.run()
}
