import type { DisputeStatus } from './types.js'

export interface StateTransition {
  from: DisputeStatus
  to: DisputeStatus
  action: string
}

export const DISPUTE_STATES: ReadonlyArray<DisputeStatus> = [
  'pending',
  'under_review',
  'resolved',
  'dismissed',
  'expired',
] as const

export const VALID_TRANSITIONS: ReadonlyArray<StateTransition> = [
  { from: 'pending', to: 'under_review', action: 'mark_under_review' },
  { from: 'pending', to: 'resolved', action: 'resolve' },
  { from: 'pending', to: 'dismissed', action: 'dismiss' },
  { from: 'pending', to: 'expired', action: 'expire' },
  { from: 'under_review', to: 'resolved', action: 'resolve' },
  { from: 'under_review', to: 'dismissed', action: 'dismiss' },
  { from: 'under_review', to: 'expired', action: 'expire' },
] as const

export function isValidTransition(from: DisputeStatus, to: DisputeStatus): boolean {
  return VALID_TRANSITIONS.some(t => t.from === from && t.to === to)
}

export interface TransitionResult {
  success: boolean
  from: DisputeStatus
  to: DisputeStatus
  error?: string
}

export function tryTransition(from: DisputeStatus, to: DisputeStatus): TransitionResult {
  if (isValidTransition(from, to)) {
    return { success: true, from, to }
  }
  return {
    success: false,
    from,
    to,
    error: `Invalid transition from "${from}" to "${to}"`
  }
}
