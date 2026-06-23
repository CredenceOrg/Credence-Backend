import { randomUUID } from 'node:crypto'
import type { Dispute, DisputeInput, DisputeStatus } from './types.js'
import { tryTransition } from './disputeStateMachine.js'

const store = new Map<string, Dispute>()

const MIN_DEADLINE_MS = 60 * 60 * 1000 // 1 hour
const MAX_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/

export function resetStore(): void {
  store.clear()
}

export function validateDisputeInput(input: DisputeInput): string[] {
  const errors: string[] = []

  if (!input.filedBy || typeof input.filedBy !== 'string') {
    errors.push('filedBy is required')
  } else if (!STELLAR_ADDRESS_RE.test(input.filedBy)) {
    errors.push('filedBy must be a valid Stellar address')
  }

  if (!input.respondent || typeof input.respondent !== 'string') {
    errors.push('respondent is required')
  } else if (!STELLAR_ADDRESS_RE.test(input.respondent)) {
    errors.push('respondent must be a valid Stellar address')
  }

  if (input.filedBy && input.respondent && input.filedBy === input.respondent) {
    errors.push('filedBy and respondent must differ')
  }

  if (!input.reason || typeof input.reason !== 'string') {
    errors.push('reason is required')
  } else if (input.reason.trim().length < 10) {
    errors.push('reason must be at least 10 characters')
  }

  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    errors.push('at least one piece of evidence is required')
  }

  if (typeof input.deadlineMs !== 'number' || input.deadlineMs < MIN_DEADLINE_MS) {
    errors.push(`deadline must be at least ${MIN_DEADLINE_MS}ms from now`)
  } else if (input.deadlineMs > MAX_DEADLINE_MS) {
    errors.push(`deadline must be at most ${MAX_DEADLINE_MS}ms from now`)
  }

  return errors
}

export function submitDispute(input: DisputeInput, tenantId: string): Dispute {
  const errors = validateDisputeInput(input)
  if (errors.length > 0) {
    throw new Error(`Invalid dispute: ${errors.join('; ')}`)
  }

  const now = new Date()
  const dispute: Dispute = {
    id: randomUUID(),
    tenantId,
    filedBy: input.filedBy,
    respondent: input.respondent,
    reason: input.reason,
    evidence: [...input.evidence],
    status: 'pending',
    createdAt: now,
    deadline: new Date(now.getTime() + input.deadlineMs),
    resolution: null,
  }

  store.set(dispute.id, dispute)
  return dispute
}

export function getDispute(id: string): Dispute | undefined {
  return store.get(id)
}

export function isExpired(dispute: Dispute): boolean {
  return new Date() > dispute.deadline
}

export function resolveDispute(id: string, resolution: string): Dispute {
  const dispute = store.get(id)
  if (!dispute) throw new Error(`Dispute ${id} not found`)
  if (isExpired(dispute)) {
    dispute.status = 'expired'
    throw new Error('Cannot resolve an expired dispute')
  }
  if (!resolution || resolution.trim().length === 0) {
    throw new Error('Resolution text is required')
  }

  const transition = tryTransition(dispute.status, 'resolved')
  if (!transition.success) {
    throw new Error(transition.error)
  }

  dispute.status = 'resolved'
  dispute.resolution = resolution
  return dispute
}

export function dismissDispute(id: string, reason: string): Dispute {
  const dispute = store.get(id)
  if (!dispute) throw new Error(`Dispute ${id} not found`)
  if (!reason || reason.trim().length === 0) {
    throw new Error('Dismiss reason is required')
  }

  const transition = tryTransition(dispute.status, 'dismissed')
  if (!transition.success) {
    throw new Error(transition.error)
  }

  dispute.status = 'dismissed'
  dispute.resolution = reason
  return dispute
}

export function markUnderReview(id: string): Dispute {
  const dispute = store.get(id)
  if (!dispute) throw new Error(`Dispute ${id} not found`)

  const transition = tryTransition(dispute.status, 'under_review')
  if (!transition.success) {
    throw new Error(transition.error)
  }

  dispute.status = 'under_review'
  return dispute
}

export interface ListDisputesFilter {
  tenantId: string
  status?: DisputeStatus
}

export interface ListDisputesPagination {
  limit: number
  cursor?: { t: string; i: string }
}

export interface ListDisputesResult {
  data: Dispute[]
  hasMore: boolean
}

export function listDisputes(filter: ListDisputesFilter, pagination: ListDisputesPagination): ListDisputesResult {
  let results = Array.from(store.values()).filter(d => d.tenantId === filter.tenantId)
  
  if (filter.status) {
    results = results.filter(d => d.status === filter.status)
  }

  // Stable ordering by createdAt (descending), then by id (descending)
  results.sort((a, b) => {
    const timeDiff = b.createdAt.getTime() - a.createdAt.getTime()
    if (timeDiff !== 0) return timeDiff
    return b.id.localeCompare(a.id)
  })

  if (pagination.cursor) {
    const cursorTimeMs = new Date(pagination.cursor.t).getTime()
    const cursorId = pagination.cursor.i

    results = results.filter(d => {
      const timeMs = d.createdAt.getTime()
      if (timeMs < cursorTimeMs) return true
      if (timeMs === cursorTimeMs && d.id < cursorId) return true
      return false
    })
  }

  // take limit + 1
  const limited = results.slice(0, pagination.limit + 1)
  const hasMore = limited.length > pagination.limit
  if (hasMore) {
    limited.pop()
  }

  return {
    data: limited,
    hasMore
  }
}
