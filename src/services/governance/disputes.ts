import { randomUUID } from 'node:crypto'
import type { Dispute, DisputeInput } from './types.js'

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

export function submitDispute(input: DisputeInput): Dispute {
  const errors = validateDisputeInput(input)
  if (errors.length > 0) {
    throw new Error(`Invalid dispute: ${errors.join('; ')}`)
  }

  const now = new Date()
  const dispute: Dispute = {
    id: randomUUID(),
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
  if (dispute.status === 'resolved') throw new Error('Dispute already resolved')
  if (dispute.status === 'dismissed') throw new Error('Cannot resolve a dismissed dispute')
  if (isExpired(dispute)) {
    dispute.status = 'expired'
    throw new Error('Cannot resolve an expired dispute')
  }
  if (!resolution || resolution.trim().length === 0) {
    throw new Error('Resolution text is required')
  }

  dispute.status = 'resolved'
  dispute.resolution = resolution
  return dispute
}

export function dismissDispute(id: string, reason: string): Dispute {
  const dispute = store.get(id)
  if (!dispute) throw new Error(`Dispute ${id} not found`)
  if (dispute.status === 'resolved') throw new Error('Cannot dismiss a resolved dispute')
  if (dispute.status === 'dismissed') throw new Error('Dispute already dismissed')
  if (!reason || reason.trim().length === 0) {
    throw new Error('Dismiss reason is required')
  }

  dispute.status = 'dismissed'
  dispute.resolution = reason
  return dispute
}

export function markUnderReview(id: string): Dispute {
  const dispute = store.get(id)
  if (!dispute) throw new Error(`Dispute ${id} not found`)
  if (dispute.status !== 'pending') {
    throw new Error(`Cannot review dispute in "${dispute.status}" state`)
  }

  dispute.status = 'under_review'
  return dispute
}
