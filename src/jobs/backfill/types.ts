/**
 * Types for resumable backfill jobs that persist progress markers.
 */

import type { BackfillProgress } from '../../db/repositories/backfillProgressRepository.js'

export type { BackfillProgress, BackfillProgressStatus } from '../../db/repositories/backfillProgressRepository.js'

/**
 * One committed batch of backfill work.
 * `nextCursor` becomes the durable resume watermark after checkpoint.
 */
export interface BackfillBatchResult {
  /** Opaque cursor to resume from on the next batch / restart. */
  nextCursor: string
  /** Number of rows successfully processed in this batch. */
  processedCount: number
  /** True when there is no more work remaining. */
  done: boolean
  /** Optional estimated total rows for progress reporting. */
  totalRows?: number | null
  /** Optional metadata merged into the progress marker. */
  metadata?: Record<string, unknown>
}

/**
 * Processes one batch starting after `cursor`.
 * Implementations must be idempotent for safe resume after crash.
 */
export type BackfillBatchProcessor = (
  cursor: string,
  batchSize: number,
) => Promise<BackfillBatchResult>

export interface ResumableBackfillOptions {
  /** Unique job name used as the progress marker key. */
  jobName: string
  /** Rows per batch (default: 500). */
  batchSize?: number
  /** Optional estimated total row count when known up front. */
  totalRows?: number | null
  /** Optional starting cursor when no marker exists yet (default: ''). */
  initialCursor?: string
  /** Logger for operational visibility. */
  logger?: (message: string) => void
  /**
   * When true, reset an existing completed/failed marker and start from
   * `initialCursor` (default: false — resume from last checkpoint).
   */
  forceRestart?: boolean
}

export interface ResumableBackfillResult {
  jobName: string
  status: 'completed' | 'failed'
  rowsProcessed: number
  cursorValue: string
  batchesProcessed: number
  durationMs: number
  resumedFromCursor: string
  progress: BackfillProgress
  error?: string
}
