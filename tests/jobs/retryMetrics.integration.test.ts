/**
 * Integration test for the cross-cutting retry/DLQ metrics
 * (`src/jobs/retryMetrics.ts`).
 *
 * Goal: prove that the WEBHOOK wiring in `src/services/webhooks/service.ts`
 * actually invokes the cross-cutting helpers at the DLQ-push callsite.
 * Unit tests in `tests/jobs/retryMetrics.test.ts` verify the helpers in
 * isolation; without THIS test, a regression that disconnects
 * `service.ts` from the metric helpers would pass every unit test
 * while silently breaking operator dashboards.
 *
 * Outbox and notifications callsites are intentionally NOT covered by
 * this integration test (they require pg-mem / DI setup beyond the
 * scope of the focused PR). A follow-up PR can add end-to-end smoke
 * tests for those paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.mock is hoisted BEFORE the static imports below, so `deliverWebhook`
// is replaced before `service.ts` (which imports `delivery.js`) runs.
// Static import of `service.ts` is intentional — pulling in the same
// module the production app uses.
vi.mock('../../src/services/webhooks/delivery.js', () => ({
  deliverWebhook: vi.fn(),
}))

import { WebhookService } from '../../src/services/webhooks/service.js'
import type {
  WebhookStore,
  WebhookConfig,
  WebhookEventType,
  WebhookPayload,
  WebhookDeliveryResult,
  DlqStore,
  DlqEntry,
} from '../../src/services/webhooks/types.js'
import { deliverWebhook } from '../../src/services/webhooks/delivery.js'
import { register } from '../../src/middleware/metrics.js'
import {
  jobsDeadLetterTotal,
  jobsTerminalOutcomeTotal,
} from '../../src/jobs/retryMetrics.js'

class InMemoryDlqStore implements DlqStore {
  public readonly entries: DlqEntry[] = []
  private id = 0

  async push(entry: DlqEntry): Promise<void> {
    this.entries.push({ ...entry, id: entry.id || `dlq-${++this.id}` })
  }
  async list(): Promise<DlqEntry[]> { return this.entries }
  async get(id: string): Promise<DlqEntry | null> {
    return this.entries.find((e) => e.id === id) ?? null
  }
  async markReplayed(id: string, replayedAt: string): Promise<void> {
    const e = this.entries.find((x) => x.id === id)
    if (e) e.replayedAt = replayedAt
  }
}

function stubWebhookStore(active: WebhookConfig[]): WebhookStore {
  const map = new Map<string, WebhookConfig>(active.map((w) => [w.id, w]))
  return {
    getByEvent: async (_e: WebhookEventType) => active,
    get: async (id: string) => map.get(id) ?? null,
    set: async (c: WebhookConfig) => { map.set(c.id, c) },
    rotateSecret: async (id) => {
      const w = map.get(id)
      if (!w) throw new Error('Webhook not found')
      return w
    },
    reserveWebhookDelivery: async () => true,
    clearWebhookDeliveryAttempt: async () => {},
  }
}

/** Sum the value field of every metric entry matching `labels`. */
function sumValues(
  values: Array<{ labels: Record<string, string>; value: number }>,
  labels?: Record<string, string>,
): number {
  return values
    .filter((v) =>
      labels ? Object.entries(labels).every(([k, val]) => v.labels[k] === val) : true,
    )
    .reduce((sum, v) => sum + v.value, 0)
}

/** Number of observations on a Histogram metric with the given labels. */
async function histogramObservations(
  metricName: string,
  labels: Record<string, string>,
): Promise<number> {
  const metricsList = await register.getMetricsAsJSON()
  for (const m of metricsList) {
    if (m.name !== metricName) continue
    for (const v of m.values as Array<{
      labels?: Record<string, string>
      value: number
    }>) {
      const vLabels = v.labels ?? {}
      // Skip bucket/quantile subseries — we only want the _count series.
      if (vLabels.le !== undefined || vLabels.quantile !== undefined) continue
      if (
        !Object.entries(labels).every(([k, val]) => vLabels[k] === val)
      ) continue
      if (typeof v.value === 'number') return v.value
    }
  }
  return 0
}

const mockDeliverWebhook = vi.mocked(deliverWebhook)

beforeEach(() => {
  register.resetMetrics()
  mockDeliverWebhook.mockReset()
})

describe('ret r y metrics — webhook DLQ wiring smoke test', () => {
  it('records jobs_dead_letter_total + jobs_terminal_outcome_total + jobs_terminal_attempt_count histogram when emit() pushes a failed delivery to the DLQ', async () => {
    const webhook: WebhookConfig = {
      id: 'wh-test-1',
      url: 'https://example.invalid/hook',
      events: ['bond.created'],
      secret: 's3cret',
      secretUpdatedAt: new Date(),
      active: true,
    }
    const store = stubWebhookStore([webhook])
    const dlq = new InMemoryDlqStore()

    // Failed delivery: 3 attempts, clear error message — exercising both
    // the histogram (attempts=3) and the reason label normalization.
    const failedResult: WebhookDeliveryResult = {
      webhookId: webhook.id,
      success: false,
      attempts: 3,
      statusCode: 503,
      error: 'ConnectionError: 503 Service Unavailable',
    }
    mockDeliverWebhook.mockResolvedValueOnce([failedResult])

    const service = new WebhookService(store, {}, dlq)

    await service.emit('bond.created', {
      address: 'G' + 'A'.repeat(55),
      bondedAmount: '1000',
      bondStart: null,
      bondDuration: null,
      active: true,
    })

    // DLQ side: exactly one entry with the right attempts count.
    expect(dlq.entries).toHaveLength(1)
    const [entry] = dlq.entries
    expect(entry).toBeDefined()
    expect(entry!.attempts).toBe(3)
    expect(entry!.lastError).toBe(failedResult.error)

    // Counter side: jobs_dead_letter_total{domain="webhook"} incremented
    // by exactly 1 with the normalized reason label.
    const dlqMetric = await jobsDeadLetterTotal.get()
    const webhookDlqLabels = dlqMetric.values
      .filter((v) => v.labels.domain === 'webhook')
      .map((v) => v.labels.reason)
    expect(webhookDlqLabels).toHaveLength(1)
    expect(webhookDlqLabels[0]).toMatch(/^CONNECTIONERROR/)

    // Counter side: jobs_terminal_outcome_total{outcome="dead_letter"}+1.
    const outcomeMetric = await jobsTerminalOutcomeTotal.get()
    expect(
      sumValues(outcomeMetric.values, {
        domain: 'webhook',
        outcome: 'dead_letter',
      }),
    ).toBe(1)

    // Histogram side: jobs_terminal_attempt_count observed EXACTLY ONCE
    // for `domain="webhook"`. A regression that swapped
    // `recordJobTerminalOutcome(..., attempts)` for a hard-coded
    // `recordJobTerminalOutcome(..., 1)` would still pass the
    // counter checks above — only this histogram assertion catches it.
    expect(
      await histogramObservations('jobs_terminal_attempt_count', { domain: 'webhook' }),
    ).toBe(1)
  })

  it('does NOT increment DLQ metrics when delivery succeeds', async () => {
    const webhook: WebhookConfig = {
      id: 'wh-success',
      url: 'https://example.invalid/hook',
      events: ['bond.created'],
      secret: 's',
      secretUpdatedAt: new Date(),
      active: true,
    }
    const store = stubWebhookStore([webhook])
    const dlq = new InMemoryDlqStore()

    const successResult: WebhookDeliveryResult = {
      webhookId: webhook.id,
      success: true,
      attempts: 1,
      statusCode: 200,
    }
    mockDeliverWebhook.mockResolvedValueOnce([successResult])

    const service = new WebhookService(store, {}, dlq)
    await service.emit('bond.created', {
      address: 'G' + 'A'.repeat(55),
      bondedAmount: '1',
      bondStart: null,
      bondDuration: null,
      active: true,
    })

    expect(dlq.entries).toHaveLength(0)

    const dlqMetric = await jobsDeadLetterTotal.get()
    expect(
      sumValues(dlqMetric.values, { domain: 'webhook' }),
    ).toBe(0)

    const outcomeMetric = await jobsTerminalOutcomeTotal.get()
    expect(
      sumValues(outcomeMetric.values, { domain: 'webhook', outcome: 'dead_letter' }),
    ).toBe(0)
  })
})
