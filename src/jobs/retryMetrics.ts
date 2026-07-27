/**
 * Cross-cutting Prometheus metrics for queued jobs that retry or dead-letter.
 *
 * Why this module exists
 * ──────────────────────
 * The Credence Backend has multiple job domains (outbox events, webhook
 * deliveries, email notifications, expired-session sweeps, audit-chain
 * verifier, ...) — each with its own bespoke per-domain metric.
 * Operators responding to "is anything stuck?" alerts previously had to
 * author one PromQL rule per domain. This module exports a small,
 * stable set of *generic*, cross-domain metrics with a shared
 * `domain` label, so a single rule surfaces stuck workers in
 * *every* domain simultaneously.
 *
 * Per-domain metrics continue to exist (e.g.
 * `outbox_dead_letter_total{error_code=...}`,
 * `webhook_dlq_size`, `notification_dlq_total{status=...}`); this
 * module does NOT replace them. New domains SHOULD wire into this
 * module in addition to their bespoke metrics — the cross-cutting
 * gauges are what power generic alerts.
 *
 * Metrics exposed
 * ───────────────
 * • `jobs_dead_letter_total{domain,reason}`         — Counter; a job moved to DLQ.
 * • `jobs_terminal_outcome_total{domain,outcome}`   — Counter; a job reached a
 *                                                     terminal state (succeeded
 *                                                     or dead_letter).
 * • `jobs_terminal_attempt_count{domain}`          — Histogram (1..20) of total
 *                                                     attempts consumed at the
 *                                                     moment a job terminated.
 * • `jobs_oldest_pending_age_seconds{domain}`      — Gauge; age (s) of the
 *                                                     oldest pending job per
 *                                                     domain. Rising = stuck
 *                                                     workers or paused queue.
 *
 * @see docs/JOBS_RETRY_METRICS.md for PromQL examples and operator guidance.
 */
import client from 'prom-client'
import { register } from '../middleware/metrics.js'

/**
 * Closed-set of job domains wired through these helpers as of this PR.
 * Add a new union member ONLY after wiring at least one callsite — the
 * union is the source of truth for what `domain` label values operators
 * can expect.
 */
export type JobDomain = 'outbox' | 'webhook' | 'notification'

export type JobTerminalOutcome = 'succeeded' | 'dead_letter'

export const jobsDeadLetterTotal = new client.Counter({
  name: 'jobs_dead_letter_total',
  help: 'Cross-domain count of jobs moved to a dead-letter queue.',
  labelNames: ['domain', 'reason'] as const,
  registers: [register],
})

export const jobsTerminalOutcomeTotal = new client.Counter({
  name: 'jobs_terminal_outcome_total',
  help: 'Cross-domain count of job outcomes that consumed the retry budget. Increment per success or per exhaustion.',
  labelNames: ['domain', 'outcome'] as const,
  registers: [register],
})

export const jobsTerminalAttemptCount = new client.Histogram({
  name: 'jobs_terminal_attempt_count',
  help: 'Distribution of total attempts executed at the time a job reached a terminal outcome.',
  labelNames: ['domain'] as const,
  // Captures the typical max-retry budget in this codebase (~3–10) plus
  // a long-tail bucket for misconfigured workloads.
  buckets: [1, 2, 3, 5, 10, 20],
  registers: [register],
})

export const jobsOldestPendingAgeSeconds = new client.Gauge({
  name: 'jobs_oldest_pending_age_seconds',
  help: 'Age in seconds of the oldest pending job, per domain. Rising = stuck workers, paused queue, or a stale worker scrape loop.',
  labelNames: ['domain'] as const,
  registers: [register],
})

/**
 * Record a terminal job outcome (final success or final dead-letter).
 * Increments `jobs_terminal_outcome_total{outcome}` AND observes
 * `jobs_terminal_attempt_count` with the total attempts the job
 * consumed before terminating.
 *
 * @param domain     the job domain emitting this terminal outcome
 * @param outcome    `'succeeded' | 'dead_letter'`
 * @param attempts   number of attempts the job executed (≥ 1, clamped)
 */
export function recordJobTerminalOutcome(
  domain: JobDomain,
  outcome: JobTerminalOutcome,
  attempts: number,
): void {
  const safeAttempts = Number.isFinite(attempts) && attempts >= 1
    ? Math.floor(attempts)
    : 1
  jobsTerminalOutcomeTotal.inc({ domain, outcome })
  jobsTerminalAttemptCount.observe({ domain }, safeAttempts)
}

/**
 * Record a dead-letter transition (the job gave up and was pushed to
 * the DLQ store). Independently increments
 * `jobs_dead_letter_total{reason}` so operators can distinguish
 * transient from permanent causes without writing per-domain rules.
 *
 * Callers SHOULD additionally call {@link recordJobTerminalOutcome}
 * once per exhaustion (since dead-letter IS a terminal outcome) so
 * the histogram and the counter stay coherent.
 */
export function recordJobDeadLetter(domain: JobDomain, reason: string = 'unknown'): void {
  jobsDeadLetterTotal.inc({ domain, reason: boundedReason(reason) })
}

/**
 * Set the age of the oldest pending job, per domain. Workers that have
 * a scrape loop should call this once per interval.
 *
 * Pass `0` when the queue is empty — this is what an operator wants to
 * see when nothing is stuck. A non-zero value that does NOT decrease
 * over time is the strongest "stuck worker" signal.
 */
export function setJobOldestPendingAge(domain: JobDomain, ageSeconds: number): void {
  const safe = Number.isFinite(ageSeconds) && ageSeconds >= 0 ? ageSeconds : 0
  jobsOldestPendingAgeSeconds.set({ domain }, safe)
}

/**
 * Clamp the reason label to a bounded cardinality to avoid Prometheus
 * time-series explosion. Non-alphanumeric chars collapse to `_`, the
 * result is upper-cased and truncated to 50 chars. Empty → `UNKNOWN`.
 */
function boundedReason(reason: string): string {
  const cleaned = (reason || 'unknown')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 50)
  return cleaned.length > 0 ? cleaned : 'UNKNOWN'
}
