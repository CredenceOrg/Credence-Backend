import { describe, it, expect } from 'vitest'
import { orderJobsByWfq, computeOrgWeight } from './bulkVerificationScheduler.js'

describe('bulkVerificationScheduler', () => {
  it('computes decreasing weight for higher usage', () => {
    expect(computeOrgWeight(0)).toBe(1)
    expect(computeOrgWeight(1)).toBeCloseTo(0.5)
    expect(computeOrgWeight(9)).toBeCloseTo(1 / 10)
  })

  it('orders a mix of large and small jobs fairly across orgs', () => {
    const now = Date.now()
    const jobs = [
      { id: 'a1', orgId: 'A', size: 1000, createdAt: now + 1 }, // large job from A
      { id: 'b1', orgId: 'B', size: 10, createdAt: now + 2 },
      { id: 'b2', orgId: 'B', size: 10, createdAt: now + 3 },
      { id: 'b3', orgId: 'B', size: 10, createdAt: now + 4 },
      { id: 'c1', orgId: 'C', size: 5, createdAt: now + 5 },
    ]

    // Org A has high recent usage, B and C have low usage.
    const orgUsages = [
      { orgId: 'A', usage: 100 },
      { orgId: 'B', usage: 1 },
      { orgId: 'C', usage: 0 },
    ]

    const ordered = orderJobsByWfq(jobs, orgUsages)

    // Expect some B/C small jobs to get scheduled before the huge A job
    const ids = ordered.map((j) => j.id)
    expect(ids.indexOf('a1')).toBeGreaterThan(ids.indexOf('b1'))
  })

  it('prevents starvation: many tiny jobs do not entirely block others', () => {
    const now = Date.now()
    const jobs: any[] = []
    for (let i = 0; i < 100; i++) {
      jobs.push({ id: `b${i}`, orgId: 'B', size: 1, createdAt: now + i + 1 })
    }
    // A single medium job from A
    jobs.push({ id: 'a1', orgId: 'A', size: 25, createdAt: now + 50 })

    const orgUsages = [
      { orgId: 'A', usage: 0 },
      { orgId: 'B', usage: 0 },
    ]

    const ordered = orderJobsByWfq(jobs, orgUsages)
    const ids = ordered.map((j) => j.id)

    // The medium job should appear before all 100 tiny jobs finish ordering
    expect(ids.indexOf('a1')).toBeLessThan(80)
  })

  it('handles missing usage records by applying default weight', () => {
    const now = Date.now()
    const jobs = [
      { id: 'x1', orgId: 'X', size: 10, createdAt: now + 1 },
      { id: 'y1', orgId: 'Y', size: 10, createdAt: now + 2 },
    ]
    const ordered = orderJobsByWfq(jobs, [])
    expect(ordered.length).toBe(2)
  })
})
