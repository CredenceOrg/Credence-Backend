/**
 * @file src/db/outbox/transitions.ts
 *
 * Canonical transition matrix for the outbox event lifecycle.
 *
 * ## Lifecycle states
 *
 * | State       | Meaning                                                          |
 * |-------------|------------------------------------------------------------------|
 * | pending     | Event waiting to be picked up by a consumer                      |
 * | processing  | Event claimed by a consumer for publishing                       |
 * | published   | Event successfully delivered (terminal)                          |
 * | failed      | Event exceeded max retries (terminal, but may be quarantined)    |
 * | dead_letter | Event permanently failed and moved to dead-letter queue          |
 *
 * ## Legal transitions
 *
 * | State       | Targets                                  | Trigger                    |
 * |-------------|------------------------------------------|----------------------------|
 * | pending     | processing                               | Consumer claims event      |
 * | processing  | published                                | Successful publish         |
 * | processing  | pending                                  | Transient failure + retry  |
 * | processing  | dead_letter                              | Max retries exceeded       |
 * | published   | —                                        | Terminal                    |
 * | failed      | —                                        | Terminal                    |
 * | dead_letter | —                                        | Terminal                    |
 *
 * ## Design
 *
 *  - This module provides the **application-level** transition matrix.  The SQL
 *    queries in `OutboxRepository` enforce transitions via WHERE clauses (e.g.
 *    `WHERE status = 'processing'`), but this matrix is the single source of
 *    truth for documentation, tests, and programmatic validation.
 *  - The matrix is pure / side-effect-free.  Failed transitions return a
 *    structured error; no partial state is written.
 *
 * ## Security / correctness assumptions
 *
 *  - The matrix validates the **logical** transition only.  Persistence is
 *    enforced by the repository's SQL-level WHERE clauses.
 *  - `published` is truly terminal: no API or worker moves an event back.
 *  - `failed` and `dead_letter` are terminal for the main outbox table.
 *    Recovery happens via quarantine → reinjection, which creates a new
 *    `pending` row.
 */

import { TransitionMatrix } from '../../lib/stateTransition.js'

// ── Status type ─────────────────────────────────────────────────────────────

/** Canonical outbox event status values. */
export type OutboxLifecycleStatus = 'pending' | 'processing' | 'published' | 'failed' | 'dead_letter'

/**
 * All canonical outbox lifecycle statuses, in a stable order.
 *
 * Exposed so that tests and callers can enumerate the full state space
 * (including terminal states) without duplicating the union literal.
 */
export const OUTBOX_LIFECYCLE_STATUSES: readonly OutboxLifecycleStatus[] = [
  'pending',
  'processing',
  'published',
  'failed',
  'dead_letter',
] as const

// ── Transition matrix ───────────────────────────────────────────────────────

/** Legal transitions for the outbox event lifecycle. */
export const OUTBOX_LIFECYCLE_TRANSITIONS = new TransitionMatrix<OutboxLifecycleStatus>([
  { from: 'pending',    to: 'processing',  action: 'claim' },
  { from: 'processing', to: 'published',   action: 'mark_published' },
  { from: 'processing', to: 'pending',     action: 'retry' },
  { from: 'processing', to: 'dead_letter', action: 'dead_letter' },
  // 'published', 'failed', and 'dead_letter' are terminal — no outgoing transitions.
])

/**
 * Terminal outbox lifecycle statuses.
 *
 * These states have no outgoing transitions in the main outbox table.
 * Recovery for `failed` / `dead_letter` happens via quarantine → reinjection,
 * which creates a brand-new `pending` row rather than mutating this one.
 */
export const OUTBOX_TERMINAL_STATUSES: readonly OutboxLifecycleStatus[] = [
  'published',
  'failed',
  'dead_letter',
] as const

/**
 * Returns true when `status` is a terminal outbox lifecycle state.
 *
 * Terminal states must never be transitioned out of; callers can use this to
 * short-circuit retries and avoid writing partial state for already-finalized
 * events.
 */
export function isTerminalOutboxStatus(status: OutboxLifecycleStatus): boolean {
  return OUTBOX_TERMINAL_STATUSES.includes(status)
}

/**
 * Validate whether an outbox event status transition is legal.
 */
export function isValidOutboxTransition(
  from: OutboxLifecycleStatus,
  to: OutboxLifecycleStatus,
): boolean {
  return OUTBOX_LIFECYCLE_TRANSITIONS.isValid(from, to)
}

/**
 * Attempt an outbox status transition, returning a structured result.
 */
export function tryOutboxTransition(
  from: OutboxLifecycleStatus,
  to: OutboxLifecycleStatus,
) {
  return OUTBOX_LIFECYCLE_TRANSITIONS.tryTransition(from, to)
}

/**
 * Returns all legal target statuses from a given current status.
 */
export function getAllowedOutboxTargets(
  current: OutboxLifecycleStatus,
): OutboxLifecycleStatus[] {
  return OUTBOX_LIFECYCLE_TRANSITIONS.getAllowedTargets(current)
}

/**
 * Returns true when a transition is a no-op (from === to).
 *
 * Self-transitions are never legal in the outbox matrix; this helper exists so
 * callers and tests can distinguish "no-op" from "illegal cross-state
 * transition" when diagnosing retries or duplicate deliveries.
 */
export function isSelfOutboxTransition(
  from: OutboxLifecycleStatus,
  to: OutboxLifecycleStatus,
): boolean {
  return from === to
}

/**
 * Returns true when `from` can legally reach `to` in exactly one step.
 *
 * Equivalent to {@link isValidOutboxTransition} but named for readability at
 * call sites that reason about recovery paths (e.g. retry vs. dead-letter).
 */
export function canRecoverOutboxTransition(
  from: OutboxLifecycleStatus,
  to: OutboxLifecycleStatus,
): boolean {
  return OUTBOX_LIFECYCLE_TRANSITIONS.isValid(from, to)
}
