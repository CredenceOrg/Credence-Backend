import type { Queryable } from '../db/repositories/queryable.js'
import { FailedInboundEventsRepository } from '../db/repositories/failedInboundEventsRepository.js'
import { FailedInboundSweeperMetrics, createFailedInboundSweeperMetrics } from './failedInboundEventsSweeperMetrics.js'

export interface FailedInboundSweeperOptions {
  /** Run interval in milliseconds (default: 3600000 = 1 hour) */
  intervalMs?: number
  /** Maximum number of rows to delete per batch (default: 5000) */
  batchSize?: number
  /** Enable dry-run mode (count but don't delete) */
  dryRun?: boolean
  /** Terminal events (replayed/skipped) older than this many days are deleted (default: 30) */
  terminalRetentionDays?: number
  /** Failed-status events older than this many days are also deleted. 0 = keep forever (default: 0) */
  failedMaxAgeDays?: number
  /** Logger function */
  logger?: (message: string) => void
  /** Prometheus metrics */
  metrics?: FailedInboundSweeperMetrics
}

export interface FailedInboundSweeperResult {
  /** Number of terminal events found past retention */
  terminalCount: number
  /** Number of terminal events deleted */
  deletedCount: number
  /** Whether this was a dry run */
  dryRun: boolean
  /** Duration in milliseconds */
  durationMs: number
}

export class FailedInboundEventsSweeper {
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly dryRun: boolean
  private readonly terminalRetentionDays: number
  private readonly failedMaxAgeDays: number
  private readonly logger: (message: string) => void
  private readonly metrics: FailedInboundSweeperMetrics
  private readonly db: Queryable
  private readonly repository: FailedInboundEventsRepository
  private interval: NodeJS.Timeout | null = null
  private running = false

  constructor(
    db: Queryable,
    options: FailedInboundSweeperOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 3600000
    this.batchSize = options.batchSize ?? 5000
    this.dryRun = options.dryRun ?? false
    this.terminalRetentionDays = options.terminalRetentionDays ?? 30
    this.failedMaxAgeDays = options.failedMaxAgeDays ?? 0
    this.db = db
    this.logger = options.logger ?? (() => {})
    this.metrics = options.metrics ?? createFailedInboundSweeperMetrics()
    this.repository = new FailedInboundEventsRepository(db, { skipTenantCheck: true })
  }

  start(): void {
    if (this.interval) {
      this.logger('[FailedInboundSweeper] Already running')
      return
    }

    this.logger(`[FailedInboundSweeper] Starting periodic cleanup every ${this.intervalMs}ms`)

    this.run().catch((err) => {
      this.logger(`[FailedInboundSweeper] Error in initial run: ${err}`)
    })

    this.interval = setInterval(() => {
      this.run().catch((err) => {
        this.logger(`[FailedInboundSweeper] Error in scheduled run: ${err}`)
      })
    }, this.intervalMs)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
      this.logger('[FailedInboundSweeper] Stopped')
    }
  }

  async run(): Promise<FailedInboundSweeperResult> {
    if (this.running) {
      this.logger('[FailedInboundSweeper] Already running, skipping')
      return { terminalCount: 0, deletedCount: 0, dryRun: this.dryRun, durationMs: 0 }
    }

    this.running = true
    const startTime = Date.now()

    try {
      const terminalCutoff = new Date(
        Date.now() - this.terminalRetentionDays * 24 * 60 * 60 * 1000
      )

      const terminalCount = await this.repository.countTerminalEvents(terminalCutoff)

      this.logger(
        `[FailedInboundSweeper] Found ${terminalCount} terminal events older than ${this.terminalRetentionDays}d${this.dryRun ? ' (dry-run)' : ''}`
      )

      let deletedCount = 0

      if (!this.dryRun && terminalCount > 0) {
        let remaining = terminalCount

        while (remaining > 0) {
          const batchDeleted = await this.repository.deleteTerminalEvents(
            terminalCutoff,
            this.batchSize
          )

          deletedCount += batchDeleted
          remaining -= batchDeleted

          if (batchDeleted > 0) {
            this.logger(
              `[FailedInboundSweeper] Deleted batch of ${batchDeleted} terminal events (total: ${deletedCount})`
            )
          }

          if (batchDeleted < this.batchSize) {
            break
          }
        }
      }

      let failedDeleted = 0
      if (this.failedMaxAgeDays > 0) {
        const failedCutoff = new Date(
          Date.now() - this.failedMaxAgeDays * 24 * 60 * 60 * 1000
        )

        const failedCountResult = await this.db.query<{ count: string }>(
          `SELECT COUNT(*)::text as count FROM failed_inbound_events WHERE status = 'failed' AND created_at < $1`,
          [failedCutoff.toISOString()]
        )
        const failedCount = parseInt(failedCountResult.rows[0]?.count ?? '0', 10)

        this.logger(
          `[FailedInboundSweeper] Found ${failedCount} failed-status events older than ${this.failedMaxAgeDays}d${this.dryRun ? ' (dry-run)' : ''}`
        )

        if (!this.dryRun && failedCount > 0) {
          let remaining = failedCount
          while (remaining > 0) {
            const result = await this.db.query(
              `
              DELETE FROM failed_inbound_events
              WHERE ctid IN (
                SELECT ctid FROM failed_inbound_events
                WHERE status = 'failed'
                  AND created_at < $1
                LIMIT $2
              )
              `,
              [failedCutoff.toISOString(), this.batchSize]
            )

            const batchDeleted = result.rowCount ?? 0
            failedDeleted += batchDeleted
            remaining -= batchDeleted

            if (batchDeleted > 0) {
              this.logger(
                `[FailedInboundSweeper] Deleted batch of ${batchDeleted} failed events (total: ${failedDeleted})`
              )
            }

            if (batchDeleted < this.batchSize) {
              break
            }
          }
        }
      }

      const durationMs = Date.now() - startTime

      this.metrics.incRuns()
      this.metrics.observeDuration(durationMs / 1000)
      this.metrics.incSwept(deletedCount + failedDeleted)
      this.metrics.setRetained(terminalCount - deletedCount)

      this.logger(
        `[FailedInboundSweeper] Completed: terminal=${terminalCount} deleted=${deletedCount} failedDeleted=${failedDeleted} duration=${durationMs}ms`
      )

      return {
        terminalCount,
        deletedCount,
        dryRun: this.dryRun,
        durationMs,
      }
    } catch (error) {
      const durationMs = Date.now() - startTime
      this.logger(
        `[FailedInboundSweeper] Error after ${durationMs}ms: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error
    } finally {
      this.running = false
    }
  }

  isRunning(): boolean {
    return this.running
  }
}
