/**
 * Boundary, validation, and recovery tests for
 * `src/jobs/backupVerifyMetrics.ts`.
 *
 * The metrics are registered on the SHARED prom-client registry imported from
 * `src/middleware/metrics.ts`, so `beforeEach` resets that registry and every
 * assertion is made against a clean baseline. Vitest isolates test files, so
 * resetting the shared registry here cannot leak into other suites.
 *
 * The only production caller is `scripts/restore-verify.ts` (the weekly
 * restore-verify drill). The drill runs in a `try/catch/finally` whose cleanup
 * (temp dir removal, pool shutdown) must never be skipped, so the metrics
 * handle is contractually "never throws": invalid input is dropped or
 * normalized instead of surfacing as an exception that the drill's `catch`
 * would misclassify as a drill failure.
 *
 * Covered scenarios:
 *  - success: each wrapper method records exactly what it promises
 *  - rejection: invalid samples are dropped, never recorded and never thrown
 *  - boundary: histogram bucket edges are inclusive (`le`) and the `+Inf`
 *    overflow bucket accounts for samples above the largest bound
 *  - cardinality: unexpected failure steps collapse onto `unknown` instead of
 *    minting unbounded label series
 *  - recovery: a rejected sample cannot poison a shared series, concurrent
 *    handles observe one coherent series, and the metrics resume correctly
 *    after `register.resetMetrics()`
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { register } from '../../src/middleware/metrics.js'
import {
  backupRestoreVerifySeconds,
  backupRestoreFailedTotal,
  createBackupVerifyMetrics,
  FAILURE_STEPS,
  type BackupVerifyMetrics,
} from '../../src/jobs/backupVerifyMetrics.js'

const HISTOGRAM_NAME = 'backup_restore_verify_seconds'

/** The histogram's declared finite bucket bounds, in ascending order. */
const BOUNDS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300]

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
  const { values } = await read(backupRestoreVerifySeconds)
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

/** Cumulative counter value per `step` label value (empty before first inc). */
async function failureTotals(): Promise<Record<string, number>> {
  const { values } = await read(backupRestoreFailedTotal)
  const totals: Record<string, number> = {}
  for (const sample of values) {
    const step = sample.labels?.step
    if (typeof step !== 'string') continue
    totals[step] = (totals[step] ?? 0) + sample.value
  }
  return totals
}

beforeEach(() => {
  register.resetMetrics()
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. Metric contract (names/stability dashboards depend on)
// ─────────────────────────────────────────────────────────────────────────────

describe('metric contract', () => {
  it('keeps the metric names and types stable', async () => {
    expect(backupRestoreVerifySeconds.name).toBe(HISTOGRAM_NAME)
    expect(backupRestoreFailedTotal.name).toBe('backup_restore_failed_total')

    expect(backupRestoreVerifySeconds.type).toBe('histogram')
    expect(backupRestoreFailedTotal.type).toBe('counter')
  })

  it('exposes exactly the two documented handle methods', () => {
    const handle: BackupVerifyMetrics = createBackupVerifyMetrics()

    expect(Object.keys(handle).sort()).toEqual(
      ['incFailure', 'observeDuration'].sort(),
    )
    for (const method of Object.values(handle)) {
      expect(typeof method).toBe('function')
    }
  })

  it('keeps the failure-step vocabulary closed', () => {
    // The known steps are exactly what scripts/restore-verify.ts reports.
    expect([...FAILURE_STEPS].sort()).toEqual(['checksum', 'row_count', 'unknown'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. observeDuration — bucket boundaries (inclusive `le`, cumulative)
// ─────────────────────────────────────────────────────────────────────────────

describe('observeDuration', () => {
  it('starts at an empty baseline before any observation', async () => {
    const { buckets, count, sum } = await histogramSnapshot()
    expect(count).toBe(0)
    expect(sum).toBe(0)
    for (const bound of BOUNDS) {
      expect(buckets[String(bound)] ?? 0).toBe(0)
    }
  })

  it('places a sample equal to a bound in that bound\'s bucket (inclusive le)', async () => {
    const { observeDuration } = createBackupVerifyMetrics()

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
    const { observeDuration } = createBackupVerifyMetrics()

    observeDuration(0.5000001) // > 0.5 but <= 1
    observeDuration(2.0000001) // > 2 but <= 5

    const { buckets, count } = await histogramSnapshot()
    expect(buckets['0.5']).toBe(0)
    expect(buckets['1']).toBe(1)
    expect(buckets['5']).toBe(2)
    expect(buckets['300']).toBe(2)
    expect(buckets['+Inf']).toBe(2)
    expect(count).toBe(2)
  })

  it('counts zero and sub-bucket durations in the smallest bucket', async () => {
    const { observeDuration } = createBackupVerifyMetrics()

    observeDuration(0)
    observeDuration(1e-9)
    observeDuration(0.5)

    const { buckets, count } = await histogramSnapshot()
    expect(buckets['0.5']).toBe(3)
    expect(buckets['300']).toBe(3)
    expect(count).toBe(3)
  })

  it('accounts for samples above the largest bound only in +Inf and _count', async () => {
    const { observeDuration } = createBackupVerifyMetrics()

    observeDuration(300) // boundary — inclusive
    observeDuration(300.0001) // overflow

    const { buckets, count, sum } = await histogramSnapshot()
    expect(buckets['300']).toBe(1)
    for (const bound of BOUNDS) {
      // Cumulative finite buckets must never exceed the true count.
      expect(buckets[String(bound)]).toBeLessThanOrEqual(count)
    }
    expect(buckets['+Inf']).toBe(2)
    expect(count).toBe(2)
    expect(sum).toBeCloseTo(600.0001, 4)
  })

  it('tracks sum and count deterministically across repeated observations', async () => {
    const { observeDuration } = createBackupVerifyMetrics()

    const samples = [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 301]
    for (const value of samples) observeDuration(value)

    const { buckets, count, sum } = await histogramSnapshot()
    expect(count).toBe(samples.length)
    expect(sum).toBeCloseTo(
      samples.reduce((acc, value) => acc + value, 0),
      6,
    )
    // Cumulative ladder: the k-th bound has seen at least k samples, and only
    // the last sample (301) overflows past `300`.
    expect(buckets['0.5']).toBe(2)
    expect(buckets['300']).toBe(samples.length - 1)
    expect(buckets['+Inf']).toBe(samples.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. observeDuration — rejection of invalid samples (never throws)
// ─────────────────────────────────────────────────────────────────────────────

describe('observeDuration rejection', () => {
  it('drops negative, NaN, and infinite durations without throwing', async () => {
    const { observeDuration } = createBackupVerifyMetrics()

    expect(() => observeDuration(-1)).not.toThrow()
    expect(() => observeDuration(Number.NaN)).not.toThrow()
    expect(() => observeDuration(Number.POSITIVE_INFINITY)).not.toThrow()
    expect(() => observeDuration(Number.NEGATIVE_INFINITY)).not.toThrow()

    const { count, sum } = await histogramSnapshot()
    expect(count).toBe(0)
    expect(sum).toBe(0)
  })

  it('drops non-number samples without throwing', async () => {
    const { observeDuration } = createBackupVerifyMetrics()

    // Runtime hardening for JS callers; TypeScript callers cannot produce
    // these without a cast.
    expect(() => observeDuration(undefined as unknown as number)).not.toThrow()
    expect(() => observeDuration(null as unknown as number)).not.toThrow()
    expect(() => observeDuration(Number('12s') as unknown as number)).not.toThrow()

    const { count, sum } = await histogramSnapshot()
    expect(count).toBe(0)
    expect(sum).toBe(0)
  })

  it('never records a NaN sample (regression: NaN poisons the shared series)', async () => {
    const { observeDuration } = createBackupVerifyMetrics()

    observeDuration(Number.NaN)
    observeDuration(1.5)

    const { count, sum } = await histogramSnapshot()
    // A raw prom-client histogram would turn `_sum` into NaN for the
    // lifetime of the process; the wrapper must drop the sample instead.
    expect(Number.isNaN(sum)).toBe(false)
    expect(count).toBe(1)
    expect(sum).toBeCloseTo(1.5, 6)
    expect((await histogramSnapshot()).buckets['2']).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. incFailure — success + label cardinality bounds
// ─────────────────────────────────────────────────────────────────────────────

describe('incFailure', () => {
  it('starts with no series before any failure is recorded', async () => {
    const totals = await failureTotals()
    expect(Object.keys(totals)).toHaveLength(0)
  })

  it('increments the labeled series for each known step', async () => {
    const { incFailure } = createBackupVerifyMetrics()

    incFailure('row_count')
    incFailure('checksum')
    incFailure('checksum')

    const totals = await failureTotals()
    expect(totals['row_count']).toBe(1)
    expect(totals['checksum']).toBe(2)
  })

  it('tracks distinct steps independently', async () => {
    const { incFailure } = createBackupVerifyMetrics()

    incFailure('row_count')
    incFailure('checksum')
    incFailure('row_count')

    const totals = await failureTotals()
    expect(totals['row_count']).toBe(2)
    expect(totals['checksum']).toBe(1)
  })

  it('accumulates monotonically across independent handles (one shared series)', async () => {
    // The drill is long-lived per run, but re-created handles must not start
    // a second, separate series.
    createBackupVerifyMetrics().incFailure('row_count')
    createBackupVerifyMetrics().incFailure('row_count')
    createBackupVerifyMetrics().incFailure('checksum')

    const totals = await failureTotals()
    expect(totals['row_count']).toBe(2)
    expect(totals['checksum']).toBe(1)
  })

  it('maps unexpected steps onto the unknown series instead of minting new ones', async () => {
    const { incFailure } = createBackupVerifyMetrics()

    incFailure('schema_drift')
    incFailure('connection_refused')
    incFailure('connection refused: ECONNREFUSED 127.0.0.1:5432')

    const totals = await failureTotals()
    expect(totals['unknown']).toBe(3)
    // No unexpected series may exist — cardinality stays bounded.
    expect(Object.keys(totals).sort()).toEqual(['unknown'])
  })

  it('maps empty and whitespace-only steps onto unknown', async () => {
    const { incFailure } = createBackupVerifyMetrics()

    incFailure('')
    incFailure('   ')

    const totals = await failureTotals()
    expect(totals['unknown']).toBe(2)
    expect(Object.keys(totals)).toEqual(['unknown'])
  })

  it('normalizes step labels case-insensitively for known steps', async () => {
    const { incFailure } = createBackupVerifyMetrics()

    incFailure('ROW_COUNT')
    incFailure('Checksum')

    const totals = await failureTotals()
    expect(totals['row_count']).toBe(1)
    expect(totals['checksum']).toBe(1)
    expect(totals['unknown']).toBeUndefined()
  })

  it('never throws for non-string steps at runtime', async () => {
    const { incFailure } = createBackupVerifyMetrics()

    expect(() => incFailure(undefined as unknown as string)).not.toThrow()
    expect(() => incFailure(null as unknown as string)).not.toThrow()

    const totals = await failureTotals()
    expect(totals['unknown']).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Recovery — invalid input and registry resets must not corrupt state
// ─────────────────────────────────────────────────────────────────────────────

describe('recovery', () => {
  it('keeps both series usable after rejected samples', async () => {
    const { incFailure, observeDuration } = createBackupVerifyMetrics()

    observeDuration(Number.NaN)
    observeDuration(-5)
    incFailure('not-a-step')

    // Subsequent valid instrumentation must land normally.
    observeDuration(3)
    incFailure('row_count')

    const { count, sum } = await histogramSnapshot()
    expect(count).toBe(1)
    expect(sum).toBeCloseTo(3, 6)

    const totals = await failureTotals()
    expect(totals['row_count']).toBe(1)
    expect(totals['unknown']).toBe(1)
  })

  it('produces coherent aggregates when two handles observe concurrently', async () => {
    const a = createBackupVerifyMetrics()
    const b = createBackupVerifyMetrics()

    // Interleave observations from both handles as concurrent drill runs would.
    a.observeDuration(1)
    b.incFailure('row_count')
    a.incFailure('checksum')
    b.observeDuration(4)
    a.observeDuration(0.25)
    b.incFailure('row_count')

    const { count, sum } = await histogramSnapshot()
    expect(count).toBe(3)
    expect(sum).toBeCloseTo(5.25, 6)

    const totals = await failureTotals()
    expect(totals['row_count']).toBe(2)
    expect(totals['checksum']).toBe(1)
  })

  it('resets to a clean baseline and resumes counting after register.resetMetrics()', async () => {
    const { incFailure, observeDuration } = createBackupVerifyMetrics()

    observeDuration(3)
    incFailure('row_count')

    register.resetMetrics()

    const cleared = await histogramSnapshot()
    expect(cleared.count).toBe(0)
    expect(cleared.sum).toBe(0)
    expect(Object.keys(await failureTotals())).toHaveLength(0)

    observeDuration(0.05)
    incFailure('checksum')

    const resumed = await histogramSnapshot()
    expect(resumed.count).toBe(1)
    expect(resumed.buckets['0.5']).toBe(1)
    const totals = await failureTotals()
    expect(totals['checksum']).toBe(1)
  })

  it('produces identical exports for identical inputs (determinism)', async () => {
    const run = (): void => {
      const handle = createBackupVerifyMetrics()
      handle.observeDuration(1)
      handle.observeDuration(45)
      handle.incFailure('row_count')
      handle.incFailure('row_count')
      handle.incFailure('mystery_step')
    }

    run()
    const before = {
      histogram: await histogramSnapshot(),
      failures: await failureTotals(),
    }

    register.resetMetrics()

    run()
    const after = {
      histogram: await histogramSnapshot(),
      failures: await failureTotals(),
    }

    expect(after).toEqual(before)
  })
})
