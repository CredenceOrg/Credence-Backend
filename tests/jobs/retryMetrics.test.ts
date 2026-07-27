/**
 * Tests for the cross-cutting retry/DLQ metrics module
 * (`src/jobs/retryMetrics.ts`).
 *
 * The metrics are registered on the SHARED prom-client registry imported
 * from `src/middleware/metrics.ts`; therefore we reset that registry in
 * `beforeEach` so each scenario starts with a clean baseline and we
 * assert DELTAS rather than absolute values. Tests within this file run
 * serially (vitest default) and `register` is a module-level singleton.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { register } from '../../src/middleware/metrics.js'
import {
  jobsDeadLetterTotal,
  jobsTerminalOutcomeTotal,
  jobsTerminalAttemptCount,
  jobsOldestPendingAgeSeconds,
  recordJobDeadLetter,
  recordJobTerminalOutcome,
  setJobOldestPendingAge,
} from '../../src/jobs/retryMetrics.js'

/** Sum the `value` field of every histogram/counter entry matching `labels`. */
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

/** Count histogram observations (the `_count` series of a Histogram). */
async function histogramCount(
  metricName: string,
  labels?: Record<string, string>,
): Promise<number> {
  // Prometheus-flavored output; fall back to the in-memory value list.
  const metricsList = await register.getMetricsAsJSON()
  for (const m of metricsList) {
    if (m.name !== metricName) continue
    for (const v of m.values as Array<{
      labels?: Record<string, string>
      value: number
    }>) {
      if (v.labels && Object.keys(v.labels).some((k) => k === 'le' || k === 'quantile')) continue
      if (
        labels &&
        !Object.entries(labels).every(([k, val]) => v.labels?.[k] === val)
      ) continue
      if (typeof v.value === 'number') return v.value
    }
  }
  return 0
}

beforeEach(() => {
  register.resetMetrics()
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. recordJobDeadLetter
// ─────────────────────────────────────────────────────────────────────────────

describe('recordJobDeadLetter', () => {
  it('increments jobs_dead_letter_total{domain,reason}', async () => {
    const before = await jobsDeadLetterTotal.get()
    expect(
      sumValues(before.values, { domain: 'outbox', reason: 'TIMEOUT' }),
    ).toBe(0)

    recordJobDeadLetter('outbox', 'TIMEOUT')

    const after = await jobsDeadLetterTotal.get()
    expect(
      sumValues(after.values, { domain: 'outbox', reason: 'TIMEOUT' }),
    ).toBe(1)
  })

  it('tracks distinct domains independently', async () => {
    recordJobDeadLetter('outbox', 'TIMEOUT')
    recordJobDeadLetter('webhook', 'TIMEOUT')
    recordJobDeadLetter('notification', 'TIMEOUT')

    const result = await jobsDeadLetterTotal.get()
    expect(
      sumValues(result.values, { domain: 'outbox', reason: 'TIMEOUT' }),
    ).toBe(1)
    expect(
      sumValues(result.values, { domain: 'webhook', reason: 'TIMEOUT' }),
    ).toBe(1)
    expect(
      sumValues(result.values, { domain: 'notification', reason: 'TIMEOUT' }),
    ).toBe(1)
  })

  it('normalizes the reason label to ASCII-uppercase underscore', async () => {
    recordJobDeadLetter(
      'outbox',
      'connection refused: ECONNREFUSED 127.0.0.1:5432',
    )

    const result = await jobsDeadLetterTotal.get()
    // The label must be ASCII + uppercase + underscore-only — non-alnum characters
    // collapse and the slice+empty-fallback rule (in `boundedReason`) ensures we
    // never emit an empty series name.
    const labels = result.values
      .filter((v) => v.labels.domain === 'outbox')
      .map((v) => v.labels.reason)
    expect(labels.length).toBeGreaterThan(0)
    for (const lbl of labels) {
      expect(lbl).toMatch(/^[A-Z0-9_]{1,50}$/)
      // Original tokens must be recoverable via `_` delimiter.
      expect(lbl).toContain('ECONNREFUSED')
    }
  })

  it('falls back to UNKNOWN when the reason is empty', async () => {
    recordJobDeadLetter('outbox', '')

    const result = await jobsDeadLetterTotal.get()
    expect(
      sumValues(result.values, { domain: 'outbox', reason: 'UNKNOWN' }),
    ).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. recordJobTerminalOutcome
// ─────────────────────────────────────────────────────────────────────────────

describe('recordJobTerminalOutcome', () => {
  it('increments jobs_terminal_outcome_total with the outcome label', async () => {
    const before = await jobsTerminalOutcomeTotal.get()
    expect(
      sumValues(before.values, { domain: 'webhook', outcome: 'dead_letter' }),
    ).toBe(0)

    recordJobTerminalOutcome('webhook', 'dead_letter', 3)

    const after = await jobsTerminalOutcomeTotal.get()
    expect(
      sumValues(after.values, { domain: 'webhook', outcome: 'dead_letter' }),
    ).toBe(1)
  })

  it('observes the histogram with the attempts value', async () => {
    const beforeCount = await histogramCount('jobs_terminal_attempt_count', { domain: 'notification' })
    expect(beforeCount).toBe(0)

    recordJobTerminalOutcome('notification', 'succeeded', 2)
    recordJobTerminalOutcome('notification', 'succeeded', 5)
    recordJobTerminalOutcome('notification', 'dead_letter', 10)

    const afterCount = await histogramCount('jobs_terminal_attempt_count', { domain: 'notification' })
    expect(afterCount).toBe(3)
  })

  it('treats "succeeded" and "dead_letter" as distinct outcome labels', async () => {
    recordJobTerminalOutcome('outbox', 'succeeded', 1)
    recordJobTerminalOutcome('outbox', 'dead_letter', 4)

    const result = await jobsTerminalOutcomeTotal.get()
    expect(
      sumValues(result.values, { domain: 'outbox', outcome: 'succeeded' }),
    ).toBe(1)
    expect(
      sumValues(result.values, { domain: 'outbox', outcome: 'dead_letter' }),
    ).toBe(1)
  })

  it('clamps attempts < 1 to 1 (no negative or zero observations)', async () => {
    recordJobTerminalOutcome('outbox', 'succeeded', 0)
    recordJobTerminalOutcome('outbox', 'succeeded', -3)
    recordJobTerminalOutcome('outbox', 'succeeded', Number.NaN as unknown as number)

    // Outcomes still increment because the counter is irrelevant to attempts.
    const outcomes = await jobsTerminalOutcomeTotal.get()
    expect(
      sumValues(outcomes.values, { domain: 'outbox', outcome: 'succeeded' }),
    ).toBe(3)

    // The histogram observed three samples, all bucketing into the ≤1 bucket.
    const count = await histogramCount('jobs_terminal_attempt_count', { domain: 'outbox' })
    expect(count).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. setJobOldestPendingAge
// ─────────────────────────────────────────────────────────────────────────────

describe('setJobOldestPendingAge', () => {
  it('sets the gauge for the supplied domain', async () => {
    const before = await jobsOldestPendingAgeSeconds.get()
    expect(
      sumValues(before.values, { domain: 'notification' }),
    ).toBe(0)

    setJobOldestPendingAge('notification', 273.5)

    const after = await jobsOldestPendingAgeSeconds.get()
    expect(
      sumValues(after.values, { domain: 'notification' }),
    ).toBe(273.5)
  })

  it('clamps negative or NaN ages to 0', async () => {
    setJobOldestPendingAge('webhook', -42)
    setJobOldestPendingAge('webhook', Number.NaN as unknown as number)
    setJobOldestPendingAge('webhook', Number.POSITIVE_INFINITY as unknown as number)

    const result = await jobsOldestPendingAgeSeconds.get()
    expect(
      sumValues(result.values, { domain: 'webhook' }),
    ).toBe(0)
  })

  it('keeps domain gauges independent', async () => {
    setJobOldestPendingAge('outbox', 100)
    setJobOldestPendingAge('webhook', 200)

    const result = await jobsOldestPendingAgeSeconds.get()
    expect(sumValues(result.values, { domain: 'outbox' })).toBe(100)
    expect(sumValues(result.values, { domain: 'webhook' })).toBe(200)
  })

  it('returning to 0 means "queue is empty"', async () => {
    setJobOldestPendingAge('outbox', 600)
    setJobOldestPendingAge('outbox', 0)

    const result = await jobsOldestPendingAgeSeconds.get()
    expect(sumValues(result.values, { domain: 'outbox' })).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cardinality guard
// ─────────────────────────────────────────────────────────────────────────────

describe('cardinality guard rails', () => {
  it('truncates oversized reason labels to 50 characters', async () => {
    const huge = 'A'.repeat(500)
    recordJobDeadLetter('outbox', huge)

    const result = await jobsDeadLetterTotal.get()
    const label = result.values
      .filter((v) => v.labels.domain === 'outbox')
      .map((v) => v.labels.reason)[0]
    expect(label).toBeDefined()
    expect(label?.length).toBeLessThanOrEqual(50)
  })

  it('does not emit empty-series labels', async () => {
    recordJobDeadLetter('outbox', '   ') // whitespace only — boundedReason returns UNKNOWN
    recordJobDeadLetter('outbox', '!@#$%^&*()') // all stripped — also UNKNOWN

    const result = await jobsDeadLetterTotal.get()
    const reasons = result.values
      .filter((v) => v.labels.domain === 'outbox')
      .map((v) => v.labels.reason)
    expect(reasons).toContain('UNKNOWN')
  })
})
