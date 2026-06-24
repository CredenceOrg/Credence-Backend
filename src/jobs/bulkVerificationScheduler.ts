/**
 * Weighted Fair Queueing helper for bulk verification jobs.
 *
 * This module provides a deterministic ordering function that orders pending
 * bulk jobs fairly by organization using recent consumption (org_usage_daily).
 * The exported `orderJobsByWfq` function is pure and easy to unit-test.
 */

export interface BulkJob {
  id: string
  orgId: string
  size: number // number of addresses in the job
  createdAt: number // epoch ms
}

export interface OrgUsage {
  orgId: string
  usage: number // recent consumption metric (e.g. daily usage count)
}

/**
 * Compute a weight for an org from recent usage.
 * Higher recent usage -> lower weight. We use a simple transform that keeps
 * weights positive and bounded.
 */
export function computeOrgWeight(usage: number): number {
  // Protect against negative/NaN values
  const u = Number.isFinite(usage) && usage > 0 ? usage : 0
  // weight in (0, 1], decreasing as usage increases; add small epsilon
  return 1 / (1 + u)
}

/**
 * Order jobs using a WFQ-like virtual finish time algorithm.
 *
 * Algorithm:
 * - Jobs are processed in arrival order (createdAt) to simulate enqueue arrivals.
 * - For each job, maintain lastFinish per org; start = max(lastFinish[org], globalVTime)
 * - finish = start + (size / weight(org))
 * - assign the finish as the job score; finally sort by score then createdAt
 *
 * This favors orgs with lower recent usage (higher weight) while preventing
 * starvation because every job contributes to its org's lastFinish.
 */
export function orderJobsByWfq(jobs: BulkJob[], orgUsages: OrgUsage[]): BulkJob[] {
  const weightMap = new Map<string, number>()
  for (const ou of orgUsages) {
    weightMap.set(ou.orgId, computeOrgWeight(ou.usage))
  }

  // Default weight when an org has no usage record
  const defaultWeight = 1

  // Sort incoming jobs by createdAt to simulate arrival order
  const arrivals = [...jobs].sort((a, b) => a.createdAt - b.createdAt)

  const lastFinish = new Map<string, number>()
  let globalVTime = 0

  type Scored = { job: BulkJob; finish: number }
  const scored: Scored[] = []

  for (const job of arrivals) {
    const w = weightMap.get(job.orgId) ?? defaultWeight
    // guard: small sizes or zero weight
    const size = Number.isFinite(job.size) && job.size > 0 ? job.size : 1
    const start = Math.max(lastFinish.get(job.orgId) ?? 0, globalVTime)
    const finish = start + size / w
    lastFinish.set(job.orgId, finish)
    globalVTime = start
    scored.push({ job, finish })
  }

  // Order by finish then createdAt to break ties
  scored.sort((a, b) => {
    if (a.finish !== b.finish) return a.finish - b.finish
    return a.job.createdAt - b.job.createdAt
  })

  return scored.map((s) => s.job)
}

export default {
  orderJobsByWfq,
  computeOrgWeight,
}
