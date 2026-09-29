/**
 * @file src/lib/stateTransition.ts
 *
 * Generic, reusable state-transition matrix for enforcing lifecycle invariants.
 *
 * ## Design
 *
 * A `TransitionMatrix<S>` encodes the set of legal `(from, to)` transitions for a
 * finite state machine.  It provides:
 *
 *  - `isValid(from, to)`   — O(n) lookup for whether the transition is legal.
 *  - `tryTransition(from, to)` — returns a structured `TransitionResult` that
 *    callers can inspect or propagate as an error response.
 *  - `getAllowedTargets(from)` — returns all legal target states from a given state.
 *  - `describe()` — human-readable representation of the full matrix (useful for
 *    documentation, tests, and structured audit logs).
 *
 * ## Invariants
 *
 *  1. Every entry in the matrix is `(from, to)` where both are members of `S`.
 *  2. No duplicate `(from, to)` pairs are stored.
 *  3. `tryTransition` returns a deterministic result: valid transitions always
 *     succeed; invalid ones always fail with a descriptive error.
 *  4. Failed / rejected transitions leave no partial state — the matrix is
 *     pure / side-effect-free.
 *
 * ## Security / correctness assumptions
 *
 *  - This utility validates the **logical** transition only.  Callers must still
 *    perform authentication, authorization, and persistence.  The matrix is a
 *    guardrail, not a replacement for optimistic concurrency control.
 *  - Terminal states (states with no outgoing transitions) are legal: they simply
 *    have an empty target set.
 *
 * ## Migration / rollback
 *
 *  The matrix is additive: existing callers are unaffected.  Introducing
 *  transition enforcement is a backward-compatible change because it only
 *  rejects transitions that were previously undefined behavior.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** A single legal transition descriptor. */
export interface Transition<S extends string> {
  from: S
  to: S
  /** Human-readable action label (e.g. "mark_under_review", "settle"). */
  action?: string
}

/** Structured result from `tryTransition`. */
export interface TransitionResult<S extends string> {
  /** `true` when the transition is legal. */
  success: boolean
  from: S
  to: S
  /** Present only when `success === false`. */
  error?: string
}

// ── TransitionMatrix ────────────────────────────────────────────────────────

/**
 * Immutable, read-only transition matrix for a finite state machine.
 *
 * @example
 * ```ts
 * const DISPUTE_MATRIX = new TransitionMatrix([
 *   { from: 'pending', to: 'under_review', action: 'mark_under_review' },
 *   { from: 'pending', to: 'resolved',     action: 'resolve' },
 *   { from: 'under_review', to: 'resolved', action: 'resolve' },
 * ])
 *
 * DISPUTE_MATRIX.isValid('pending', 'resolved')  // → true
 * DISPUTE_MATRIX.isValid('resolved', 'pending')  // → false
 * ```
 */
export class TransitionMatrix<S extends string> {
  /** Adjacency list: `from → Set<to>`. */
  private readonly edges: Map<S, Set<S>>

  /** Flat set of all legal `(from|→|to)` composite keys for O(1) dedup check. */
  private readonly edgeKeys: Set<string>

  /** All unique states that appear as sources or targets. */
  private readonly allStates: Set<S>

  /** Original transition descriptors (for `describe()`). */
  private readonly transitions: ReadonlyArray<Transition<S>>

  constructor(transitions: ReadonlyArray<Transition<S>>) {
    this.transitions = transitions
    this.edges = new Map()
    this.edgeKeys = new Set()
    this.allStates = new Set()

    for (const t of transitions) {
      this.allStates.add(t.from)
      this.allStates.add(t.to)

      const key = `${t.from}|→|${t.to}`
      if (this.edgeKeys.has(key)) {
        throw new Error(
          `Duplicate transition: "${t.from}" → "${t.to}" appears more than once`,
        )
      }
      this.edgeKeys.add(key)

      let targets = this.edges.get(t.from)
      if (!targets) {
        targets = new Set()
        this.edges.set(t.from, targets)
      }
      targets.add(t.to)
    }
  }

  /** Returns `true` if the `(from, to)` transition is legal. */
  isValid(from: S, to: S): boolean {
    return this.edges.get(from)?.has(to) ?? false
  }

  /**
   * Attempt a state transition, returning a structured result instead of
   * throwing.  Ideal for use at API entry points.
   */
  tryTransition(from: S, to: S): TransitionResult<S> {
    if (this.isValid(from, to)) {
      return { success: true, from, to }
    }
    return {
      success: false,
      from,
      to,
      error: `Invalid transition from "${from}" to "${to}"`,
    }
  }

  /** Returns all legal target states from `from`.  Empty array for terminal states. */
  getAllowedTargets(from: S): S[] {
    const targets = this.edges.get(from)
    return targets ? [...targets] : []
  }

  /** Returns all states that have no outgoing transitions (terminal states). */
  getTerminalStates(): S[] {
    return [...this.allStates].filter(
      (s) => !this.edges.has(s) || this.edges.get(s)!.size === 0,
    )
  }

  /** Returns all unique states in the matrix. */
  getAllStates(): S[] {
    return [...this.allStates]
  }

  /**
   * Human-readable representation of the full transition matrix.
   * Useful for documentation, audit logs, and tests.
   */
  describe(): string {
    const lines: string[] = []
    for (const t of this.transitions) {
      const suffix = t.action ? ` [${t.action}]` : ''
      lines.push(`  ${t.from} → ${t.to}${suffix}`)
    }
    return `TransitionMatrix (${this.transitions.length} transitions):\n${lines.join('\n')}`
  }

  /** Number of legal transitions. */
  get size(): number {
    return this.transitions.length
  }
}
