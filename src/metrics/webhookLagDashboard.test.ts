/**
 * Tests for the compact webhook lag dashboard summary module
 * (`src/metrics/webhookLagDashboard.ts`).
 *
 * Metrics register on the shared prom-client registry from
 * `src/middleware/metrics.ts`; `beforeEach` resets it so scenarios
 * start clean and we assert deltas rather than absolute values.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { register } from '../middleware/metrics.js'
import { jobsOldestPendingAgeSeconds } from '../jobs/retryMetrics.js'
import {
  WEBHOOK_QUEUED_OLDEST_AGE_SECONDS,
  WEBHOOK_DELIVERY_OUTCOME_TOTAL,
  WEBHOOK_LAG_SOFT_SECONDS,
  WEBHOOK_LAG_HARD_SECONDS,
  WEBHOOK_SUCCESS_RATE_SOFT,
  WEBHOOK_SUCCESS_RATE_HARD,
  WEBHOOK_LAG_DASHBOARD_PROMQL,
  webhookQueuedOldestAgeSeconds,
  webhookDeliveryOutcomeTotal,
  setWebhookQueuedOldestAge,
  recordWebhookDeliveryOutcome,
  computeWebhookSuccessRate,
  classifyWebhookLag,
  buildWebhookLagDashboardSummary,
} from './webhookLagDashboard.js'

function gaugeValue(
  values: Array<{ labels: Record<string, string>; value: number }>,
  labels?: Record<string, string>,
): number {
  const match = values.find((v) =>
    labels
      ? Object.entries(labels).every(([k, val]) => v.labels[k] === val)
      : Object.keys(v.labels).length === 0,
  )
  return match?.value ?? 0
}

function sumCounter(
  values: Array<{ labels: Record<string, string>; value: number }>,
  labels: Record<string, string>,
): number {
  return values
    .filter((v) =>
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
    )
    .reduce((sum, v) => sum + v.value, 0)
}

beforeEach(() => {
  register.resetMetrics()
})

describe('metric name contract', () => {
  it('pins the summary metric names used by the dashboard spec', () => {
    expect(WEBHOOK_QUEUED_OLDEST_AGE_SECONDS).toBe(
      'webhook_queued_oldest_age_seconds',
    )
    expect(WEBHOOK_DELIVERY_OUTCOME_TOTAL).toBe(
      'webhook_delivery_outcome_total',
    )
    expect(webhookQueuedOldestAgeSeconds.name).toBe(
      WEBHOOK_QUEUED_OLDEST_AGE_SECONDS,
    )
    expect(webhookDeliveryOutcomeTotal.name).toBe(
      WEBHOOK_DELIVERY_OUTCOME_TOTAL,
    )
  })

  it('keeps PromQL snippets aligned with metric names', () => {
    expect(WEBHOOK_LAG_DASHBOARD_PROMQL.oldestAge).toBe(
      WEBHOOK_QUEUED_OLDEST_AGE_SECONDS,
    )
    expect(WEBHOOK_LAG_DASHBOARD_PROMQL.successRate).toContain(
      WEBHOOK_DELIVERY_OUTCOME_TOTAL,
    )
    expect(WEBHOOK_LAG_DASHBOARD_PROMQL.successRate).toContain('result="success"')
    expect(WEBHOOK_LAG_DASHBOARD_PROMQL.oldestAgeFallback).toContain(
      'domain="webhook"',
    )
  })
})

describe('setWebhookQueuedOldestAge', () => {
  it('publishes a non-negative age on the dedicated gauge', async () => {
    setWebhookQueuedOldestAge(42.5)
    const after = await webhookQueuedOldestAgeSeconds.get()
    expect(gaugeValue(after.values)).toBe(42.5)
  })

  it('mirrors into jobs_oldest_pending_age_seconds{domain="webhook"}', async () => {
    setWebhookQueuedOldestAge(90)
    const after = await jobsOldestPendingAgeSeconds.get()
    expect(gaugeValue(after.values, { domain: 'webhook' })).toBe(90)
  })

  it('clamps negative / non-finite ages to 0', async () => {
    setWebhookQueuedOldestAge(-1)
    setWebhookQueuedOldestAge(Number.NaN)
    setWebhookQueuedOldestAge(Number.POSITIVE_INFINITY)
    const after = await webhookQueuedOldestAgeSeconds.get()
    expect(gaugeValue(after.values)).toBe(0)
  })

  it('allows resetting to 0 when the queue drains', async () => {
    setWebhookQueuedOldestAge(600)
    setWebhookQueuedOldestAge(0)
    const after = await webhookQueuedOldestAgeSeconds.get()
    expect(gaugeValue(after.values)).toBe(0)
  })
})

describe('recordWebhookDeliveryOutcome', () => {
  it('increments webhook_delivery_outcome_total{result}', async () => {
    recordWebhookDeliveryOutcome('success')
    recordWebhookDeliveryOutcome('failure')
    recordWebhookDeliveryOutcome('success')

    const after = await webhookDeliveryOutcomeTotal.get()
    expect(sumCounter(after.values, { result: 'success' })).toBe(2)
    expect(sumCounter(after.values, { result: 'failure' })).toBe(1)
  })

  it('does not invent high-cardinality labels', async () => {
    recordWebhookDeliveryOutcome('success')
    const after = await webhookDeliveryOutcomeTotal.get()
    for (const v of after.values) {
      expect(Object.keys(v.labels)).toEqual(['result'])
      expect(['success', 'failure']).toContain(v.labels.result)
    }
  })
})

describe('computeWebhookSuccessRate', () => {
  it('returns null when there were no attempts', () => {
    expect(computeWebhookSuccessRate(0, 0)).toBeNull()
    expect(computeWebhookSuccessRate(-1, -2)).toBeNull()
  })

  it('computes the success ratio', () => {
    expect(computeWebhookSuccessRate(99, 1)).toBeCloseTo(0.99)
    expect(computeWebhookSuccessRate(1, 0)).toBe(1)
    expect(computeWebhookSuccessRate(0, 1)).toBe(0)
  })
})

describe('classifyWebhookLag', () => {
  it('maps ages onto soft/hard SLO fence-posts', () => {
    expect(classifyWebhookLag(0)).toBe('ok')
    expect(classifyWebhookLag(WEBHOOK_LAG_SOFT_SECONDS - 1)).toBe('ok')
    expect(classifyWebhookLag(WEBHOOK_LAG_SOFT_SECONDS)).toBe('warn')
    expect(classifyWebhookLag(WEBHOOK_LAG_HARD_SECONDS - 1)).toBe('warn')
    expect(classifyWebhookLag(WEBHOOK_LAG_HARD_SECONDS)).toBe('critical')
  })
})

describe('buildWebhookLagDashboardSummary', () => {
  it('reports ok when age and success rate are healthy', () => {
    const summary = buildWebhookLagDashboardSummary({
      oldestAgeSeconds: 5,
      succeeded: 100,
      failed: 0,
    })
    expect(summary.status).toBe('ok')
    expect(summary.successRate).toBe(1)
    expect(summary.oldestAgeSeconds).toBe(5)
    expect(summary.reason).toBe('healthy')
  })

  it('warns when age crosses the soft SLO', () => {
    const summary = buildWebhookLagDashboardSummary({
      oldestAgeSeconds: WEBHOOK_LAG_SOFT_SECONDS,
      succeeded: 100,
      failed: 0,
    })
    expect(summary.status).toBe('warn')
    expect(summary.reason).toContain('soft SLO')
  })

  it('goes critical when success rate falls below the hard floor', () => {
    // 94 successes / 6 failures = 0.94 < WEBHOOK_SUCCESS_RATE_HARD (0.95)
    const summary = buildWebhookLagDashboardSummary({
      oldestAgeSeconds: 10,
      succeeded: 94,
      failed: 6,
    })
    expect(summary.successRate!).toBeLessThan(WEBHOOK_SUCCESS_RATE_HARD)
    expect(summary.status).toBe('critical')
    expect(summary.reason).toContain('hard floor')
  })

  it('warns (not critical) when success rate is between soft and hard floors', () => {
    // 98 / 100 = 0.98 → below soft (0.99), above hard (0.95)
    const summary = buildWebhookLagDashboardSummary({
      oldestAgeSeconds: 10,
      succeeded: 98,
      failed: 2,
    })
    expect(summary.successRate!).toBeLessThan(WEBHOOK_SUCCESS_RATE_SOFT)
    expect(summary.successRate!).toBeGreaterThanOrEqual(WEBHOOK_SUCCESS_RATE_HARD)
    expect(summary.status).toBe('warn')
  })

  it('treats missing attempts as null success rate without forcing critical', () => {
    const summary = buildWebhookLagDashboardSummary({
      oldestAgeSeconds: 0,
      succeeded: 0,
      failed: 0,
    })
    expect(summary.successRate).toBeNull()
    expect(summary.status).toBe('ok')
  })
})
