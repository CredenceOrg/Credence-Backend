/**
 * @file src/services/governance/disputeStateMachine.ts
 *
 * Canonical transition matrix and enforcement for the dispute lifecycle.
 *
 * ## Lifecycle states
 *
 * | State        | Meaning                                              |
 * |--------------|------------------------------------------------------|
 * | pending      | Dispute filed, awaiting review                       |
 * | under_review | Actively being reviewed by an admin                  |
 * | resolved     | Dispute resolved with a resolution (terminal)        |
 * | dismissed    | Dispute dismissed by an admin (terminal)             |
 * | expired      | Dispute deadline elapsed (terminal)                  |
 *
 * ## Legal transitions
 *
 * | From         | To           | Trigger             |
 * |--------------|--------------|---------------------|
 * | pending      | under_review | mark_under_review   |
 * | pending      | resolved     | resolve             |
 * | pending      | dismissed    | dismiss             |
 * | pending      | expired      | expire              |
 * | under_review | resolved     | resolve             |
 * | under_review | dismissed    | dismiss             |
 * | under_review | expired      | expire              |
 *
 * Terminal states: `resolved`, `dismissed`, `expired` — no outgoing transitions.
 */

import type { DisputeStatus } from './types.js'
import { TransitionMatrix, type TransitionResult as GenericTransitionResult } from '../../lib/stateTransition.js'

// ── Backward-compatible types ────────────────────────────────────────────────

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

// ── Transition matrix ───────────────────────────────────────────────────────

/** The underlying TransitionMatrix instance. */
const DISPUTE_MATRIX = new TransitionMatrix<DisputeStatus>([
  { from: 'pending', to: 'under_review', action: 'mark_under_review' },
  { from: 'pending', to: 'resolved', action: 'resolve' },
  { from: 'pending', to: 'dismissed', action: 'dismiss' },
  { from: 'pending', to: 'expired', action: 'expire' },
  { from: 'under_review', to: 'resolved', action: 'resolve' },
  { from: 'under_review', to: 'dismissed', action: 'dismiss' },
  { from: 'under_review', to: 'expired', action: 'expire' },
])

/**
 * Flat list of legal transitions for backward compatibility with callers
 * that iterate the array (e.g. tests, OpenAPI spec generators).
 */
export const VALID_TRANSITIONS: ReadonlyArray<StateTransition> = [
  { from: 'pending', to: 'under_review', action: 'mark_under_review' },
  { from: 'pending', to: 'resolved', action: 'resolve' },
  { from: 'pending', to: 'dismissed', action: 'dismiss' },
  { from: 'pending', to: 'expired', action: 'expire' },
  { from: 'under_review', to: 'resolved', action: 'resolve' },
  { from: 'under_review', to: 'dismissed', action: 'dismiss' },
  { from: 'under_review', to: 'expired', action: 'expire' },
]

// ── Backward-compatible API ─────────────────────────────────────────────────

export function isValidTransition(from: DisputeStatus, to: DisputeStatus): boolean {
  return DISPUTE_MATRIX.isValid(from, to)
}

export interface TransitionResult {
  success: boolean
  from: DisputeStatus
  to: DisputeStatus
  error?: string
}

export function tryTransition(from: DisputeStatus, to: DisputeStatus): TransitionResult {
  return DISPUTE_MATRIX.tryTransition(from, to)
}

// ── New API ──────────────────────────────────────────────────────────────────

/** Access the underlying matrix for testing or documentation. */
export function getDisputeTransitionMatrix(): TransitionMatrix<DisputeStatus> {
  return DISPUTE_MATRIX
}
