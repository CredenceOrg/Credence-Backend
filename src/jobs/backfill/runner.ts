/**
 * Resumable backfill runner.
 *
 * Persists progress markers after each committed batch so a crash or process
 * restart resumes from the last successful checkpoint instead of starting over.
 */

import {
  BackfillProgressRepository,
  type BackfillProgress,
} from '../../db/repositories/backfillProgressRepository.js'
import type { Pool, PoolClient } from 'pg'
import type {
  BackfillBatchProcessor,
  ResumableBackfillOptions,
  ResumableBackfillResult,
} from './types.js'

export class ResumableBackfillRunner {
  private readonly progressRepo: BackfillProgressRepository
  private readonly logger: (message: string) => void

  constructor(
    db: Pool | PoolClient,
    private readonly processor: BackfillBatchProcessor,
    logger?: (message: string) => void,
  ) {
    this.progressRepo = new BackfillProgressRepository(db)
    this.logger = logger ?? (() => {})
  }

  /**
   * Runs (or resumes) a backfill job until completion or failure.
   * Progress is checkpointed after every successful batch.
   */
  async run(options: ResumableBackfillOptions): Promise<ResumableBackfillResult> {
    const {
      jobName,
      batchSize = 500,
      totalRows = null,
      initialCursor = '',
      forceRestart = false,
    } = options
    const log = options.logger ?? this.logger
    const startedAt = Date.now()

    let existing = await this.progressRepo.findByJobName(jobName)

    if (forceRestart && existing) {
      log(`[backfill:${jobName}] forceRestart=true — resetting progress marker`)
      existing = await this.progressRepo.upsert({
        jobName,
        cursorValue: initialCursor,
        rowsProcessed: 0,
        totalRows,
        status: 'pending',
        lastError: null,
        metadata: {},
      })
    }

    if (existing?.status === 'completed' && !forceRestart) {
      log(`[backfill:${jobName}] already completed — nothing to do`)
      return {
        jobName,
        status: 'completed',
        rowsProcessed: existing.rowsProcessed,
        cursorValue: existing.cursorValue,
        batchesProcessed: 0,
        durationMs: Date.now() - startedAt,
        resumedFromCursor: existing.cursorValue,
        progress: existing,
      }
    }

    const resumeCursor = existing?.cursorValue ?? initialCursor
    const resumedRows = existing?.rowsProcessed ?? 0

    log(
      `[backfill:${jobName}] starting — resumeCursor=${JSON.stringify(resumeCursor)} ` +
        `rowsProcessed=${resumedRows}`,
    )

    let progress = await this.progressRepo.markRunning(jobName, {
      totalRows: totalRows ?? existing?.totalRows ?? null,
    })

    let cursor = resumeCursor
    let rowsProcessed = resumedRows
    let batchesProcessed = 0

    try {
      // Cap iterations to avoid unbounded loops from a buggy processor.
      const maxBatches = 10_000_000
      for (let i = 0; i < maxBatches; i++) {
        const batch = await this.processor(cursor, batchSize)

        if (batch.processedCount < 0) {
          throw new Error('Backfill batch reported negative processedCount')
        }

        rowsProcessed += batch.processedCount
        batchesProcessed += 1
        cursor = batch.nextCursor

        progress = await this.progressRepo.checkpoint({
          jobName,
          cursorValue: cursor,
          rowsProcessed,
          totalRows: batch.totalRows ?? totalRows ?? progress.totalRows,
          metadata: batch.metadata,
        })

        const total = progress.totalRows
        const pct =
          total && total > 0
            ? ` (${((rowsProcessed / total) * 100).toFixed(1)}%)`
            : ''
        log(
          `[backfill:${jobName}] checkpoint batch=${batchesProcessed} ` +
            `rows=${rowsProcessed}${total != null ? `/${total}` : ''}${pct} ` +
            `cursor=${JSON.stringify(cursor)}`,
        )

        if (batch.done || batch.processedCount === 0) {
          break
        }
      }

      progress = await this.progressRepo.markCompleted(jobName, {
        cursorValue: cursor,
        rowsProcessed,
      })

      log(
        `[backfill:${jobName}] completed — rows=${rowsProcessed} batches=${batchesProcessed} ` +
          `durationMs=${Date.now() - startedAt}`,
      )

      return {
        jobName,
        status: 'completed',
        rowsProcessed,
        cursorValue: cursor,
        batchesProcessed,
        durationMs: Date.now() - startedAt,
        resumedFromCursor: resumeCursor,
        progress,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      let failedProgress: BackfillProgress
      try {
        failedProgress = await this.progressRepo.markFailed(jobName, message)
      } catch {
        failedProgress = progress
      }

      log(`[backfill:${jobName}] failed — ${message}`)

      return {
        jobName,
        status: 'failed',
        rowsProcessed,
        cursorValue: cursor,
        batchesProcessed,
        durationMs: Date.now() - startedAt,
        resumedFromCursor: resumeCursor,
        progress: failedProgress,
        error: message,
      }
    }
  }
}

/**
 * Convenience helper to run a resumable backfill once.
 */
export async function runResumableBackfill(
  db: Pool | PoolClient,
  processor: BackfillBatchProcessor,
  options: ResumableBackfillOptions,
): Promise<ResumableBackfillResult> {
  const runner = new ResumableBackfillRunner(db, processor, options.logger)
  return runner.run(options)
}
