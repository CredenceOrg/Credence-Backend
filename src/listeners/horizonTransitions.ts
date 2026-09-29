/**
 * @file src/listeners/horizonTransitions.ts
 *
 * Canonical transition matrix and enforcement for the Horizon ingestion
 * lifecycle (the node/bond state machine driven by Horizon events).
 *
 * ## Lifecycle states
 *
 * | State      | Meaning                                                              |
 * |------------|----------------------------------------------------------------------|
 * | active     | Node/bond exists on chain and is live (created by a `bond` event)    |
 * | slashed    | Node/bond incurred a slash on chain (still on chain, penalized)      |
 * | withdrawn  | Node/bond fully withdrawn on chain (terminal)                        |
 *
 * ## Legal transitions
 *
 * | From      | To         | Trigger                                  |
 * |-----------|------------|------------------------------------------|
 * | active    | slashed    | `slash` event ingested                   |
 * | active    | withdrawn  | `withdrawal` event ingested              |
 * | slashed   | withdrawn  | `withdrawal` after a slash (bond ended)  |
 * | withdrawn | —          | Terminal: no outgoing transitions        |
 *
 * ## Decision procedure (`resolveIngestionTransition`)
 *
 * Horizon delivers events **at-least-once** (cursors may replay after a
 * crash, a lease hand-off, or a manual re-ingestion), so the enforcement
 * layer distinguishes three deterministic outcomes instead of a boolean:
 *
 *  - `node_not_ingested` — a `slash`/`withdrawal` arrived for a node the
 *    store has never seen. The local store is missing the prior `bond`
 *    creation (an ingestion gap); materializing `slashed`/`withdrawn`
 *    state from nothing would create unauthorized state. Rejected with a
 *    typed error; no write. The operator must backfill via reconciliation
 *    (`IdentityStateSync`, `replayLedgerRange`) before the event can apply.
 *  - `noop` — the event targets the state the node is already in
 *    (`active → active`, `slashed → slashed`, `withdrawn → withdrawn`).
 *    This is the expected **replay** case: same-state redelivery is a safe
 *    no-op (no write, no error) so a replay storm can never double-apply
 *    or poison the stream.
 *  - `applied` — a legal state *change*; the caller persists the new state.
 *  - `rejected` — an illegal change (e.g. `withdrawn → slashed`,
 *    `slashed → active`). On-chain ordering makes these impossible for a
 *    correct feed, so their arrival signals a stale/out-of-order or
 *    malformed event. Rejected with a typed error and **no write** — no
 *    unauthorized or partial state is ever left behind.
 *
 * ## Security / correctness assumptions
 *
 *  - The matrix validates the **logical** lifecycle only. Callers still own
 *    authentication, authorization, cursor/idempotency handling, and
 *    persistence. It is a guardrail, not a replacement for optimistic
 *    concurrency control or operation-id idempotency.
 *  - A node only comes into existence through a `bond` event (upsert into
 *    `active`). `slash`/`withdrawal` on an unknown node is rejected, never
 *    auto-created.
 *  - `withdrawn` is terminal: a fully withdrawn bond cannot be slashed or
 *    re-activated on chain, so those transitions are rejected instead of
 *    silently corrupting local state.
 *
 * ## Compatibility / migration
 *
 *  - Enforcement is **additive**: previously-undefined behavior (writing a
 *    slash/withdrawal for an unknown node, or an illegal state change) is
 *    now rejected with a structured error. Legal transitions behave exactly
 *    as before — the same repository writes are issued.
 *  - Rolling back means removing the `resolveIngestionTransition` call in
 *    `HorizonListener.handleEvent` and dropping `getNodeStatus` from the
 *    repository contract. No schema migration is required.
 */

import { TransitionMatrix, type TransitionResult } from '../lib/stateTransition.js'

// ── State type ──────────────────────────────────────────────────────────────

/** Canonical ingestion lifecycle states for a node/bond. */
export type HorizonIngestionState = 'active' | 'slashed' | 'withdrawn'

/**
 * Returns `true` when `s` is a canonical ingestion lifecycle state.
 * Used to coerce repository reads (which may return arbitrary strings) into
 * the closed state vocabulary before any decision is made.
 */
export function isHorizonIngestionState(s: string | null | undefined): s is HorizonIngestionState {
  return s === 'active' || s === 'slashed' || s === 'withdrawn'
}

// ── Transition matrix ───────────────────────────────────────────────────────

/**
 * Legal lifecycle *changes* driven by Horizon ingestion.
 *
 * Self-transitions are intentionally **not** listed here so that terminal
 * detection stays meaningful (`withdrawn` is a true sink). Same-state
 * redelivery is handled by the enforcement layer (`resolveIngestionTransition`)
 * as an idempotent no-op — see the module docs.
 */
export const HORIZON_INGESTION_TRANSITIONS = new TransitionMatrix<HorizonIngestionState>([
  { from: 'active',    to: 'slashed',   action: 'slash' },
  { from: 'active',    to: 'withdrawn', action: 'withdraw' },
  { from: 'slashed',   to: 'withdrawn', action: 'withdraw' },
  // 'withdrawn' is terminal — no outgoing transitions.
])

// ── Decision result ─────────────────────────────────────────────────────────

/**
 * Deterministic outcome of validating an ingestion transition at the entry
 * point. `applied` and `noop` are both *accepted* (callers only write for
 * `applied`); `rejected` is a hard rejection that must not write anything.
 */
export type IngestionTransitionDecision =
  | { status: 'applied' }
  | { status: 'noop'; current: HorizonIngestionState }
  | {
      status: 'rejected'
      code: 'INVALID_STATE_TRANSITION' | 'NODE_NOT_INGESTED'
      current: HorizonIngestionState | null
      requested: HorizonIngestionState
    }

/**
 * Validate a Horizon ingestion state transition at the entry point.
 *
 * @param current   - Current persisted state, or `null`/`undefined` when the
 *                    node has never been ingested.
 * @param requested - The state the ingested event wants to move the node to.
 * @returns A discriminated `IngestionTransitionDecision` — never throws.
 */
export function resolveIngestionTransition(
  current: HorizonIngestionState | null | undefined,
  requested: HorizonIngestionState,
): IngestionTransitionDecision {
  // Unknown node: a slash/withdrawal without a prior bond is an ingestion
  // gap. Reject deterministically instead of materializing phantom state.
  if (current === null || current === undefined) {
    return {
      status: 'rejected',
      code: 'NODE_NOT_INGESTED',
      current: null,
      requested,
    }
  }

  // Same-state redelivery (at-least-once replay) → safe no-op, no write.
  if (current === requested) {
    return { status: 'noop', current }
  }

  if (HORIZON_INGESTION_TRANSITIONS.isValid(current, requested)) {
    return { status: 'applied' }
  }

  return {
    status: 'rejected',
    code: 'INVALID_STATE_TRANSITION',
    current,
    requested,
  }
}

/**
 * Matrix-level validation (no unknown-node / replay semantics).
 * Returns a structured `TransitionResult` — callers check `result.success`.
 */
export function validateIngestionTransition(
  from: HorizonIngestionState,
  to: HorizonIngestionState,
): TransitionResult<HorizonIngestionState> {
  return HORIZON_INGESTION_TRANSITIONS.tryTransition(from, to)
}

/** All legal target states from `current` (excluding idempotent self-loops). */
export function getAllowedIngestionTargets(
  current: HorizonIngestionState,
): HorizonIngestionState[] {
  return HORIZON_INGESTION_TRANSITIONS.getAllowedTargets(current)
}

/** States with no outgoing transitions (`withdrawn`). */
export function getTerminalIngestionStates(): HorizonIngestionState[] {
  return HORIZON_INGESTION_TRANSITIONS.getTerminalStates()
}

// ── Typed error ─────────────────────────────────────────────────────────────

/**
 * Structured error thrown by the ingestion entry point when a transition is
 * rejected. Carries the node id, event type, current state, and requested
 * state so callers can route to a DLQ / audit log without guessing.
 */
export class HorizonIngestionTransitionError extends Error {
  public readonly code: 'INVALID_STATE_TRANSITION' | 'NODE_NOT_INGESTED'
  public readonly nodeId: string
  public readonly eventType: string
  public readonly current: HorizonIngestionState | null
  public readonly requested: HorizonIngestionState

  constructor(params: {
    code: 'INVALID_STATE_TRANSITION' | 'NODE_NOT_INGESTED'
    nodeId: string
    eventType: string
    current: HorizonIngestionState | null
    requested: HorizonIngestionState
  }) {
    const currentLabel = params.current ?? '(none)'
    super(
      params.code === 'NODE_NOT_INGESTED'
        ? `Horizon ingestion rejected: ${params.eventType} for node ${params.nodeId} references a node that has never been ingested (current=${currentLabel}, requested=${params.requested}). Reconcile the gap before re-ingesting.`
        : `Horizon ingestion rejected: illegal lifecycle transition for node ${params.nodeId} (current=${currentLabel}, requested=${params.requested}, event=${params.eventType}).`,
    )
    this.name = 'HorizonIngestionTransitionError'
    this.code = params.code
    this.nodeId = params.nodeId
    this.eventType = params.eventType
    this.current = params.current
    this.requested = params.requested
  }
}
