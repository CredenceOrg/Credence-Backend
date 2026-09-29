/**
 * @file src/services/keyManager/keyTransitions.ts
 *
 * Canonical transition matrices for the signing key and KEK lifecycles.
 *
 * ## Signing key lifecycle
 *
 * | State   | Meaning                                                             |
 * |---------|---------------------------------------------------------------------|
 * | active  | Current signing key; used for all new JWTs                         |
 * | retired | Recently rotated; kept alive for grace-period verification         |
 *
 * ### Legal transitions
 *
 * | From   | To     | Trigger                                |
 * |--------|--------|----------------------------------------|
 * | active | retired| Key rotation (new key generated)        |
 * | retired| —      | Pruned after grace + clock-skew window |
 *
 * ## KEK lifecycle
 *
 * | State   | Meaning                                                              |
 * |---------|----------------------------------------------------------------------|
 * | retired | Registered but not yet activated (initial state for new versions)    |
 * | active  | Currently active encryption key                                      |
 *
 * ### Legal transitions
 *
 * | From    | To     | Trigger                                    |
 * |---------|--------|--------------------------------------------|
 * | retired | active | Dual-control approval met; activateVersion |
 * | active  | retired| Superseded by a newer version              |
 *
 * ## Design
 *
 *  - `retired → active` for KEKs requires dual-control approval (two distinct
 *    approvers), enforced by `KekManager.activateVersion()`.
 *  - `active → retired` for KEKs happens when a newer version is activated.
 *  - `retired → (deleted/zeroized)` is not a state transition in the matrix
 *    because zeroization wipes key material without changing the logical state;
 *    the key remains `retired` but its material is zeroed.
 *
 * ## Security / correctness assumptions
 *
 *  - Transitions are enforced **in-memory** by the manager classes.  For
 *    multi-replica deployments, persist metadata in a database and distribute
 *    key material via a secrets manager.
 *  - The matrix is pure / side-effect-free.  Failed transitions return a
 *    structured error; no partial state is written.
 */

import { TransitionMatrix } from '../../lib/stateTransition.js'

// ── Signing key types ───────────────────────────────────────────────────────

/** Canonical signing key states. */
export type SigningKeyState = 'active' | 'retired'

/** Legal transitions for signing keys. */
export const SIGNING_KEY_TRANSITIONS = new TransitionMatrix<SigningKeyState>([
  { from: 'active', to: 'retired', action: 'rotate' },
  // 'retired' is terminal — pruning deletes the key entry.
])

/**
 * Validate whether a signing key state transition is legal.
 */
export function isValidSigningKeyTransition(
  from: SigningKeyState,
  to: SigningKeyState,
): boolean {
  return SIGNING_KEY_TRANSITIONS.isValid(from, to)
}

/**
 * Attempt a signing key state transition.
 */
export function trySigningKeyTransition(
  from: SigningKeyState,
  to: SigningKeyState,
) {
  return SIGNING_KEY_TRANSITIONS.tryTransition(from, to)
}

// ── KEK types ───────────────────────────────────────────────────────────────

/** Canonical KEK states. */
export type KekLifecycleState = 'active' | 'retired'

/** Legal transitions for KEK versions. */
export const KEK_TRANSITIONS = new TransitionMatrix<KekLifecycleState>([
  { from: 'retired', to: 'active', action: 'activate' },
  { from: 'active', to: 'retired', action: 'supersede' },
])

/**
 * Validate whether a KEK state transition is legal.
 */
export function isValidKekTransition(
  from: KekLifecycleState,
  to: KekLifecycleState,
): boolean {
  return KEK_TRANSITIONS.isValid(from, to)
}

/**
 * Attempt a KEK state transition.
 */
export function tryKekTransition(
  from: KekLifecycleState,
  to: KekLifecycleState,
) {
  return KEK_TRANSITIONS.tryTransition(from, to)
}
