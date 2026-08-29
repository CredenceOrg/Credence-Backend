/**
 * @file src/services/settlementTransitions.ts
 *
 * Canonical transition matrix and enforcement for settlement lifecycle states.
 *
 * ## Lifecycle states
 *
 * | State     | Meaning                                                         |
 * |-----------|-----------------------------------------------------------------|
 * | pending   | Settlement record created; reconciliation not yet confirmed      |
 * | settled   | Settlement confirmed and finalized (terminal)                    |
 * | failed    | Settlement reconciliation failed; may be retried                 |
 *
 * ## Legal transitions
 *
 * | From    | To      | Trigger                                    |
 * |---------|---------|--------------------------------------------|
 * | pending | settled | Reconciliation confirms on-chain settlement |
 * | pending | failed  | Reconciliation detects failure              |
 * | failed  | pending | Manual or automated retry after fix         |
 * | settled | —       | Terminal: no outgoing transitions           |
 *
 * ## Design
 *
 *  - `settled` is **terminal**: once a settlement is confirmed, it must not be
 *    rolled back without an explicit compensating transaction (not modeled here).
 *  - `failed → pending` is the retry path: a settlement that failed reconciliation
 *    can be re-queued for processing.
 *  - The matrix is pure / side-effect-free.  Enforcement happens in
 *    `SettlementService.upsertSettlementStatus` which performs an optimistic
 *    concurrency check (read current status → validate → write).
 *
 * ## Security / correctness assumptions
 *
 *  - Transition enforcement is **application-level only**.  The database CHECK
 *    constraint (`status IN ('pending', 'settled', 'failed')`) validates values
 *    but does not enforce ordering.  The matrix fills that gap.
 *  - Rejected transitions return a structured error; no partial state is written.
 *
 * ## Migration / rollback
 *
 *  - Adding transition enforcement is backward-compatible: it only rejects
 *    transitions that were previously undefined behavior.
 *  - Rolling back requires removing the `validateSettlementTransition` call in
 *    the service layer.
 */

import { TransitionMatrix, type TransitionResult } from '../lib/stateTransition.js'

// ── Status type ─────────────────────────────────────────────────────────────

/** Canonical settlement status values. */
export type SettlementLifecycleStatus = 'pending' | 'settled' | 'failed'

// ── Transition matrix ───────────────────────────────────────────────────────

/** Legal transitions for the settlement lifecycle. */
export const SETTLEMENT_TRANSITIONS = new TransitionMatrix<SettlementLifecycleStatus>([
  { from: 'pending', to: 'settled', action: 'settle' },
  { from: 'pending', to: 'failed',  action: 'fail' },
  { from: 'failed',  to: 'pending', action: 'retry' },
  // 'settled' is terminal — no outgoing transitions.
])

/**
 * Validate whether a settlement status transition is legal.
 *
 * @returns `TransitionResult` — callers should check `result.success`.
 *
 * @example
 * ```ts
 * const result = validateSettlementTransition('pending', 'settled')
 * if (!result.success) {
 *   throw new ValidationError(result.error!)
 * }
 * ```
 */
export function validateSettlementTransition(
  from: SettlementLifecycleStatus,
  to: SettlementLifecycleStatus,
): TransitionResult<SettlementLifecycleStatus> {
  return SETTLEMENT_TRANSITIONS.tryTransition(from, to)
}

/**
 * Returns all legal target statuses from a given current status.
 * Useful for generating OpenAPI documentation or validation hints.
 */
export function getAllowedSettlementTargets(
  current: SettlementLifecycleStatus,
): SettlementLifecycleStatus[] {
  return SETTLEMENT_TRANSITIONS.getAllowedTargets(current)
}
