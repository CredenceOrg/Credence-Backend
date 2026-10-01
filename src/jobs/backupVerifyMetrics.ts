import client from 'prom-client'
import { register } from '../middleware/metrics.js'

export const backupRestoreVerifySeconds = new client.Histogram({
  name: 'backup_restore_verify_seconds',
  help: 'Duration of backup restore and verification in seconds',
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
})

export const backupRestoreFailedTotal = new client.Counter({
  name: 'backup_restore_failed_total',
  help: 'Total number of backup restore failures',
  labelNames: ['step'] as const,
  registers: [register],
})

export interface BackupVerifyMetrics {
  observeDuration(seconds: number): void
  incFailure(step: string): void
}

/**
 * Buckets are inclusive upper bounds (`le`): a duration sample equal to a
 * bound lands in that bucket. Samples above the last bound (300s) are counted
 * only by the implicit `+Inf` bucket and the `_count` series.
 *
 * The restore-verify drill calls {@link BackupVerifyMetrics.observeDuration}
 * exactly once per run with a `Date.now()` delta, so valid samples are always
 * non-negative and finite. See {@link normalizeDuration} for the defensive
 * contract that keeps an uninitialized or clock-skewed sample from poisoning
 * the shared series.
 */

/**
 * Failure-step label values understood by the restore-verify drill. Keeping
 * the set closed bounds the cardinality of
 * `backup_restore_failed_total{step}` so operator dashboards and alerts stay
 * stable. `incFailure` maps anything outside this set onto `unknown` instead
 * of minting an unbounded new series.
 */
const FAILURE_STEPS = ['row_count', 'checksum', 'unknown'] as const

/**
 * Normalize an externally supplied duration sample in seconds.
 *
 * Every duration the drill reports is a `Date.now()` delta, so it is a
 * non-negative finite number. The wrapper is still defensive because both
 * metrics are shared module-level series: a single poisoned sample corrupts
 * the series for the lifetime of the process, and a thrown error can abort
 * the drill before cleanup (temp dir removal, pool shutdown) runs.
 *
 * prom-client rejects negatives, infinities, and `NaN` on
 * `Histogram.observe`, but callers get a `TypeError` instead of a dropped
 * sample — the drill's `catch` block would then misclassify a metrics bug as
 * a drill failure (`incFailure('unknown')`) and exit non-zero.
 *
 * Invariant: a sample is recorded only when it is a non-negative finite
 * number. Anything else is dropped, never thrown, so metrics can never fail
 * the restore-verify drill.
 *
 * @returns the value to record, or `null` when the sample must be ignored.
 */
function normalizeDuration(seconds: number): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return null
  }
  return seconds
}

/**
 * Normalize the failure-step label for `backup_restore_failed_total{step}`.
 *
 * Known steps (see {@link FAILURE_STEPS}) pass through unchanged. Anything
 * else — an empty string, whitespace, or an unexpected future step — is
 * normalized to `unknown` so the drill cannot mint an unbounded number of
 * label values (unbounded label cardinality is a classic way to explode a
 * Prometheus time-series database).
 *
 * Callers may pass any string; this function only shapes the label, it never
 * throws and never drops a legitimate failure count.
 */
function boundedFailureStep(step: string): string {
  const candidate =
    typeof step === 'string' ? step.trim().toLowerCase() : ''
  if (candidate.length === 0) return 'unknown'
  if ((FAILURE_STEPS as readonly string[]).includes(candidate)) {
    return candidate
  }
  return 'unknown'
}

/**
 * Create a metrics handle for the backup restore-verify drill
 * (`scripts/restore-verify.ts`).
 *
 * Every call returns a fresh handle, but all handles are backed by the same
 * module-level metric instances registered on the shared Prometheus registry,
 * so observations made through one handle are visible through another and via
 * the exported metrics directly.
 *
 * Invariant: unlike the raw prom-client metrics, these methods never throw on
 * invalid input, so a metrics bug can never abort a drill run. The drill's
 * `finally` block still removes its temp dir and closes its connection pool.
 */
export function createBackupVerifyMetrics(): BackupVerifyMetrics {
  return {
    observeDuration: (seconds) => {
      const normalized = normalizeDuration(seconds)
      if (normalized === null) return
      backupRestoreVerifySeconds.observe(normalized)
    },
    incFailure: (step) => {
      backupRestoreFailedTotal.inc({
        step: boundedFailureStep(step),
      })
    },
  }
}

export { FAILURE_STEPS }
