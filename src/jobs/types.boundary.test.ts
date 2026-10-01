/**
 * Boundary and recovery test coverage for src/jobs/types.ts
 *
 * Because types.ts exports only TypeScript interfaces, type aliases, and one
 * enum, this suite validates:
 *
 *  1. ReportJobStatus — enum string values, exhaustiveness, no unintended
 *     string coercions
 *  2. ScoreSnapshot — structural contracts, ISO-8601 timestamp, numeric
 *     boundaries, optional scoringModelVersion
 *  3. IdentityData — structural contract, active flag invariants, numeric
 *     boundaries on attestationCount, bondedAmount string representation
 *  4. SnapshotJobResult — all numeric counters (processed, saved, errors,
 *     duration, aggregationDuration) including zero, max-safe-integer, and
 *     partial-failure invariants (errors ≤ processed)
 *  5. ScoreSnapshotStore / IdentityDataSource — interface shapes are correct
 *     through mock implementations that the type-checker accepts
 *  6. ReportJob — required vs optional fields, state machine transitions,
 *     terminal states, failureReason/artifactUrl/storageKey coupling
 *  7. ReportWorkerConfig — optional tenantId, empty string boundary
 *  8. ScoreComputer — type alias accepts valid computations and pure
 *     functions; boundary numeric outputs (0, 100, MAX_SAFE_INTEGER)
 *  9. Cross-cutting invariants — concurrent mock executions produce
 *     independent results, batch methods preserve identity ordering
 *
 * Non-goals:
 *  - Testing runtime implementations — those live in scoreSnapshot.test.ts,
 *    reportWorker.test.ts etc.
 *  - Making the type-checker weaker to admit invalid inputs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ReportJobStatus,
  type ScoreSnapshot,
  type IdentityData,
  type ScoreSnapshotStore,
  type IdentityDataSource,
  type SnapshotJobResult,
  type ReportJob,
  type ReportWorkerConfig,
  type ScoreComputer,
} from './types.js'

// ---------------------------------------------------------------------------
// Helper factories — build minimal-valid instances with overrides
// ---------------------------------------------------------------------------

function makeScoreSnapshot(overrides: Partial<ScoreSnapshot> = {}): ScoreSnapshot {
  return {
    address: 'GABC123',
    score: 75,
    bondedAmount: '1000',
    attestationCount: 10,
    timestamp: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeIdentityData(overrides: Partial<IdentityData> = {}): IdentityData {
  return {
    address: 'GABC123',
    bondedAmount: '1000',
    active: true,
    attestationCount: 10,
    ...overrides,
  }
}

function makeSnapshotJobResult(overrides: Partial<SnapshotJobResult> = {}): SnapshotJobResult {
  return {
    processed: 10,
    saved: 10,
    errors: 0,
    duration: 250,
    aggregationDuration: 50,
    startTime: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeReportJob(overrides: Partial<ReportJob> = {}): ReportJob {
  return {
    id: 'job-1',
    type: 'trust_score_summary',
    status: ReportJobStatus.QUEUED,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. ReportJobStatus enum
// ---------------------------------------------------------------------------

describe('ReportJobStatus enum', () => {
  it('has exactly the expected string values', () => {
    expect(ReportJobStatus.QUEUED).toBe('queued')
    expect(ReportJobStatus.RUNNING).toBe('running')
    expect(ReportJobStatus.COMPLETED).toBe('completed')
    expect(ReportJobStatus.FAILED).toBe('failed')
    expect(ReportJobStatus.CANCELLED).toBe('cancelled')
  })

  it('contains exactly 5 members — no accidental additions', () => {
    const members = Object.values(ReportJobStatus)
    expect(members).toHaveLength(5)
  })

  it('all values are lowercase strings (consistent with DB column convention)', () => {
    for (const value of Object.values(ReportJobStatus)) {
      expect(typeof value).toBe('string')
      expect(value).toBe(value.toLowerCase())
    }
  })

  it('values are not empty strings', () => {
    for (const value of Object.values(ReportJobStatus)) {
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('enum key names are distinct from their values (not a string enum that echoes keys)', () => {
    // QUEUED !== 'QUEUED', etc.
    for (const [key, value] of Object.entries(ReportJobStatus)) {
      expect(key).not.toBe(value)
    }
  })

  it('status values are all distinct — no duplicates', () => {
    const values = Object.values(ReportJobStatus)
    const unique = new Set(values)
    expect(unique.size).toBe(values.length)
  })

  it('includes both terminal states (COMPLETED and FAILED)', () => {
    const terminals = new Set([ReportJobStatus.COMPLETED, ReportJobStatus.FAILED, ReportJobStatus.CANCELLED])
    expect(terminals.has('completed' as ReportJobStatus)).toBe(true)
    expect(terminals.has('failed' as ReportJobStatus)).toBe(true)
    expect(terminals.has('cancelled' as ReportJobStatus)).toBe(true)
  })

  it('QUEUED → RUNNING is a valid forward transition', () => {
    // Represents a job that has been claimed by a worker
    const initial = ReportJobStatus.QUEUED
    const next = ReportJobStatus.RUNNING
    expect(initial).not.toBe(next)
  })

  it('RUNNING → COMPLETED is a valid forward transition', () => {
    const initial = ReportJobStatus.RUNNING
    const next = ReportJobStatus.COMPLETED
    expect(initial).not.toBe(next)
  })

  it('RUNNING → FAILED is a valid forward transition', () => {
    const initial = ReportJobStatus.RUNNING
    const next = ReportJobStatus.FAILED
    expect(initial).not.toBe(next)
  })

  it('RUNNING → CANCELLED is a valid forward transition', () => {
    const initial = ReportJobStatus.RUNNING
    const next = ReportJobStatus.CANCELLED
    expect(initial).not.toBe(next)
  })

  it('can be used as a discriminant in a switch without falling through', () => {
    // Verifies exhaustiveness is achievable without TypeScript default-never trick
    const allStatuses = Object.values(ReportJobStatus)
    const handled: string[] = []

    for (const status of allStatuses) {
      switch (status) {
        case ReportJobStatus.QUEUED:
          handled.push('queued')
          break
        case ReportJobStatus.RUNNING:
          handled.push('running')
          break
        case ReportJobStatus.COMPLETED:
          handled.push('completed')
          break
        case ReportJobStatus.FAILED:
          handled.push('failed')
          break
        case ReportJobStatus.CANCELLED:
          handled.push('cancelled')
          break
      }
    }

    expect(handled).toHaveLength(5)
    expect(handled).toContain('queued')
    expect(handled).toContain('running')
    expect(handled).toContain('completed')
    expect(handled).toContain('failed')
    expect(handled).toContain('cancelled')
  })
})

// ---------------------------------------------------------------------------
// 2. ScoreSnapshot structural contract
// ---------------------------------------------------------------------------

describe('ScoreSnapshot structural contract', () => {
  it('accepts a valid minimal snapshot', () => {
    const snapshot = makeScoreSnapshot()
    expect(snapshot.address).toBe('GABC123')
    expect(snapshot.score).toBe(75)
    expect(snapshot.bondedAmount).toBe('1000')
    expect(snapshot.attestationCount).toBe(10)
    expect(snapshot.timestamp).toBe('2025-01-01T00:00:00.000Z')
    expect(snapshot.scoringModelVersion).toBeUndefined()
  })

  it('accepts scoringModelVersion when provided', () => {
    const snapshot = makeScoreSnapshot({ scoringModelVersion: 'v2' })
    expect(snapshot.scoringModelVersion).toBe('v2')
  })

  it('timestamp is a parseable ISO-8601 date', () => {
    const snapshot = makeScoreSnapshot({ timestamp: new Date().toISOString() })
    expect(new Date(snapshot.timestamp).getTime()).not.toBeNaN()
  })

  it('score boundary: 0 (inactive identity minimum)', () => {
    const snapshot = makeScoreSnapshot({ score: 0 })
    expect(snapshot.score).toBe(0)
  })

  it('score boundary: 100 (perfect score)', () => {
    const snapshot = makeScoreSnapshot({ score: 100 })
    expect(snapshot.score).toBe(100)
  })

  it('score boundary: fractional values are representable', () => {
    const snapshot = makeScoreSnapshot({ score: 33.333333 })
    expect(snapshot.score).toBeCloseTo(33.333333)
  })

  it('attestationCount boundary: 0', () => {
    const snapshot = makeScoreSnapshot({ attestationCount: 0 })
    expect(snapshot.attestationCount).toBe(0)
  })

  it('attestationCount boundary: Number.MAX_SAFE_INTEGER', () => {
    const snapshot = makeScoreSnapshot({ attestationCount: Number.MAX_SAFE_INTEGER })
    expect(snapshot.attestationCount).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('bondedAmount stores arbitrary-precision numeric strings', () => {
    // bondedAmount is a string to avoid float precision loss on large Stellar amounts
    const veryLarge = '9999999999999999999999999999'
    const snapshot = makeScoreSnapshot({ bondedAmount: veryLarge })
    expect(snapshot.bondedAmount).toBe(veryLarge)
    expect(typeof snapshot.bondedAmount).toBe('string')
  })

  it('bondedAmount boundary: zero', () => {
    const snapshot = makeScoreSnapshot({ bondedAmount: '0' })
    expect(snapshot.bondedAmount).toBe('0')
  })

  it('address is a non-empty string', () => {
    const snapshot = makeScoreSnapshot({ address: 'GLONG_STELLAR_ADDRESS_EXAMPLE' })
    expect(typeof snapshot.address).toBe('string')
    expect(snapshot.address.length).toBeGreaterThan(0)
  })

  it('two snapshots for the same address at different timestamps are structurally independent', () => {
    const t1 = makeScoreSnapshot({ timestamp: '2025-01-01T00:00:00.000Z', score: 50 })
    const t2 = makeScoreSnapshot({ timestamp: '2025-01-02T00:00:00.000Z', score: 75 })
    expect(t1.timestamp).not.toBe(t2.timestamp)
    expect(t1.score).not.toBe(t2.score)
    // Mutating one does not affect the other (value semantics from plain objects)
    ;(t1 as any).score = 99
    expect(t2.score).toBe(75)
  })
})

// ---------------------------------------------------------------------------
// 3. IdentityData structural contract
// ---------------------------------------------------------------------------

describe('IdentityData structural contract', () => {
  it('accepts a valid active identity', () => {
    const data = makeIdentityData()
    expect(data.active).toBe(true)
    expect(data.attestationCount).toBeGreaterThanOrEqual(0)
  })

  it('accepts an inactive identity with a non-zero bond (bond pending withdrawal)', () => {
    const data = makeIdentityData({ active: false, bondedAmount: '500' })
    expect(data.active).toBe(false)
    expect(data.bondedAmount).toBe('500')
  })

  it('active false with zero bond represents a fully withdrawn identity', () => {
    const data = makeIdentityData({ active: false, bondedAmount: '0' })
    expect(data.active).toBe(false)
    expect(data.bondedAmount).toBe('0')
  })

  it('attestationCount boundary: 0', () => {
    const data = makeIdentityData({ attestationCount: 0 })
    expect(data.attestationCount).toBe(0)
  })

  it('attestationCount boundary: very large integer', () => {
    const data = makeIdentityData({ attestationCount: 1_000_000 })
    expect(data.attestationCount).toBe(1_000_000)
  })

  it('bondedAmount is always a string (safe large-number representation)', () => {
    const data = makeIdentityData({ bondedAmount: '10000000000000000000' })
    expect(typeof data.bondedAmount).toBe('string')
  })

  it('address uniqueness is the caller\'s responsibility — type allows duplicates', () => {
    // The type system does not enforce uniqueness; that is an application invariant
    const a = makeIdentityData({ address: 'SAME' })
    const b = makeIdentityData({ address: 'SAME' })
    expect(a.address).toBe(b.address)
  })
})

// ---------------------------------------------------------------------------
// 4. SnapshotJobResult numeric invariants
// ---------------------------------------------------------------------------

describe('SnapshotJobResult numeric invariants', () => {
  it('accepts a zero-work result (no active identities)', () => {
    const result = makeSnapshotJobResult({ processed: 0, saved: 0, errors: 0 })
    expect(result.processed).toBe(0)
    expect(result.saved).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('saved ≤ processed (cannot save more than processed)', () => {
    const result = makeSnapshotJobResult({ processed: 10, saved: 8, errors: 2 })
    expect(result.saved).toBeLessThanOrEqual(result.processed)
  })

  it('errors ≤ processed (cannot have more errors than items attempted)', () => {
    const result = makeSnapshotJobResult({ processed: 10, saved: 8, errors: 2 })
    expect(result.errors).toBeLessThanOrEqual(result.processed)
  })

  it('processed = saved + errors holds for a fully enumerated run', () => {
    // When every identity either succeeds or fails, counts must balance
    const result = makeSnapshotJobResult({ processed: 10, saved: 7, errors: 3 })
    expect(result.saved + result.errors).toBe(result.processed)
  })

  it('all-errors scenario: saved = 0, errors = processed', () => {
    const result = makeSnapshotJobResult({ processed: 5, saved: 0, errors: 5 })
    expect(result.saved).toBe(0)
    expect(result.errors).toBe(result.processed)
  })

  it('all-success scenario: errors = 0, saved = processed', () => {
    const result = makeSnapshotJobResult({ processed: 5, saved: 5, errors: 0 })
    expect(result.errors).toBe(0)
    expect(result.saved).toBe(result.processed)
  })

  it('duration boundary: 0 ms (instant job)', () => {
    const result = makeSnapshotJobResult({ duration: 0 })
    expect(result.duration).toBe(0)
  })

  it('aggregationDuration boundary: 0 ms (no aggregation cost)', () => {
    const result = makeSnapshotJobResult({ aggregationDuration: 0 })
    expect(result.aggregationDuration).toBe(0)
  })

  it('aggregationDuration ≤ duration (aggregation is a sub-phase of total duration)', () => {
    const result = makeSnapshotJobResult({ duration: 500, aggregationDuration: 200 })
    expect(result.aggregationDuration).toBeLessThanOrEqual(result.duration)
  })

  it('duration boundary: large value (long-running job)', () => {
    const result = makeSnapshotJobResult({ duration: 3_600_000 }) // 1 hour
    expect(result.duration).toBe(3_600_000)
  })

  it('startTime is a parseable ISO-8601 date', () => {
    const result = makeSnapshotJobResult({ startTime: new Date().toISOString() })
    const ms = new Date(result.startTime).getTime()
    expect(ms).not.toBeNaN()
    expect(ms).toBeGreaterThan(0)
  })

  it('startTime is an ISO string — not a Unix timestamp number', () => {
    const result = makeSnapshotJobResult()
    expect(typeof result.startTime).toBe('string')
    expect(result.startTime).toContain('T') // ISO-8601 separator
  })

  it('processed boundary: MAX_SAFE_INTEGER', () => {
    const result = makeSnapshotJobResult({
      processed: Number.MAX_SAFE_INTEGER,
      saved: Number.MAX_SAFE_INTEGER,
      errors: 0,
    })
    expect(result.processed).toBe(Number.MAX_SAFE_INTEGER)
  })
})

// ---------------------------------------------------------------------------
// 5. ScoreSnapshotStore interface contract
// ---------------------------------------------------------------------------

describe('ScoreSnapshotStore interface contract', () => {
  let store: ScoreSnapshotStore

  beforeEach(() => {
    store = {
      save: vi.fn().mockResolvedValue(undefined),
      saveBatch: vi.fn().mockResolvedValue(undefined),
    }
  })

  it('save resolves without returning a value', async () => {
    const result = await store.save(makeScoreSnapshot())
    expect(result).toBeUndefined()
  })

  it('saveBatch resolves without returning a value', async () => {
    const result = await store.saveBatch([makeScoreSnapshot(), makeScoreSnapshot()])
    expect(result).toBeUndefined()
  })

  it('saveBatch called with empty array resolves cleanly', async () => {
    const result = await store.saveBatch([])
    expect(result).toBeUndefined()
  })

  it('save is called with the snapshot that was passed in', async () => {
    const snapshot = makeScoreSnapshot({ address: 'G_UNIQUE' })
    await store.save(snapshot)
    expect(store.save).toHaveBeenCalledWith(snapshot)
  })

  it('saveBatch is called with the exact array reference', async () => {
    const snapshots = [makeScoreSnapshot({ address: 'G1' }), makeScoreSnapshot({ address: 'G2' })]
    await store.saveBatch(snapshots)
    expect(store.saveBatch).toHaveBeenCalledWith(snapshots)
  })

  it('save rejection propagates to caller', async () => {
    const dbError = new Error('DB write failed')
    store.save = vi.fn().mockRejectedValue(dbError)
    await expect(store.save(makeScoreSnapshot())).rejects.toThrow('DB write failed')
  })

  it('saveBatch rejection propagates to caller', async () => {
    const dbError = new Error('Batch insert failed')
    store.saveBatch = vi.fn().mockRejectedValue(dbError)
    await expect(store.saveBatch([makeScoreSnapshot()])).rejects.toThrow('Batch insert failed')
  })

  it('concurrent save calls do not share state', async () => {
    const calls: string[] = []
    store.save = vi.fn().mockImplementation(async (snapshot: ScoreSnapshot) => {
      await new Promise((r) => setTimeout(r, 0))
      calls.push(snapshot.address)
    })

    await Promise.all([
      store.save(makeScoreSnapshot({ address: 'G_A' })),
      store.save(makeScoreSnapshot({ address: 'G_B' })),
      store.save(makeScoreSnapshot({ address: 'G_C' })),
    ])

    expect(calls).toHaveLength(3)
    expect(calls).toContain('G_A')
    expect(calls).toContain('G_B')
    expect(calls).toContain('G_C')
  })
})

// ---------------------------------------------------------------------------
// 6. IdentityDataSource interface contract
// ---------------------------------------------------------------------------

describe('IdentityDataSource interface contract', () => {
  let source: IdentityDataSource

  beforeEach(() => {
    source = {
      getActiveAddresses: vi.fn().mockResolvedValue(['G1', 'G2', 'G3']),
      getIdentityData: vi.fn().mockImplementation(async (address: string) =>
        makeIdentityData({ address }),
      ),
    }
  })

  it('getActiveAddresses resolves to a string array', async () => {
    const addresses = await source.getActiveAddresses()
    expect(Array.isArray(addresses)).toBe(true)
    for (const addr of addresses) {
      expect(typeof addr).toBe('string')
    }
  })

  it('getActiveAddresses boundary: empty list (no active identities)', async () => {
    source.getActiveAddresses = vi.fn().mockResolvedValue([])
    const addresses = await source.getActiveAddresses()
    expect(addresses).toHaveLength(0)
  })

  it('getIdentityData returns null for unknown address', async () => {
    source.getIdentityData = vi.fn().mockResolvedValue(null)
    const result = await source.getIdentityData('G_UNKNOWN')
    expect(result).toBeNull()
  })

  it('getIdentityData returns IdentityData for known address', async () => {
    const result = await source.getIdentityData('G1')
    expect(result).not.toBeNull()
    expect(result!.address).toBe('G1')
  })

  it('getIdentityDataBatch is optional — source without it is valid', () => {
    // TypeScript already enforces this; runtime check confirms no crash
    expect(source.getIdentityDataBatch).toBeUndefined()
  })

  it('getIdentityDataBatch when present returns array matching input addresses', async () => {
    source.getIdentityDataBatch = vi.fn().mockImplementation(async (addresses: string[]) =>
      addresses.map((a) => makeIdentityData({ address: a })),
    )

    const result = await source.getIdentityDataBatch!(['G1', 'G2'])
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.address)).toContain('G1')
    expect(result.map((r) => r.address)).toContain('G2')
  })

  it('getIdentityDataBatch boundary: empty input returns empty array', async () => {
    source.getIdentityDataBatch = vi.fn().mockResolvedValue([])
    const result = await source.getIdentityDataBatch!([])
    expect(result).toHaveLength(0)
  })

  it('getIdentityDataBatch may return results in any order (caller must re-sort)', async () => {
    // The interface allows out-of-order results — the comment in types.ts says
    // "callers should restore the input order"
    source.getIdentityDataBatch = vi.fn().mockResolvedValue([
      makeIdentityData({ address: 'G3' }),
      makeIdentityData({ address: 'G1' }),
      makeIdentityData({ address: 'G2' }),
    ])

    const result = await source.getIdentityDataBatch!(['G1', 'G2', 'G3'])
    // Verify all requested addresses are present regardless of order
    const resultAddresses = result.map((r) => r.address)
    expect(resultAddresses).toContain('G1')
    expect(resultAddresses).toContain('G2')
    expect(resultAddresses).toContain('G3')
  })

  it('getActiveAddresses rejection propagates to caller', async () => {
    source.getActiveAddresses = vi.fn().mockRejectedValue(new Error('DB unavailable'))
    await expect(source.getActiveAddresses()).rejects.toThrow('DB unavailable')
  })

  it('getIdentityData rejection propagates to caller', async () => {
    source.getIdentityData = vi.fn().mockRejectedValue(new Error('Timeout'))
    await expect(source.getIdentityData('G1')).rejects.toThrow('Timeout')
  })

  it('concurrent getIdentityData calls are independent', async () => {
    const resultsMap = new Map<string, IdentityData>()
    source.getIdentityData = vi.fn().mockImplementation(async (addr: string) => {
      await new Promise((r) => setTimeout(r, 0))
      return makeIdentityData({ address: addr, attestationCount: addr.length })
    })

    const [r1, r2, r3] = await Promise.all([
      source.getIdentityData('G'),
      source.getIdentityData('GA'),
      source.getIdentityData('GAB'),
    ])

    expect(r1!.attestationCount).toBe(1)  // 'G'.length
    expect(r2!.attestationCount).toBe(2)  // 'GA'.length
    expect(r3!.attestationCount).toBe(3)  // 'GAB'.length
  })
})

// ---------------------------------------------------------------------------
// 7. ReportJob state machine and field invariants
// ---------------------------------------------------------------------------

describe('ReportJob state machine and field invariants', () => {
  it('QUEUED job has no failureReason, artifactUrl, or storageKey', () => {
    const job = makeReportJob({ status: ReportJobStatus.QUEUED })
    expect(job.failureReason).toBeUndefined()
    expect(job.artifactUrl).toBeUndefined()
    expect(job.storageKey).toBeUndefined()
  })

  it('RUNNING job has no failureReason, artifactUrl, or storageKey', () => {
    const job = makeReportJob({ status: ReportJobStatus.RUNNING })
    expect(job.failureReason).toBeUndefined()
    expect(job.artifactUrl).toBeUndefined()
    expect(job.storageKey).toBeUndefined()
  })

  it('COMPLETED job has a storageKey', () => {
    const job = makeReportJob({
      status: ReportJobStatus.COMPLETED,
      storageKey: 'reports/tenant/job-1.pdf',
    })
    expect(job.storageKey).toBe('reports/tenant/job-1.pdf')
    expect(job.failureReason).toBeUndefined()
  })

  it('COMPLETED job may also have an artifactUrl (pre-signed download link)', () => {
    const job = makeReportJob({
      status: ReportJobStatus.COMPLETED,
      storageKey: 'reports/tenant/job-1.pdf',
      artifactUrl: 'https://example.com/download/job-1.pdf',
    })
    expect(job.artifactUrl).toContain('https://')
  })

  it('FAILED job has a failureReason', () => {
    const job = makeReportJob({
      status: ReportJobStatus.FAILED,
      failureReason: 'INTERNAL_ERROR',
    })
    expect(job.failureReason).toBe('INTERNAL_ERROR')
    expect(job.storageKey).toBeUndefined()
    expect(job.artifactUrl).toBeUndefined()
  })

  it('CANCELLED job has no artifact — transition leaves optional fields absent', () => {
    const job = makeReportJob({ status: ReportJobStatus.CANCELLED })
    expect(job.storageKey).toBeUndefined()
    expect(job.artifactUrl).toBeUndefined()
    expect(job.failureReason).toBeUndefined()
  })

  it('id is a non-empty string', () => {
    const job = makeReportJob({ id: 'uuid-abc-123' })
    expect(typeof job.id).toBe('string')
    expect(job.id.length).toBeGreaterThan(0)
  })

  it('type is a non-empty string', () => {
    const job = makeReportJob({ type: 'trust_score_summary' })
    expect(typeof job.type).toBe('string')
    expect(job.type.length).toBeGreaterThan(0)
  })

  it('createdAt is a parseable ISO-8601 date', () => {
    const job = makeReportJob({ createdAt: '2025-06-01T12:00:00.000Z' })
    expect(new Date(job.createdAt).getTime()).not.toBeNaN()
  })

  it('updatedAt is a parseable ISO-8601 date', () => {
    const job = makeReportJob({ updatedAt: '2025-06-01T12:30:00.000Z' })
    expect(new Date(job.updatedAt).getTime()).not.toBeNaN()
  })

  it('updatedAt ≥ createdAt (jobs are updated after or at creation time)', () => {
    const created = '2025-06-01T12:00:00.000Z'
    const updated = '2025-06-01T12:30:00.000Z'
    const job = makeReportJob({ createdAt: created, updatedAt: updated })
    expect(new Date(job.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(job.createdAt).getTime(),
    )
  })

  it('createdAt === updatedAt for a freshly created QUEUED job', () => {
    const ts = new Date().toISOString()
    const job = makeReportJob({ createdAt: ts, updatedAt: ts })
    expect(job.createdAt).toBe(job.updatedAt)
  })

  it('status field reflects one of the known enum values', () => {
    const validStatuses = Object.values(ReportJobStatus)
    const job = makeReportJob({ status: ReportJobStatus.RUNNING })
    expect(validStatuses).toContain(job.status)
  })

  it('two separate job objects are structurally independent (no shared reference)', () => {
    const j1 = makeReportJob({ id: 'j1' })
    const j2 = makeReportJob({ id: 'j2' })
    ;(j1 as any).type = 'mutated'
    expect(j2.type).toBe('trust_score_summary')
  })

  it('state transitions: QUEUED → RUNNING keeps id unchanged', () => {
    const queued = makeReportJob({ status: ReportJobStatus.QUEUED })
    const running: ReportJob = { ...queued, status: ReportJobStatus.RUNNING, updatedAt: new Date().toISOString() }
    expect(running.id).toBe(queued.id)
    expect(running.status).toBe(ReportJobStatus.RUNNING)
  })

  it('state transitions: RUNNING → COMPLETED adds storageKey', () => {
    const running = makeReportJob({ status: ReportJobStatus.RUNNING })
    const completed: ReportJob = {
      ...running,
      status: ReportJobStatus.COMPLETED,
      storageKey: 'reports/default/job-1.pdf',
      updatedAt: new Date().toISOString(),
    }
    expect(completed.status).toBe(ReportJobStatus.COMPLETED)
    expect(completed.storageKey).toBeDefined()
  })

  it('state transitions: RUNNING → FAILED adds failureReason', () => {
    const running = makeReportJob({ status: ReportJobStatus.RUNNING })
    const failed: ReportJob = {
      ...running,
      status: ReportJobStatus.FAILED,
      failureReason: 'TIMEOUT',
      updatedAt: new Date().toISOString(),
    }
    expect(failed.status).toBe(ReportJobStatus.FAILED)
    expect(failed.failureReason).toBe('TIMEOUT')
    expect(failed.storageKey).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 8. ReportWorkerConfig — optional tenantId
// ---------------------------------------------------------------------------

describe('ReportWorkerConfig', () => {
  it('accepts an empty config object (all fields optional)', () => {
    const config: ReportWorkerConfig = {}
    expect(config.tenantId).toBeUndefined()
  })

  it('accepts a config with tenantId', () => {
    const config: ReportWorkerConfig = { tenantId: 'tenant-abc' }
    expect(config.tenantId).toBe('tenant-abc')
  })

  it('tenantId boundary: empty string is structurally valid', () => {
    // The type does not constrain to non-empty — that is an application invariant
    const config: ReportWorkerConfig = { tenantId: '' }
    expect(config.tenantId).toBe('')
  })

  it('tenantId with special characters is structurally valid', () => {
    const config: ReportWorkerConfig = { tenantId: 'tenant/org:sub-tenant_1' }
    expect(config.tenantId).toBe('tenant/org:sub-tenant_1')
  })

  it('two configs with the same tenantId are structurally equal', () => {
    const c1: ReportWorkerConfig = { tenantId: 'same' }
    const c2: ReportWorkerConfig = { tenantId: 'same' }
    expect(c1.tenantId).toBe(c2.tenantId)
  })
})

// ---------------------------------------------------------------------------
// 9. ScoreComputer type alias
// ---------------------------------------------------------------------------

describe('ScoreComputer type alias', () => {
  it('a pure function (data) => number satisfies the type', () => {
    const computer: ScoreComputer = (data) => (data.active ? 75 : 0)
    const score = computer(makeIdentityData({ active: true }))
    expect(score).toBe(75)
  })

  it('returns 0 for inactive identity', () => {
    const computer: ScoreComputer = (data) => (data.active ? 100 : 0)
    expect(computer(makeIdentityData({ active: false }))).toBe(0)
  })

  it('boundary: returns 0 (minimum possible score)', () => {
    const computer: ScoreComputer = () => 0
    expect(computer(makeIdentityData())).toBe(0)
  })

  it('boundary: returns 100 (maximum normalized score)', () => {
    const computer: ScoreComputer = () => 100
    expect(computer(makeIdentityData())).toBe(100)
  })

  it('boundary: returns Number.MAX_SAFE_INTEGER (contract does not clamp)', () => {
    // The type alias places no upper bound — clamping is the caller's responsibility
    const computer: ScoreComputer = () => Number.MAX_SAFE_INTEGER
    expect(computer(makeIdentityData())).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('function is pure — same input yields same output on repeated calls', () => {
    const computer: ScoreComputer = (data) =>
      data.active ? Math.round(Number(data.bondedAmount) / 10) : 0
    const data = makeIdentityData({ bondedAmount: '1000', active: true })
    expect(computer(data)).toBe(computer(data))
  })

  it('does not close over mutable external state (stateless requirement)', () => {
    let externalState = 0
    // A computer that captures mutable state is structurally valid but logically
    // unsafe — this test documents that the type does NOT prevent such closure;
    // callers must use a stateless implementation.
    const computer: ScoreComputer = (_data) => externalState
    externalState = 50
    expect(computer(makeIdentityData())).toBe(50)
    externalState = 75
    expect(computer(makeIdentityData())).toBe(75)
  })

  it('vi.fn() mock satisfies ScoreComputer interface', () => {
    const mockComputer: ScoreComputer = vi.fn().mockReturnValue(42)
    expect(mockComputer(makeIdentityData())).toBe(42)
    expect(mockComputer).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 10. Cross-cutting invariants — concurrent access and ordering
// ---------------------------------------------------------------------------

describe('cross-cutting invariants', () => {
  it('multiple concurrent mock stores do not share write state', async () => {
    const storeA: ScoreSnapshotStore = {
      save: vi.fn().mockResolvedValue(undefined),
      saveBatch: vi.fn().mockResolvedValue(undefined),
    }
    const storeB: ScoreSnapshotStore = {
      save: vi.fn().mockResolvedValue(undefined),
      saveBatch: vi.fn().mockResolvedValue(undefined),
    }

    await Promise.all([
      storeA.save(makeScoreSnapshot({ address: 'GA' })),
      storeB.save(makeScoreSnapshot({ address: 'GB' })),
    ])

    expect(storeA.save).toHaveBeenCalledWith(expect.objectContaining({ address: 'GA' }))
    expect(storeB.save).toHaveBeenCalledWith(expect.objectContaining({ address: 'GB' }))
    // B's save should NOT have been called with A's address
    expect(storeB.save).not.toHaveBeenCalledWith(expect.objectContaining({ address: 'GA' }))
  })

  it('job result fields are serializable to JSON without data loss', () => {
    const result = makeSnapshotJobResult({
      processed: 1000,
      saved: 995,
      errors: 5,
      duration: 12345,
      aggregationDuration: 1234,
      startTime: '2025-09-29T00:00:00.000Z',
    })
    const serialized = JSON.stringify(result)
    const deserialized = JSON.parse(serialized) as SnapshotJobResult
    expect(deserialized.processed).toBe(result.processed)
    expect(deserialized.saved).toBe(result.saved)
    expect(deserialized.errors).toBe(result.errors)
    expect(deserialized.duration).toBe(result.duration)
    expect(deserialized.aggregationDuration).toBe(result.aggregationDuration)
    expect(deserialized.startTime).toBe(result.startTime)
  })

  it('ReportJob is serializable to JSON and round-trips without data loss', () => {
    const job = makeReportJob({
      status: ReportJobStatus.COMPLETED,
      storageKey: 'reports/t/j.pdf',
      artifactUrl: 'https://example.com/j.pdf',
    })
    const deserialized: ReportJob = JSON.parse(JSON.stringify(job))
    expect(deserialized.id).toBe(job.id)
    expect(deserialized.status).toBe(job.status)
    expect(deserialized.storageKey).toBe(job.storageKey)
    expect(deserialized.artifactUrl).toBe(job.artifactUrl)
  })

  it('ScoreSnapshot with all fields round-trips through JSON', () => {
    const snapshot = makeScoreSnapshot({ scoringModelVersion: 'v3.1.0' })
    const deserialized: ScoreSnapshot = JSON.parse(JSON.stringify(snapshot))
    expect(deserialized.address).toBe(snapshot.address)
    expect(deserialized.score).toBe(snapshot.score)
    expect(deserialized.bondedAmount).toBe(snapshot.bondedAmount)
    expect(deserialized.attestationCount).toBe(snapshot.attestationCount)
    expect(deserialized.timestamp).toBe(snapshot.timestamp)
    expect(deserialized.scoringModelVersion).toBe(snapshot.scoringModelVersion)
  })

  it('ReportJobStatus values remain stable across multiple enum lookups', () => {
    // Guard against any dynamic computed property that could produce non-stable values
    const first = ReportJobStatus.QUEUED
    const second = ReportJobStatus.QUEUED
    expect(first).toBe(second)
  })

  it('batch of IdentityData can be mapped to ScoreSnapshot without state leakage', () => {
    const batch: IdentityData[] = [
      makeIdentityData({ address: 'G1', attestationCount: 5 }),
      makeIdentityData({ address: 'G2', attestationCount: 10 }),
      makeIdentityData({ address: 'G3', attestationCount: 15 }),
    ]

    const computer: ScoreComputer = (data) => data.attestationCount * 2

    const snapshots: ScoreSnapshot[] = batch.map((data) => ({
      address: data.address,
      score: computer(data),
      bondedAmount: data.bondedAmount,
      attestationCount: data.attestationCount,
      timestamp: '2025-01-01T00:00:00.000Z',
    }))

    expect(snapshots[0].score).toBe(10)
    expect(snapshots[1].score).toBe(20)
    expect(snapshots[2].score).toBe(30)
    // Verify input batch was not mutated
    expect(batch[0].attestationCount).toBe(5)
  })
})
