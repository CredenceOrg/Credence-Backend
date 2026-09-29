/**
 * Boundary, validation, and recovery tests for
 * `src/jobs/failedInboundEventsSweeperMetrics.ts`.
 *
 * The metrics are registered on the SHARED prom-client registry imported from
 * `src/middleware/metrics.ts`, so `beforeEach` resets that registry and every
 * assertion is made against a clean baseline. Vitest isolates test files, so
 * resetting the shared registry here cannot leak into other suites.
 *
 * Covered scenarios:
 *  - success: each wrapper method records exactly what it promises
 *  - rejection: invalid samples are dropped, never recorded and never thrown
 *  - boundary: histogram bucket edges are inclusive (`le`) and the `+Inf`
 *    overflow bucket accounts for samples above the largest bound
 *  - recovery: a rejected sample cannot poison a shared series, and the
 *    metrics resume correctly after `register.resetMetrics()`
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { register } from '../../src/middleware/metrics.js'
import {
  failedInboundSweeperRunsTotal,
  failedInboundSweeperDurationSeconds,
  failedInboundSweptTotal,
  failedInboundRetainedTotal,
  createFailedInboundSweeperMetrics,
  type FailedInboundSweeperMetrics,
} from '../../src/jobs/failedInboundEventsSweeperMetrics.js'

const HISTOGRAM_NAME = 'failed_inbound_sweeper_duration_seconds'

/** The histogram's declared finite bucket bounds, in ascending order. */
const BOUNDS = [0.1, 0.5, 1, 2, 5, 10, 30, 60]

type Sample = {
  value: number
  labels?: Record<string, string | number>
  metricName?: string
}

type MetricWithValues = {
  name: string
  type: string
  values: Sample[]
}

async function read(metric: {
  get: () => Promise<unknown>
}): Promise<MetricWithValues> {
  return (await metric.get()) as MetricWithValues
}

/** Sum every series of an unlabeled counter (there is at most one). */
async function counterTotal(metric: {
  get: () => Promise<unknown>
}): Promise<number> {
  const { values } = await read(metric)
  return values.reduce((sum, sample) => sum + sample.value, 0)
}

type HistogramSnapshot = {
  /** Cumulative `le` bucket counts, keyed by the bound (or `+Inf`). */
  buckets: Record<string, number>
  count: number
  sum: number
}

/**
 * Read a histogram via its exported samples. Bucket series carry
 * `metricName = <name>_bucket` and a `le` label; `_sum`/`_count` carry empty
 * labels, so we dispatch on the metricName suffix.
 */
async function histogramSnapshot(): Promise<HistogramSnapshot> {
  const { values } = await read(failedInboundSweeperDurationSeconds)
  const buckets: Record<string, number> = {}
  let count = 0
  let sum = 0

  for (const sample of values) {
    const le = sample.labels?.le
    if (sample.metricName?.endsWith('_bucket') && le !== undefined) {
      buckets[String(le)] = sample.value
    } else if (sample.metricName?.endsWith('_sum')) {
      sum = sample.value
    } else if (sample.metricName?.endsWith('_count')) {
      count = sample.value
    }
  }

  return { buckets, count, sum }
}

beforeEach(() => {
  register.resetMetrics()
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. Metric contract (names/stability dashboards depend on)
// ─────────────────────────────────────────────────────────────────────────────

describe('metric contract', () => {
  it('keeps the metric names and types stable', async () => {
    expect(failedInboundSweeperRunsTotal.name).toBe(
      'failed_inbound_sweeper_runs_total',
    )
    expect(failedInboundSweeperDurationSeconds.name).toBe(HISTOGRAM_NAME)
    expect(failedInboundSweptTotal.name).toBe('failed_inbound_swept_total')
    expect(failedInboundRetainedTotal.name).toBe('failed_inbound_retained_total')

    expect(failedInboundSweeperRunsTotal.type).toBe('counter')
    expect(failedInboundSweeperDurationSeconds.type).toBe('histogram')
    expect(failedInboundSweptTotal.type).toBe('counter')
    expect(failedInboundRetainedTotal.type).toBe('counter')
  })

  it('exposes exactly the four documented handle methods', () => {
    const handle: FailedInboundSweeperMetrics =
      createFailedInboundSweeperMetrics()

    expect(Object.keys(handle).sort()).toEqual(
      ['incRuns', 'incSwept', 'observeDuration', 'setRetained'].sort(),
    )
    for (const method of Object.values(handle)) {
      expect(typeof method).toBe('function')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. incRuns — success + monotonic accumulation across runs
// ─────────────────────────────────────────────────────────────────────────────

describe('incRuns', () => {
  it('starts at zero and increments by exactly one per run', async () => {
    expect(await counterTotal(failedInboundSweeperRunsTotal)).toBe(0)

    const { incRuns } = createFailedInboundSweeperMetrics()
    incRuns()
    expect(await counterTotal(failedInboundSweeperRunsTotal)).toBe(1)

    for (let i = 0; i < 99; i += 1) incRuns()
    expect(await counterTotal(failedInboundSweeperRunsTotal)).toBe(100)
  })

  it('accumulates across independent handles instead of resetting per run', async () => {
    // The sweeper is long-lived; each tick reuses one handle, but a re-created
    // handle must not start a second, separate series.
    createFailedInboundSweeperMetrics().incRuns()
    createFailedInboundSweeperMetrics().incRuns()
    createFailedInboundSweeperMetrics().incRuns()

    expect(await counterTotal(failedInboundSweeperRunsTotal)).toBe(3)
    const { values } = await read(failedInboundSweeperRunsTotal)
    expect(values).toHaveLength(1)
    expect(values[0].labels).toEqual({})
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. observeDuration — bucket boundaries (inclusive `le`, cumulative)
// ─────────────────────────────────────────────────────────────────────────────

describe('observeDuration', () => {
  it('places a sample equal to a bound in that bound\'s bucket (inclusive le)', async () => {
    const { observeDuration } = createFailedInboundSweeperMetrics()

    // One sample exactly on each finite bound.
    for (const bound of BOUNDS) observeDuration(bound)

    const { buckets, count } = await histogramSnapshot()
    BOUNDS.forEach((bound, index) => {
      expect(buckets[String(bound)]).toBe(index + 1)
    })
    expect(buckets['+Inf']).toBe(BOUNDS.length)
    expect(count).toBe(BOUNDS.length)
  })

  it('routes a sample just above a bound to the next finite bucket', async () => {
    const { observeDuration } = createFailedInboundSweeperMetrics()

    observeDuration(0.1000001) // > 0.1 but <= 0.5
    observeDuration(2.0000001) // > 2 but <= 5

    const { buckets, count } = await histogramSnapshot()
    expect(buckets['0.1']).toBe(0)
    expect(buckets['0.5']).toBe(1)
    expect(buckets['5']).toBe(2)
    expect(buckets['60']).toBe(2)
    expect(buckets['+Inf']).toBe(2)
    expect(count).toBe(2)
  })

  it('counts zero and sub-bucket durations in the smallest bucket', async () => {
    const { observeDuration } = createFailedInboundSweeperMetrics()

    observeDuration(0)
    observeDuration(1e-9)
    observeDuration(0.1)

    const { buckets, count } = await histogramSnapshot()
    expect(buckets['0.1']).toBe(3)
    expect(buckets['60']).toBe(3)
    expect(count).toBe(3)
  })

  it('accounts for samples above the largest bound only in +Inf and _count', async () => {
    const { observeDuration } = createFailedInboundSweeperMetrics()

    observeDuration(60) // boundary — inclusive
    observeDuration(60.0001) // overflow

    const { buckets, count, sum } = await histogramSnapshot()
    expect(buckets['60']).toBe(1)
    for (const bound of BOUNDS) {
      // Cumulative finite buckets must never exceed the true count.
      expect(buckets[String(bound)]).toBeLessThanOrEqual(count)
    }
    expect(buckets['+Inf']).toBe(2)
    expect(count).toBe(2)
    expect(sum).toBeCloseTo(120.0001, 4)
  })

  it('tracks sum and count deterministically across repeated observations', async () => {
    const { observeDuration } = createFailedInboundSweeperMetrics()

    const samples = [0.05, 0.2, 1.5, 3, 7.25, 12, 45, 90]
    for (const value of samples) observeDuration(value)

    const { buckets, count, sum } = await histogramSnapshot()
    expect(count).toBe(samples.length)
    expect(sum).toBeCloseTo(
      samples.reduce((acc, value) => acc + value, 0),
      6,
    )
    // 90 is the only overflow sample.
    expect(buckets['+Inf']).toBe(samples.length)
    expect(buckets['60']).toBe(samples.length - 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Counter deltas — success + rejection of invalid samples
// ─────────────────────────────────────────────────────────────────────────────

describe('incSwept', () => {
  it('increments by the supplied count, including zero and large batches', async () => {
    const { incSwept } = createFailedInboundSweeperMetrics()

    incSwept(0)
    expect(await counterTotal(failedInboundSweptTotal)).toBe(0)

    incSwept(1)
    incSwept(1_000_000)
    expect(await counterTotal(failedInboundSweptTotal)).toBe(1_000_001)
  })

  it('rejects negative, NaN, and infinite counts without throwing', async () => {
    const { incSwept } = createFailedInboundSweeperMetrics()

    expect(() => incSwept(-1)).not.toThrow()
    expect(() => incSwept(Number.NaN)).not.toThrow()
    expect(() => incSwept(Number.POSITIVE_INFINITY)).not.toThrow()
    expect(() => incSwept(Number.NEGATIVE_INFINITY)).not.toThrow()

    expect(await counterTotal(failedInboundSweptTotal)).toBe(0)
  })

  it('never records a NaN sample (regression: NaN poisons the shared series)', async () => {
    const { incSwept } = createFailedInboundSweeperMetrics()

    incSwept(Number.NaN)
    incSwept(5)

    const total = await counterTotal(failedInboundSweptTotal)
    expect(Number.isNaN(total)).toBe(false)
    expect(total).toBe(5)
  })
})

describe('setRetained', () => {
  it('accumulates per-run retained counts (counter semantics)', async () => {
    const { setRetained } = createFailedInboundSweeperMetrics()

    setRetained(3)
    setRetained(2)
    expect(await counterTotal(failedInboundRetainedTotal)).toBe(5)

    // A run that retains nothing is a no-op, not a reset.
    setRetained(0)
    expect(await counterTotal(failedInboundRetainedTotal)).toBe(5)
  })

  it('drops invalid retained counts without throwing', async () => {
    const { setRetained } = createFailedInboundSweeperMetrics()

    expect(() => setRetained(-5)).not.toThrow()
    expect(() => setRetained(Number.NaN)).not.toThrow()
    expect(() => setRetained(Number.POSITIVE_INFINITY)).not.toThrow()

    expect(await counterTotal(failedInboundRetainedTotal)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Recovery — invalid input and registry resets must not corrupt state
// ─────────────────────────────────────────────────────────────────────────────

describe('recovery', () => {
  it('keeps a series usable after a rejected sample', async () => {
    const { incSwept, setRetained, observeDuration } =
      createFailedInboundSweeperMetrics()

    incSwept(Number.NaN)
    setRetained(Number.NEGATIVE_INFINITY)
    observeDuration(Number.NaN)

    // Subsequent valid instrumentation must land normally.
    incSwept(4)
    setRetained(2)
    observeDuration(0.25)

    expect(await counterTotal(failedInboundSweptTotal)).toBe(4)
    expect(await counterTotal(failedInboundRetainedTotal)).toBe(2)

    const { buckets, count, sum } = await histogramSnapshot()
    expect(count).toBe(1)
    expect(sum).toBeCloseTo(0.25, 6)
    expect(buckets['0.5']).toBe(1)
  })

  it('resets to a clean baseline and resumes counting after register.resetMetrics()', async () => {
    const { incRuns, incSwept, observeDuration } =
      createFailedInboundSweeperMetrics()

    incRuns()
    incSwept(7)
    observeDuration(3)

    register.resetMetrics()

    expect(await counterTotal(failedInboundSweeperRunsTotal)).toBe(0)
    expect(await counterTotal(failedInboundSweptTotal)).toBe(0)
    const cleared = await histogramSnapshot()
    expect(cleared.count).toBe(0)
    expect(cleared.sum).toBe(0)

    incRuns()
    incSwept(1)
    observeDuration(0.05)

    expect(await counterTotal(failedInboundSweeperRunsTotal)).toBe(1)
    expect(await counterTotal(failedInboundSweptTotal)).toBe(1)
    const resumed = await histogramSnapshot()
    expect(resumed.count).toBe(1)
    expect(resumed.buckets['0.1']).toBe(1)
  })

  it('produces identical exports for identical inputs (determinism)', async () => {
    const first = createFailedInboundSweeperMetrics()
    first.incSwept(10)
    first.setRetained(2)
    first.observeDuration(1)
    first.observeDuration(4)
    const before = {
      swept: await counterTotal(failedInboundSweptTotal),
      retained: await counterTotal(failedInboundRetainedTotal),
      histogram: await histogramSnapshot(),
    }

    register.resetMetrics()

    const second = createFailedInboundSweeperMetrics()
    second.incSwept(10)
    second.setRetained(2)
    second.observeDuration(1)
    second.observeDuration(4)
    const after = {
      swept: await counterTotal(failedInboundSweptTotal),
      retained: await counterTotal(failedInboundRetainedTotal),
      histogram: await histogramSnapshot(),
    }

    expect(after).toEqual(before)
  })
})
