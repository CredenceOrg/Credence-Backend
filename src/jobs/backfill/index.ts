/**
 * Resumable backfill jobs with durable progress markers.
 *
 * Use {@link ResumableBackfillRunner} (or {@link runResumableBackfill}) so
 * long-running backfills resume from the last committed cursor after a crash.
 */

export { ResumableBackfillRunner, runResumableBackfill } from './runner.js'
export type {
  BackfillBatchProcessor,
  BackfillBatchResult,
  BackfillProgress,
  BackfillProgressStatus,
  ResumableBackfillOptions,
  ResumableBackfillResult,
} from './types.js'
