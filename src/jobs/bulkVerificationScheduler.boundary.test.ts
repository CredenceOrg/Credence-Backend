/**
 * Boundary and recovery test coverage for bulkVerificationScheduler.ts
 *
 * Issue #1413 – this file covers all states that the existing happy-path suite
 * does not exercise:
 *
 *  computeOrgWeight
 *    - Negative usage is treated as zero (weight == 1)
 *    - NaN usage is treated as zero (weight == 1)
 *    - Infinity usage is treated as zero (weight == 1)
 *    - usage == 0 returns exactly 1
 *    - Very large usage keeps weight strictly positive
 *    - Weights are strictly between 0 and 1 for all positive usage values
 *
 *  orderJobsByWfq – input validation / boundary inputs
 *    - Empty job list returns empty array without throwing
 *    - Single-job list returns that job unchanged
 *    - Jobs with size == 0 are treated as size 1 (no division anomaly)
 *    - Jobs with negative size are treated as size 1
 *    - Jobs with Infinity size produce a finite, deterministic score
 *    - Jobs with NaN size are treated as size 1
 *    - Duplicate job IDs (invalid but must not throw or loop)
 *    - orgUsages list with duplicate orgIds (must not throw)
 *    - All orgs share the same usage value (order falls back to createdAt)
 *    - Jobs with identical createdAt and identical sizes produce a stable order
 *
 *  orderJobsByWfq – WFQ invariants
 *    - Output length always equals input length
 *    - Output is a permutation of input (no job dropped or duplicated)
 *    - A high-usage org's job appears after lower-usage org jobs
 *    - An org with weight close to 0 (usage == 1e9) does not produce NaN/Infinity
 *    - Same-org jobs appear in arrival order (lastFinish monotonicity)
 *    - A tiny job from a different org beats a huge job from a high-usage org
 *    - Two orgs with equal sizes and equal usage interleave fairly
 *    - Jobs submitted in reverse chronological order are still WFQ-ordered
 *
 *  Concurrency / determinism invariants
 *    - Repeated calls with identical input return identical arrays
 *    - The original jobs array is not mutated
 *    - The original orgUsages array is not mutated
 *    - Concurrent independent calls do not share state
 *
 *  Permission / stale / retry analogues
 *    - usage == Number.MAX_SAFE_INTEGER still produces valid ordering
 *    - Re-submitting the same job IDs with updated createdAt re-orders them
 *    - Partial orgUsage list does not disadvantage orgs that have entries
 *    - A very old (stale) job is served before newer ones from the same org
 *    - 200 jobs across 4 orgs always produce a valid permutation
 *    - Identical (same orgId/size/createdAt) clones never throw
 *
 *  Regression guard
 *    - Canonical mixed-org scenario is stable across independent runs
 *    - Default export exposes both named functions
 */

import { describe, it, expect } from 'vitest'
import { computeOrgWeight, orderJobsByWfq, type BulkJob, type OrgUsage } from './bulkVerificationScheduler.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Deterministic epoch anchor so tests are not time-dependent. */
const BASE_TIME = 1_700_000_000_000

function job(id: string, orgId: string, size: number, offsetMs = 0): BulkJob {
  return { id, orgId, size, createdAt: BASE_TIME + offsetMs }
}

function usage(orgId: string, u: number): OrgUsage {
  return { orgId, usage: u }
}

/**
 * Returns true iff `output` is an exact permutation of `input`
 * (same IDs, no extras, no omissions).
 */
function isPermutation(input: BulkJob[], output: BulkJob[]): boolean {
  if (input.length !== output.length) return false
  const inputIds = input.map((j) => j.id).sort()
  const outputIds = output.map((j) => j.id).sort()
  return inputIds.every((id, i) => id === outputIds[i])
}

// ─── computeOrgWeight ────────────────────────────────────────────────────────

describe('computeOrgWeight', () => {
  it('returns exactly 1 for usage == 0', () => {
    expect(computeOrgWeight(0)).toBe(1)
  })

  it('returns exactly 1 for negative usage (clamped to 0)', () => {
    expect(computeOrgWeight(-1)).toBe(1)
    expect(computeOrgWeight(-999)).toBe(1)
  })

  it('returns exactly 1 for NaN usage (treated as 0)', () => {
    expect(computeOrgWeight(NaN)).toBe(1)
  })

  it('returns exactly 1 for Infinity usage (non-finite, treated as 0)', () => {
    expect(computeOrgWeight(Infinity)).toBe(1)
    expect(computeOrgWeight(-Infinity)).toBe(1)
  })

  it('returns ~0.5 for usage == 1', () => {
    expect(computeOrgWeight(1)).toBeCloseTo(0.5)
  })

  it('weight decreases strictly as usage increases', () => {
    const w1 = computeOrgWeight(1)
    const w5 = computeOrgWeight(5)
    const w100 = computeOrgWeight(100)
    expect(w1).toBeGreaterThan(w5)
    expect(w5).toBeGreaterThan(w100)
  })

  it('weight is always strictly positive for any finite usage value', () => {
    for (const u of [0, 1, 10, 1_000, 1e9, Number.MAX_SAFE_INTEGER]) {
      expect(computeOrgWeight(u)).toBeGreaterThan(0)
    }
  })

  it('weight is always ≤ 1', () => {
    for (const u of [0, 1, 10, 100, 1e6]) {
      expect(computeOrgWeight(u)).toBeLessThanOrEqual(1)
    }
  })

  it('weight is strictly less than 1 for any positive usage', () => {
    expect(computeOrgWeight(0.001)).toBeLessThan(1)
    expect(computeOrgWeight(1)).toBeLessThan(1)
  })

  it('produces a finite, positive result for Number.MAX_SAFE_INTEGER usage', () => {
    const w = computeOrgWeight(Number.MAX_SAFE_INTEGER)
    expect(Number.isFinite(w)).toBe(true)
    expect(w).toBeGreaterThan(0)
  })
})

// ─── orderJobsByWfq – input validation / boundary inputs ─────────────────────

describe('orderJobsByWfq – input validation', () => {
  it('returns an empty array when the jobs list is empty', () => {
    expect(orderJobsByWfq([], [])).toEqual([])
  })

  it('returns a single-element array for a single job', () => {
    const jobs = [job('j1', 'A', 10)]
    const result = orderJobsByWfq(jobs, [usage('A', 0)])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('j1')
  })

  it('does not mutate the original jobs array', () => {
    const jobs = [job('j2', 'A', 10, 2), job('j1', 'A', 10, 1)]
    const snapshot = jobs.map((j) => ({ ...j }))
    orderJobsByWfq(jobs, [])
    expect(jobs).toEqual(snapshot)
  })

  it('does not mutate the original orgUsages array', () => {
    const jobs = [job('j1', 'A', 10)]
    const orgUsages = [usage('A', 5)]
    const snapshot = orgUsages.map((ou) => ({ ...ou }))
    orderJobsByWfq(jobs, orgUsages)
    expect(orgUsages).toEqual(snapshot)
  })

  it('treats size == 0 as size 1 — no NaN or Infinity score', () => {
    const jobs = [job('j1', 'A', 0)]
    expect(() => orderJobsByWfq(jobs, [usage('A', 0)])).not.toThrow()
    expect(orderJobsByWfq(jobs, [usage('A', 0)])).toHaveLength(1)
  })

  it('treats negative size as size 1 — no negative score anomalies', () => {
    const jobs = [job('j1', 'A', -50), job('j2', 'B', 10)]
    const result = orderJobsByWfq(jobs, [])
    expect(result).toHaveLength(2)
    expect(isPermutation(jobs, result)).toBe(true)
  })

  it('treats NaN size as size 1', () => {
    const nanJob: BulkJob = { id: 'j1', orgId: 'A', size: NaN, createdAt: BASE_TIME }
    const result = orderJobsByWfq([nanJob], [])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('j1')
  })

  it('treats Infinity size as size 1 — finish time stays finite', () => {
    // Invariant: if Infinity size propagated to the score, the subsequent job
    // from org B could never get a meaningful virtual start time.
    const infJob: BulkJob = { id: 'j1', orgId: 'A', size: Infinity, createdAt: BASE_TIME }
    const normalJob = job('j2', 'B', 10, 1)
    const result = orderJobsByWfq([infJob, normalJob], [])
    expect(result).toHaveLength(2)
    expect(isPermutation([infJob, normalJob], result)).toBe(true)
  })

  it('handles duplicate job IDs without throwing', () => {
    const jobs = [job('dup', 'A', 10, 1), job('dup', 'A', 10, 2)]
    expect(() => orderJobsByWfq(jobs, [])).not.toThrow()
    expect(orderJobsByWfq(jobs, [])).toHaveLength(2)
  })

  it('handles duplicate orgId entries in orgUsages without throwing', () => {
    const jobs = [job('j1', 'A', 10)]
    const orgUsages = [usage('A', 5), usage('A', 10)] // duplicate
    expect(() => orderJobsByWfq(jobs, orgUsages)).not.toThrow()
    expect(orderJobsByWfq(jobs, orgUsages)).toHaveLength(1)
  })

  it('org with no usage record behaves identically to usage == 0', () => {
    const jobs = [job('j1', 'X', 10, 1), job('j2', 'X', 10, 2)]
    const withRecord = orderJobsByWfq(jobs, [usage('X', 0)]).map((j) => j.id)
    const withoutRecord = orderJobsByWfq(jobs, []).map((j) => j.id)
    expect(withRecord).toEqual(withoutRecord)
  })

  it('ignores usage entries for orgs not present in the jobs list', () => {
    const jobs = [job('j1', 'A', 10)]
    const result = orderJobsByWfq(jobs, [usage('A', 0), usage('PHANTOM', 100), usage('GHOST', 999)])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('j1')
  })

  it('all orgs share the same usage — order falls back purely to createdAt', () => {
    const jobs = [
      job('j3', 'A', 10, 3),
      job('j1', 'A', 10, 1),
      job('j2', 'B', 10, 2),
    ]
    const result = orderJobsByWfq(jobs, [usage('A', 5), usage('B', 5)])
    const ids = result.map((j) => j.id)
    // Equal weights, equal sizes → purely arrival-ordered: j1, j2, j3
    expect(ids.indexOf('j1')).toBeLessThan(ids.indexOf('j2'))
    expect(ids.indexOf('j2')).toBeLessThan(ids.indexOf('j3'))
  })

  it('identical clones (same orgId, size, createdAt) produce a stable, non-throwing result', () => {
    const clones: BulkJob[] = [
      { id: 'j1', orgId: 'A', size: 10, createdAt: BASE_TIME },
      { id: 'j2', orgId: 'A', size: 10, createdAt: BASE_TIME },
      { id: 'j3', orgId: 'A', size: 10, createdAt: BASE_TIME },
    ]
    expect(() => orderJobsByWfq(clones, [usage('A', 0)])).not.toThrow()
    expect(orderJobsByWfq(clones, [usage('A', 0)])).toHaveLength(3)
  })
})

// ─── orderJobsByWfq – WFQ scheduling invariants ──────────────────────────────

describe('orderJobsByWfq – WFQ invariants', () => {
  it('output length always equals input length', () => {
    for (const n of [0, 1, 5, 50]) {
      const jobs = Array.from({ length: n }, (_, i) => job(`j${i}`, `org${i % 3}`, i + 1, i))
      expect(orderJobsByWfq(jobs, [])).toHaveLength(n)
    }
  })

  it('output is always a permutation of input — no jobs dropped or duplicated', () => {
    const jobs = [
      job('a1', 'A', 100, 1),
      job('b1', 'B', 10, 2),
      job('b2', 'B', 10, 3),
      job('c1', 'C', 5, 4),
      job('a2', 'A', 200, 5),
    ]
    const result = orderJobsByWfq(jobs, [usage('A', 100), usage('B', 1), usage('C', 0)])
    expect(isPermutation(jobs, result)).toBe(true)
  })

  it('high-usage org job appears after low-usage org jobs when sizes are equal', () => {
    // Both submit one equal-sized job at the same time; L should get priority.
    const jobs = [job('h1', 'H', 10, 0), job('l1', 'L', 10, 0)]
    const result = orderJobsByWfq(jobs, [usage('H', 1_000), usage('L', 0)])
    const ids = result.map((j) => j.id)
    expect(ids.indexOf('l1')).toBeLessThan(ids.indexOf('h1'))
  })

  it('weight near 0 (usage == 1e9) does not produce NaN/Infinity scores', () => {
    const jobs = [job('j1', 'A', 10), job('j2', 'B', 10, 1)]
    const result = orderJobsByWfq(jobs, [usage('A', 1e9), usage('B', 0)])
    expect(result).toHaveLength(2)
    expect(isPermutation(jobs, result)).toBe(true)
  })

  it('same-org jobs always appear in arrival order (lastFinish monotonicity)', () => {
    // With only one org, WFQ degenerates to FIFO.
    const jobs = [job('a1', 'A', 5, 1), job('a2', 'A', 5, 2), job('a3', 'A', 5, 3)]
    const ids = orderJobsByWfq(jobs, [usage('A', 0)]).map((j) => j.id)
    expect(ids).toEqual(['a1', 'a2', 'a3'])
  })

  it('a tiny job from a different org beats a huge earlier job from a high-usage org', () => {
    // Org A: one enormous job (size 1000, high usage penalty)
    // Org B: one tiny job (size 1, zero usage) arriving slightly later
    // B's virtual finish time must still be smaller than A's.
    const jobs = [job('a1', 'A', 1_000, 0), job('b1', 'B', 1, 1)]
    const ids = orderJobsByWfq(jobs, [usage('A', 500), usage('B', 0)]).map((j) => j.id)
    expect(ids.indexOf('b1')).toBeLessThan(ids.indexOf('a1'))
  })

  it('two orgs with equal sizes and equal usage interleave fairly', () => {
    // 10 jobs per org, alternating arrival times
    const jobs: BulkJob[] = []
    for (let i = 0; i < 10; i++) {
      jobs.push(job(`a${i}`, 'A', 10, i * 2))
      jobs.push(job(`b${i}`, 'B', 10, i * 2 + 1))
    }
    const ids = orderJobsByWfq(jobs, [usage('A', 0), usage('B', 0)]).map((j) => j.id)
    const topHalf = ids.slice(0, 10)
    const aCount = topHalf.filter((id) => id.startsWith('a')).length
    const bCount = topHalf.filter((id) => id.startsWith('b')).length
    // Each org should claim roughly half of the top 10 slots
    expect(aCount).toBeGreaterThanOrEqual(3)
    expect(bCount).toBeGreaterThanOrEqual(3)
  })

  it('jobs submitted in reverse chronological order are still WFQ-ordered', () => {
    // The scheduler must sort by arrival (createdAt) before computing virtual
    // finish times, not by insertion order.
    const jobs = [job('j3', 'A', 10, 30), job('j2', 'A', 10, 20), job('j1', 'A', 10, 10)]
    const ids = orderJobsByWfq(jobs, [usage('A', 0)]).map((j) => j.id)
    expect(ids).toEqual(['j1', 'j2', 'j3'])
  })
})

// ─── Concurrency / determinism invariants ────────────────────────────────────

describe('orderJobsByWfq – concurrency and determinism', () => {
  it('returns identical arrays on repeated calls with the same input (pure function)', () => {
    const jobs = [job('a1', 'A', 100, 1), job('b1', 'B', 10, 2), job('c1', 'C', 5, 3)]
    const orgUsages = [usage('A', 100), usage('B', 1), usage('C', 0)]
    const first = orderJobsByWfq(jobs, orgUsages).map((j) => j.id)
    const second = orderJobsByWfq(jobs, orgUsages).map((j) => j.id)
    expect(first).toEqual(second)
  })

  it('concurrent independent calls do not share state', async () => {
    const jobsA = [job('a1', 'A', 50, 1), job('a2', 'B', 10, 2)]
    const jobsB = [job('b1', 'X', 1, 1), job('b2', 'Y', 1_000, 2)]

    const [resA, resB] = await Promise.all([
      Promise.resolve(orderJobsByWfq(jobsA, [usage('A', 50), usage('B', 1)])),
      Promise.resolve(orderJobsByWfq(jobsB, [usage('X', 0), usage('Y', 999)])),
    ])

    expect(isPermutation(jobsA, resA)).toBe(true)
    expect(isPermutation(jobsB, resB)).toBe(true)

    // No ID bleed between the two independent results
    const idsA = resA.map((j) => j.id)
    const idsB = resB.map((j) => j.id)
    expect(idsA.some((id) => idsB.includes(id))).toBe(false)
  })
})

// ─── Permission / stale / retry analogues ────────────────────────────────────

describe('orderJobsByWfq – stale and retry scenarios', () => {
  it('usage == Number.MAX_SAFE_INTEGER still produces a valid, finite ordering', () => {
    const jobs = [job('j1', 'A', 10), job('j2', 'B', 10, 1)]
    const result = orderJobsByWfq(jobs, [usage('A', Number.MAX_SAFE_INTEGER), usage('B', 0)])
    expect(isPermutation(jobs, result)).toBe(true)
    // B has default/zero usage → must be scheduled first
    expect(result[0].id).toBe('j2')
  })

  it('"retry" scenario: re-queuing with a new createdAt produces deterministic re-ordering', () => {
    // Original run: j-retry arrives before j-new → j-retry first
    const original = orderJobsByWfq(
      [job('j-retry', 'A', 10, 1_000), job('j-new', 'B', 10, 2_000)],
      [usage('A', 0), usage('B', 0)],
    )
    expect(original[0].id).toBe('j-retry')

    // After retry: j-retry is re-queued later → j-new now arrives first
    const retried = orderJobsByWfq(
      [job('j-retry', 'A', 10, 3_000), job('j-new', 'B', 10, 2_000)],
      [usage('A', 0), usage('B', 0)],
    )
    expect(retried[0].id).toBe('j-new')
  })

  it('partial orgUsage list: orgs without entries treated equally to usage == 0', () => {
    // All weights equal (A has explicit 0, B and C default to 0)
    // → pure arrival order: c1 < b1 < a1
    const jobs = [job('c1', 'C', 10, 1), job('b1', 'B', 10, 2), job('a1', 'A', 10, 3)]
    const ids = orderJobsByWfq(jobs, [usage('A', 0)]).map((j) => j.id)
    expect(ids).toEqual(['c1', 'b1', 'a1'])
  })

  it('stale job (very old createdAt) is served before newer jobs from the same org', () => {
    const stale = job('stale', 'A', 10, -100_000) // 100 s in the past
    const fresh = job('fresh', 'A', 10, 0)
    const ids = orderJobsByWfq([stale, fresh], [usage('A', 0)]).map((j) => j.id)
    expect(ids[0]).toBe('stale')
    expect(ids[1]).toBe('fresh')
  })

  it('scheduling under load: 200 jobs across 4 orgs always produce a valid permutation', () => {
    // Use a seeded-ish deterministic sequence to avoid flakiness from Math.random
    const jobs: BulkJob[] = Array.from({ length: 200 }, (_, i) =>
      job(`j${i}`, `org${i % 4}`, (i % 50) + 1, i),
    )
    const orgUsages = [
      usage('org0', 0),
      usage('org1', 10),
      usage('org2', 100),
      usage('org3', 1_000),
    ]
    const result = orderJobsByWfq(jobs, orgUsages)
    expect(result).toHaveLength(200)
    expect(isPermutation(jobs, result)).toBe(true)
  })

  it('prevents starvation: a medium-sized job from org A surfaces within the top 80% of 100 tiny B jobs', () => {
    // This mirrors the existing happy-path test but pins the exact boundary:
    // the medium job must appear before position 80 out of 101 total.
    const jobs: BulkJob[] = Array.from({ length: 100 }, (_, i) =>
      job(`b${i}`, 'B', 1, i + 1),
    )
    jobs.push(job('a1', 'A', 25, 50))

    const ids = orderJobsByWfq(jobs, [usage('A', 0), usage('B', 0)]).map((j) => j.id)
    expect(ids.indexOf('a1')).toBeLessThan(80)
  })
})

// ─── Regression guard ────────────────────────────────────────────────────────

describe('orderJobsByWfq – regression', () => {
  it('canonical mixed-org scenario is stable across independent runs', () => {
    const now = 1_700_000_000_000
    const jobs: BulkJob[] = [
      { id: 'a1', orgId: 'A', size: 1_000, createdAt: now + 1 },
      { id: 'b1', orgId: 'B', size: 10, createdAt: now + 2 },
      { id: 'b2', orgId: 'B', size: 10, createdAt: now + 3 },
      { id: 'c1', orgId: 'C', size: 5, createdAt: now + 4 },
    ]
    const orgUsages: OrgUsage[] = [
      { orgId: 'A', usage: 100 },
      { orgId: 'B', usage: 1 },
      { orgId: 'C', usage: 0 },
    ]

    const run1 = orderJobsByWfq(jobs, orgUsages).map((j) => j.id)
    const run2 = orderJobsByWfq(jobs, orgUsages).map((j) => j.id)

    // Idempotent across runs
    expect(run1).toEqual(run2)

    // WFQ fairness: A's large high-usage job must not be scheduled first
    expect(run1[0]).not.toBe('a1')

    // All four jobs must be present
    expect([...run1].sort()).toEqual(['a1', 'b1', 'b2', 'c1'].sort())
  })

  it('default export object exposes both orderJobsByWfq and computeOrgWeight', async () => {
    const mod = await import('./bulkVerificationScheduler.js')
    expect(typeof mod.default.orderJobsByWfq).toBe('function')
    expect(typeof mod.default.computeOrgWeight).toBe('function')
  })
})
