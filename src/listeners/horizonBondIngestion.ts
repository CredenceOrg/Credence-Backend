/**
 * @file src/listeners/horizonBondIngestion.ts
 *
 * Deterministic replay/idempotency boundary for Horizon bond-creation
 * ingestion (issue #1261).
 *
 * ## Durable request identity
 *
 * Every chain operation is bound to a durable request key:
 * `(stream_name, operation_id)` where `operation_id` is Horizon's globally
 * unique operation id. The key is committed inside the SAME transaction as
 * the business effect (identity/bond mutation) and the cursor checkpoint, as
 * a row of the versioned `horizon_events` ledger. A ledger row therefore
 * exists if and only if the operation was committed, and it is the durable,
 * reviewable record of that request.
 *
 * ## Correctness invariant
 *
 *   The same logical operation may be retried safely and produces a
 *   deterministic result without applying the underlying business effect
 *   more than once. Reusing an existing request key for a materially
 *   different operation is rejected deterministically. Rejected, stale,
 *   duplicate, or failed operations leave no unauthorized or partially
 *   applied state.
 *
 * ## Deterministic outcomes
 *
 * Processing one event in one transaction yields exactly one of:
 *
 *  - `applied`  — the operation id was not committed before; identity/bond
 *    state was mutated, the ledger record written, and the cursor advanced.
 *  - `replayed` — the operation id was already committed with the identical
 *    payload (a verified duplicate / at-least-once redelivery). No state
 *    write is issued; the cursor is advanced only when the delivery is ahead
 *    of the checkpoint so a replay storm can never stall the stream.
 *  - throws `HorizonEventStaleError` — a *new* operation id arrived with a
 *    paging token at or behind the stream's checkpoint. This signals a
 *    reorg/gap anomaly or a rolled-back cursor and is rejected
 *    deterministically WITHOUT any mutation, so authoritative state is never
 *    regressed by out-of-order ingestion.
 *  - throws `HorizonEventConflictError` — the same operation id was replayed
 *    with a materially different payload. Rejected deterministically; the
 *    committed record and its state are left untouched.
 *
 * ## Concurrency
 *
 * Two overlapping deliveries of the same operation cannot both apply: the
 * ledger's UNIQUE (stream_name, event_id) index makes the `claim()` INSERT
 * the single critical section, and every decision is made inside the
 * transaction that would carry the effect. The loser of the race observes a
 * committed row and returns `replayed`.
 *
 * ## Timeout / provider failure semantics
 *
 * If the transaction rolls back (provider fault, constraint violation,
 * crash before COMMIT) the ledger row and cursor move roll back with it, so
 * a retry of the same event takes the `applied` path exactly once. If the
 * transaction committed but the response was lost, the retry observes the
 * committed row and takes the `replayed` path — the effect is never applied
 * twice, and the caller never needs to know which branch ran to be safe.
 *
 * This module is intentionally free of module-level side effects (no
 * network clients, no metric registries) so it can be driven directly at the
 * database boundary in tests.
 */
import type { Pool, PoolClient } from 'pg'
import {
  HorizonEventLedger,
  HorizonEventConflictError,
  type HorizonEventRecordInput,
} from '../db/repositories/horizonEventRepository.js'
import {
  upsertIdentity,
  upsertBond,
  upsertCursorMonotonic,
} from '../services/identityService.js'
import {
  computeStateHash,
  stateFromBondEvent,
  extractLedgerSeq,
  type BondCreationEventPayload,
} from '../services/horizonParity.js'

/** Stream name for bond-creation ingestion. */
export const BOND_CREATION_STREAM = 'bond_creation'

/** One validated Horizon bond-creation operation ready for ingestion. */
export interface BondCreationIngestionEvent {
  /** Horizon operation id — the durable request key. */
  operationId: string
  /** Horizon paging token — the monotonic ordering key for the stream. */
  pagingToken: string
  identity: { id: string }
  bond: {
    id: string
    address: string
    amount: string
    duration: string | null
  }
}

/** Deterministic outcome of ingesting one event. */
export type BondCreationIngestionOutcome = 'applied' | 'replayed'

/**
 * Raised when an operation id that was never committed arrives with a paging
 * token at or behind the stream checkpoint. Rejected without any write so a
 * reorg/gap anomaly can never regress authoritative state or double-apply a
 * business effect.
 */
export class HorizonEventStaleError extends Error {
  public readonly code = 'STALE_INGESTION_EVENT'
  public readonly streamName: string
  public readonly eventId: string
  public readonly pagingToken: string
  public readonly checkpointToken: string

  constructor(params: {
    streamName: string
    eventId: string
    pagingToken: string
    checkpointToken: string
  }) {
    super(
      `Horizon ingestion rejected stale event: operation ${params.eventId} ` +
        `(paging token ${params.pagingToken}) is at or behind the checkpoint ` +
        `${params.checkpointToken} for stream ${params.streamName} but has never ` +
        `been committed. This signals a reorg/gap anomaly or a rolled-back ` +
        `cursor; reconcile before re-ingesting.`,
    )
    this.name = 'HorizonEventStaleError'
    this.streamName = params.streamName
    this.eventId = params.eventId
    this.pagingToken = params.pagingToken
    this.checkpointToken = params.checkpointToken
  }
}

/** Inputs for one ingestion call. */
export interface ApplyBondCreationEventInput {
  pool: Pool
  event: BondCreationIngestionEvent
  /** Overridable ledger (defaults to one bound to `pool`). */
  ledger?: HorizonEventLedger
  /** Overridable stream name (defaults to `bond_creation`). */
  streamName?: string
}

/**
 * Apply one Horizon bond-creation operation to the local store with the
 * replay/idempotency invariants documented at the top of this module.
 *
 * The identity/bond mutation, the durable ledger record, and the cursor
 * checkpoint are ONE transaction: either all commit or none do.
 *
 * @returns `'applied'` when the business effect was committed by this call,
 *          `'replayed'` when the operation was already committed.
 * @throws {HorizonEventStaleError} for an uncommitted operation at or behind
 *         the checkpoint (no writes).
 * @throws {HorizonEventConflictError} for conflicting reuse of an operation
 *         id with a different payload (no writes).
 */
export async function applyBondCreationEvent(
  input: ApplyBondCreationEventInput,
): Promise<BondCreationIngestionOutcome> {
  const streamName = input.streamName ?? BOND_CREATION_STREAM
  const { event } = input
  const ledger = input.ledger ?? new HorizonEventLedger(input.pool)

  const client: PoolClient = await input.pool.connect()
  try {
    await client.query('BEGIN')

    const checkpoint = await readCheckpointToken(client, streamName)
    const outcome = await ingestInsideTransaction({
      client,
      ledger,
      streamName,
      event,
      checkpoint,
    })

    await client.query('COMMIT')
    return outcome
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** Read the current checkpoint token for the stream (may be null). */
async function readCheckpointToken(
  client: PoolClient,
  streamName: string,
): Promise<string | null> {
  const result = await client.query<{ paging_token: string }>(
    `SELECT paging_token
       FROM horizon_cursors
      WHERE stream_name = $1
      LIMIT 1`,
    [streamName],
  )
  // Doubles may resolve `undefined` for query results; treat as "no checkpoint".
  const rows = (result as { rows?: { paging_token: string }[] } | undefined)?.rows ?? []
  const token = rows[0]?.paging_token ?? null
  // `'now'` means "no durable checkpoint yet"; treat it as no checkpoint.
  return token !== null && token !== 'now' ? token : null
}

/** True when `candidate` is a numerically larger paging token than `base`. */
function isStrictlyAfter(candidate: string, base: string): boolean {
  if (candidate === base) return false
  // Both values are validated numeric strings (or `'now'`, which we treat as
  // "no checkpoint"); numeric compare avoids lexical pitfalls of varying width.
  return (
    candidate !== 'now' && base !== 'now' && BigInt(candidate) > BigInt(base)
  )
}

async function ingestInsideTransaction(params: {
  client: PoolClient
  ledger: HorizonEventLedger
  streamName: string
  event: BondCreationIngestionEvent
  checkpoint: string | null
}): Promise<BondCreationIngestionOutcome> {
  const { client, ledger, streamName, event, checkpoint } = params

  // ── Stale/anomaly gate ────────────────────────────────────────────────────
  // An operation that has never been committed cannot arrive at or behind the
  // checkpoint on a correct stream. Reject it before any write so reordered
  // or reorg'd delivery can never regress authoritative state.
  const ledgerInput = buildLedgerInput(streamName, event)
  if (
    checkpoint !== null &&
    !isStrictlyAfter(event.pagingToken, checkpoint)
  ) {
    const committed = await ledger.findByStreamAndEvent(
      streamName,
      event.operationId,
      client,
    )
    if (committed === null) {
      throw new HorizonEventStaleError({
        streamName,
        eventId: event.operationId,
        pagingToken: event.pagingToken,
        checkpointToken: checkpoint,
      })
    }
    // Committed operation re-delivered from an earlier cursor. The payload
    // comparison is still authoritative: an identical payload is a verified
    // duplicate (no writes, no cursor move — the checkpoint is already at or
    // beyond it), while a materially different payload is a conflicting reuse
    // and is rejected deterministically.
    ledger.compareCommitted(ledgerInput, committed)
    return 'replayed'
  }

  // ── Atomic claim ──────────────────────────────────────────────────────────
  // The INSERT ... ON CONFLICT DO NOTHING under the UNIQUE (stream, event_id)
  // index is the critical section: exactly one concurrent delivery wins.
  const claim = await ledger.claim(ledgerInput, client)

  if (claim === 'duplicate') {
    // A concurrent owner (or a previous commit whose response was lost)
    // already applied this operation. Deterministic no-op — the ledger
    // comparison inside claim() already verified the payload matches and
    // rejected conflicting reuse. Advance the checkpoint only if this
    // delivery is ahead of it, so handled events never stall the stream.
    await advanceCheckpoint(client, streamName, event.pagingToken)
    return 'replayed'
  }

  // ── Fresh claim: apply the business effect ────────────────────────────────
  await upsertIdentity(event.identity, client)
  await upsertBond(event.bond, client)
  await advanceCheckpoint(client, streamName, event.pagingToken)

  return 'applied'
}

/** Checkpoint the stream only when the new token is strictly ahead. */
async function advanceCheckpoint(
  client: PoolClient,
  streamName: string,
  pagingToken: string,
): Promise<void> {
  await upsertCursorMonotonic({ streamName, pagingToken }, client)
}

/** Build the versioned ledger record for a bond-creation event. */
export function buildLedgerInput(
  streamName: string,
  event: BondCreationIngestionEvent,
): HorizonEventRecordInput {
  // The recorded payload is the parsed business payload ({identity, bond}) —
  // the envelope fields (operationId, pagingToken) are already carried by
  // dedicated columns, and parity reconciliation recomputes state hashes from
  // this exact shape.
  const payload: BondCreationEventPayload = {
    identity: event.identity,
    bond: event.bond,
  }
  return {
    streamName,
    eventId: event.operationId,
    pagingToken: event.pagingToken,
    ledgerSeq: extractLedgerSeq(event.pagingToken),
    eventType: 'create_bond',
    payload: payload as unknown as Record<string, unknown>,
    stateHash: computeStateHash(stateFromBondEvent(payload)),
  }
}

export {
  HorizonEventLedger,
  HorizonEventConflictError,
}
