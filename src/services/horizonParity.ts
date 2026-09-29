import { createHash } from 'node:crypto'
import type { HorizonEventRecord } from '../db/repositories/horizonEventRepository.js'

/**
 * Horizon ingestion / reconciliation parity verifier (issue #1266).
 *
 * The parity invariant this module enforces:
 *
 *   For every Horizon event the repository committed, the event record
 *   (versioned, complete, correlation-identified) and the resulting
 *   identity/bond state must agree — deterministically and reviewably.
 *
 * Two independent checks are performed:
 *
 *   1. Record integrity — the recorded `state_hash` must equal the hash
 *      recomputed from the event's own payload.  A mismatch means the
 *      record was tampered with or the payload was mutated after commit.
 *   2. State convergence — folding all committed bond-creation events for
 *      an address in paging-token order must reproduce the address's
 *      current committed state.  A mismatch means either a silent gap
 *      (state changed without a committed event) or a partial write
 *      (event recorded but state never applied).
 *
 * `verifyHorizonParity` is a pure function over the recorded events and the
 * current state, so it can run anywhere (CLI, scheduled job, tests) and
 * always produces the same answer for the same inputs.
 */

/** Deterministic projection of an identity's committed state. */
export interface IdentityStateView {
  address: string
  /** Canonical string amount, e.g. '1000'. */
  bondedAmount: string
  /** Whether a bond start was ever recorded (timestamp itself is non-deterministic). */
  hasBondStart: boolean
  /** Bond duration in seconds, or null. */
  bondDuration: number | null
  active: boolean
}

/** Payload shape recorded for `create_bond` events. */
export interface BondCreationEventPayload {
  identity: { id: string }
  bond: { id: string; address: string; amount: string; duration: string | null }
}

export type HorizonParityFindingKind =
  | 'record_hash_mismatch'
  | 'state_mismatch'
  | 'event_without_state'
  | 'state_without_event'

export interface HorizonParityFinding {
  kind: HorizonParityFindingKind
  address: string
  eventId?: string
  expected?: string
  actual?: string
  detail?: string
}

export interface HorizonParityReport {
  checkedAt: string
  streamName: string
  totalEvents: number
  totalAddresses: number
  matchedAddresses: number
  mismatchedAddresses: number
  findings: HorizonParityFinding[]
  valid: boolean
}

/** Identity state reader — how the verifier reaches the committed state. */
export interface IdentityStateReader {
  get(address: string): Promise<IdentityStateView | null>
}

/**
 * Deterministic SHA-256 over the canonical JSON of an identity state view.
 *
 * Keys are sorted so that the hash is stable regardless of the order fields
 * are serialized, and only deterministic fields are included (never the
 * wall-clock bond start timestamp, which is NOW()-generated).
 */
export function computeStateHash(state: IdentityStateView): string {
  const canonical = JSON.stringify({
    address: state.address,
    bondedAmount: state.bondedAmount,
    hasBondStart: state.hasBondStart,
    bondDuration: state.bondDuration,
    active: state.active,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** Project the identity state a `create_bond` event implies (deterministic). */
export function stateFromBondEvent(
  payload: BondCreationEventPayload
): IdentityStateView {
  const duration = payload.bond.duration
    ? Number.parseInt(payload.bond.duration, 10)
    : null
  return {
    address: payload.bond.address,
    bondedAmount: payload.bond.amount,
    hasBondStart: true,
    bondDuration: Number.isFinite(duration ?? NaN) ? duration : null,
    active: true,
  }
}

/** Best-effort ledger sequence extracted from a Horizon paging token. */
export function extractLedgerSeq(pagingToken: string): number | null {
  const head = pagingToken.split('-')[0]
  const n = Number.parseInt(head, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Fold committed bond-creation events for one address in paging-token
 * order, mirroring the listener's upsert semantics:
 *
 *   - `bonded_amount` and `bond_duration`: last event wins
 *   - `bond_start`: set by the first event, never overwritten
 *   - `active`: true once any bond event committed
 *
 * Duplicate event ids (at-least-once replays) are folded once.
 */
export function applyBondEvents(
  events: HorizonEventRecord[]
): Map<string, IdentityStateView> {
  const byAddress = new Map<string, { last: IdentityStateView; seenEvents: Set<string> }>()
  const ordered = [...events].sort((a, b) => {
    const cmp = a.pagingToken.localeCompare(b.pagingToken, undefined, { numeric: true })
    if (cmp !== 0) return cmp
    return String(a.id ?? '').localeCompare(String(b.id ?? ''))
  })

  for (const event of ordered) {
    if (event.eventType !== 'create_bond') continue
    const payload = event.payload as unknown as BondCreationEventPayload
    const address = payload?.bond?.address
    if (!address) continue

    const bucket = byAddress.get(address) ?? {
      last: stateFromBondEvent(payload),
      seenEvents: new Set<string>(),
    }
    if (bucket.seenEvents.has(event.eventId)) continue
    bucket.seenEvents.add(event.eventId)

    const candidate = stateFromBondEvent(payload)
    // First event wins for bond_start; every event updates amount/duration/active.
    const hasBondStart = bucket.last.hasBondStart || candidate.hasBondStart
    bucket.last = {
      address,
      bondedAmount: candidate.bondedAmount,
      hasBondStart,
      bondDuration: candidate.bondDuration,
      active: true,
    }
    byAddress.set(address, bucket)
  }

  const result = new Map<string, IdentityStateView>()
  for (const [address, bucket] of byAddress) {
    result.set(address, bucket.last)
  }
  return result
}

export interface VerifyParityInput {
  streamName: string
  /** Committed event records for the stream (from the ledger). */
  events: HorizonEventRecord[]
  /** Reader returning the current committed state per address. */
  states: IdentityStateReader
  /** Optional: addresses with committed state to cross-check (silent gaps). */
  knownAddresses?: string[]
}

/**
 * Verify the events/state parity invariant for a stream.
 *
 * Pure and deterministic: given the same ledger records and the same state
 * reader it always produces the same report.
 */
export async function verifyHorizonParity(
  input: VerifyParityInput
): Promise<HorizonParityReport> {
  const findings: HorizonParityFinding[] = []

  // ── 1. Record integrity: recorded state_hash must match the payload ─────
  for (const event of input.events) {
    if (event.eventType !== 'create_bond') continue
    const expectedHash = computeStateHash(
      stateFromBondEvent(event.payload as unknown as BondCreationEventPayload)
    )
    if (event.stateHash !== null && event.stateHash !== expectedHash) {
      findings.push({
        kind: 'record_hash_mismatch',
        address: (event.payload as { bond?: { address?: string } })?.bond?.address ?? 'unknown',
        eventId: event.eventId,
        expected: expectedHash,
        actual: event.stateHash,
        detail: 'Recorded state_hash does not match the event payload; record may have been tampered with.',
      })
    }
  }

  // ── 2. State convergence: folded events must reproduce committed state ───
  const expectedByAddress = applyBondEvents(input.events)

  // event_without_state: an event claims a transition but no state exists.
  for (const [address, expected] of expectedByAddress) {
    const actual = await input.states.get(address)
    if (actual === null || actual === undefined) {
      findings.push({
        kind: 'event_without_state',
        address,
        expected: JSON.stringify(expected),
        detail: 'A committed event exists but the identity has no committed state.',
      })
      continue
    }
    const fields: Array<[string, unknown, unknown]> = [
      ['bondedAmount', expected.bondedAmount, actual.bondedAmount],
      ['hasBondStart', expected.hasBondStart, actual.hasBondStart],
      ['bondDuration', expected.bondDuration, actual.bondDuration],
      ['active', expected.active, actual.active],
    ]
    const mismatches = fields.filter(([, e, a]) => e !== a)
    if (mismatches.length > 0) {
      findings.push({
        kind: 'state_mismatch',
        address,
        expected: JSON.stringify(expected),
        actual: JSON.stringify(actual),
        detail: `Committed state diverges from the event ledger: ${mismatches
          .map(([field, e, a]) => `${field} expected=${JSON.stringify(e)} actual=${JSON.stringify(a)}`)
          .join('; ')}`,
      })
    }
  }

  // state_without_event: committed state with no corresponding event record
  // (silent gap — e.g. state written by an out-of-band path).
  const addressesWithEvents = new Set(expectedByAddress.keys())
  for (const address of input.knownAddresses ?? []) {
    if (addressesWithEvents.has(address)) continue
    const actual = await input.states.get(address)
    if (actual && (actual.active || actual.bondedAmount !== '0')) {
      findings.push({
        kind: 'state_without_event',
        address,
        actual: JSON.stringify(actual),
        detail: 'Committed state exists but no Horizon event record accounts for it (silent gap).',
      })
    }
  }

  const mismatchedAddresses = new Set(
    findings
      .filter((f) => f.kind !== 'record_hash_mismatch')
      .map((f) => f.address)
  ).size

  return {
    checkedAt: new Date().toISOString(),
    streamName: input.streamName,
    totalEvents: input.events.length,
    totalAddresses: expectedByAddress.size,
    matchedAddresses: expectedByAddress.size - mismatchedAddresses,
    mismatchedAddresses,
    findings,
    valid: findings.length === 0,
  }
}

/**
 * Service binding the pure verifier to the `horizon_events` ledger and the
 * `identities` table.  Convenience for scheduled reconciliation runs.
 */
export class HorizonParityService {
  constructor(
    private readonly ledger: {
      list(streamName: string): Promise<HorizonEventRecord[]>
      count(streamName?: string): Promise<number>
    },
    private readonly states: IdentityStateReader,
    private readonly allAddresses?: () => Promise<string[]>
  ) {}

  /**
   * Run parity verification for a stream.
   *
   * @param streamName - Stream to verify, e.g. `bond_creation`.
   * @param knownAddresses - Optional explicit list of addresses to check for
   *                         silent gaps; defaults to `allAddresses()` when
   *                         available.
   */
  async verify(streamName: string, knownAddresses?: string[]): Promise<HorizonParityReport> {
    const [events, addresses] = await Promise.all([
      this.ledger.list(streamName),
      knownAddresses
        ? Promise.resolve(knownAddresses)
        : this.allAddresses
          ? this.allAddresses()
          : Promise.resolve([]),
    ])
    return verifyHorizonParity({ streamName, events, states: this.states, knownAddresses: addresses })
  }

  /** Total committed records for a stream (or across all streams). */
  async count(streamName?: string): Promise<number> {
    return this.ledger.count(streamName)
  }
}
