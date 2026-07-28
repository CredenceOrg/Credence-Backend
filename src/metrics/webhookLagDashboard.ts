/**
 * Compact webhook delivery lag dashboard summary.
 *
 * Powers the operator-facing Grafana summary described in
 * `docs/WEBHOOK_LAG_DASHBOARD.md`: oldest queued webhook age and
 * delivery success rate. These helpers are intentionally small and
 * low-cardinality — they do NOT label by subscriber URL, payload, or
 * tenant (see Security section in the doc).
 *
 * Cross-cutting `jobs_*` metrics (`src/jobs/retryMetrics.ts`) remain
 * the source of truth for multi-domain alerts. This module adds a
 * webhook-specific summary surface so a single Grafana row can answer
 * "are webhooks falling behind?" without composing PromQL across
 * domains.
 *
 * @see docs/WEBHOOK_LAG_DASHBOARD.md
 * @see docs/JOBS_RETRY_METRICS.md
 * @see docs/RUNBOOK_QUEUE_LAG.md
 */
import client from 'prom-client'
import { register } from '../middleware/metrics.js'
import { setJobOldestPendingAge } from '../jobs/retryMetrics.js'

/** Metric name contract — pinned by unit tests. */
export const WEBHOOK_QUEUED_OLDEST_AGE_SECONDS =
  'webhook_queued_oldest_age_seconds' as const
export const WEBHOOK_DELIVERY_OUTCOME_TOTAL =
  'webhook_delivery_outcome_total' as const

/**
 * Operator SLO fence-posts for the compact dashboard.
 * Soft = warn (amber); Hard = page (red). Kept as named constants so
 * docs, alerts, and tests share one source of truth.
 */
export const WEBHOOK_LAG_SOFT_SECONDS = 60
export const WEBHOOK_LAG_HARD_SECONDS = 300
/** Rolling window used by success-rate PromQL / summary helpers. */
export const WEBHOOK_SUCCESS_RATE_WINDOW = '5m' as const
/** Soft floor for healthy success rate (0–1). */
export const WEBHOOK_SUCCESS_RATE_SOFT = 0.99
/** Hard floor — below this is a critical regression. */
export const WEBHOOK_SUCCESS_RATE_HARD = 0.95

export type WebhookDeliveryOutcome = 'success' | 'failure'

export type WebhookLagStatus = 'ok' | 'warn' | 'critical'

export interface WebhookLagDashboardSummary {
  /** Age in seconds of the oldest queued webhook delivery (0 = empty). */
  oldestAgeSeconds: number
  /** Success ratio in [0, 1]. `null` when there were no attempts. */
  successRate: number | null
  /** Compact traffic-light derived from age + success rate. */
  status: WebhookLagStatus
  /** Human-readable reason for the current status (safe for UI / logs). */
  reason: string
}

/**
 * Age (seconds) of the oldest queued / in-flight webhook delivery.
 * Set to `0` when the queue is empty so dashboards can distinguish
 * "clean" from "stale scrape".
 */
export const webhookQueuedOldestAgeSeconds = new client.Gauge({
  name: WEBHOOK_QUEUED_OLDEST_AGE_SECONDS,
  help: 'Age in seconds of the oldest queued webhook delivery. Rising without a matching failure spike usually means the delivery worker is stuck.',
  registers: [register],
})

/**
 * Terminal webhook delivery outcomes. Label cardinality is fixed to
 * `result ∈ {success, failure}` — never label by URL or subscriber id
 * on this counter (use per-subscriber metrics elsewhere if needed).
 */
export const webhookDeliveryOutcomeTotal = new client.Counter({
  name: WEBHOOK_DELIVERY_OUTCOME_TOTAL,
  help: 'Terminal webhook delivery outcomes used to derive the compact success-rate panel.',
  labelNames: ['result'] as const,
  registers: [register],
})

/**
 * Clamp and publish the oldest queued webhook age.
 * Also mirrors into `jobs_oldest_pending_age_seconds{domain="webhook"}`
 * so the cross-domain stuck-worker alert stays coherent.
 */
export function setWebhookQueuedOldestAge(ageSeconds: number): void {
  const safe = Number.isFinite(ageSeconds) && ageSeconds >= 0 ? ageSeconds : 0
  webhookQueuedOldestAgeSeconds.set(safe)
  setJobOldestPendingAge('webhook', safe)
}

/**
 * Record a terminal delivery outcome for the success-rate panel.
 *
 * This increments **only** `webhook_delivery_outcome_total`. Callers that
 * also feed the cross-domain retry-budget view should continue to call
 * `recordJobTerminalOutcome('webhook', …)` from `src/jobs/retryMetrics.ts`
 * so those counters are not double-counted.
 */
export function recordWebhookDeliveryOutcome(
  result: WebhookDeliveryOutcome,
): void {
  webhookDeliveryOutcomeTotal.inc({ result })
}

/**
 * Pure success-rate helper. Returns `null` when there were no attempts
 * so dashboards can show "n/a" instead of a misleading 0% or 100%.
 */
export function computeWebhookSuccessRate(
  succeeded: number,
  failed: number,
): number | null {
  const ok = Number.isFinite(succeeded) && succeeded > 0 ? succeeded : 0
  const bad = Number.isFinite(failed) && failed > 0 ? failed : 0
  const total = ok + bad
  if (total <= 0) return null
  return ok / total
}

/**
 * Classify lag age against soft/hard SLO fence-posts.
 */
export function classifyWebhookLag(ageSeconds: number): WebhookLagStatus {
  const age = Number.isFinite(ageSeconds) && ageSeconds >= 0 ? ageSeconds : 0
  if (age >= WEBHOOK_LAG_HARD_SECONDS) return 'critical'
  if (age >= WEBHOOK_LAG_SOFT_SECONDS) return 'warn'
  return 'ok'
}

/**
 * Build the compact two-signal summary used by the operator dashboard.
 * Pure function — safe to unit-test without Prometheus.
 */
export function buildWebhookLagDashboardSummary(input: {
  oldestAgeSeconds: number
  succeeded: number
  failed: number
}): WebhookLagDashboardSummary {
  const oldestAgeSeconds =
    Number.isFinite(input.oldestAgeSeconds) && input.oldestAgeSeconds >= 0
      ? input.oldestAgeSeconds
      : 0
  const successRate = computeWebhookSuccessRate(input.succeeded, input.failed)
  const lagStatus = classifyWebhookLag(oldestAgeSeconds)

  let status: WebhookLagStatus = lagStatus
  let reason = 'healthy'

  if (lagStatus === 'critical') {
    reason = `oldest queued age ${oldestAgeSeconds}s exceeds hard SLO (${WEBHOOK_LAG_HARD_SECONDS}s)`
  } else if (lagStatus === 'warn') {
    reason = `oldest queued age ${oldestAgeSeconds}s exceeds soft SLO (${WEBHOOK_LAG_SOFT_SECONDS}s)`
  }

  if (successRate !== null && successRate < WEBHOOK_SUCCESS_RATE_HARD) {
    status = 'critical'
    reason = `success rate ${(successRate * 100).toFixed(1)}% below hard floor (${WEBHOOK_SUCCESS_RATE_HARD * 100}%)`
  } else if (
    successRate !== null &&
    successRate < WEBHOOK_SUCCESS_RATE_SOFT &&
    status !== 'critical'
  ) {
    status = 'warn'
    reason = `success rate ${(successRate * 100).toFixed(1)}% below soft floor (${WEBHOOK_SUCCESS_RATE_SOFT * 100}%)`
  }

  return { oldestAgeSeconds, successRate, status, reason }
}

/**
 * PromQL snippets for the compact Grafana row. Exported so docs and
 * tests share identical queries (no copy-paste drift).
 */
export const WEBHOOK_LAG_DASHBOARD_PROMQL = {
  oldestAge: WEBHOOK_QUEUED_OLDEST_AGE_SECONDS,
  /** Prefer the dedicated gauge; fall back to the cross-domain series. */
  oldestAgeFallback: `jobs_oldest_pending_age_seconds{domain="webhook"}`,
  successRate: `
(
  sum(rate(webhook_delivery_outcome_total{result="success"}[${WEBHOOK_SUCCESS_RATE_WINDOW}]))
  /
  clamp_min(
    sum(rate(webhook_delivery_outcome_total[${WEBHOOK_SUCCESS_RATE_WINDOW}])),
    1e-9
  )
)
`.trim(),
  /**
   * Alternate success-rate query when only the cross-domain counters
   * are populated (e.g. before delivery paths call
   * {@link recordWebhookDeliveryOutcome}).
   */
  successRateFromJobs: `
(
  sum(rate(jobs_terminal_outcome_total{domain="webhook",outcome="succeeded"}[${WEBHOOK_SUCCESS_RATE_WINDOW}]))
  /
  clamp_min(
    sum(rate(jobs_terminal_outcome_total{domain="webhook"}[${WEBHOOK_SUCCESS_RATE_WINDOW}])),
    1e-9
  )
)
`.trim(),
} as const
