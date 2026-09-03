import type { Pool, PoolClient } from 'pg'
import type { Queryable } from './queryable.js'

/**
 * A single committed Horizon transition record.
 *
 * Every field is persisted so the record is complete and reviewable without
 * re-querying Horizon (issue #1266 — events and audit parity).
 */
export interface HorizonEventRecord {
  /** Database sequence id (assigned by the store). */
  id?: number | string
  /** Stream name, e.g. `bond_creation`. */
  streamName: string
  /** Horizon operation id — correlation identifier between chain and DB. */
  eventId: string
  /** Monotonic ordering key for the stream. */
  pagingToken: string
  /** Ledger sequence (chain version) when parseable. */
  ledgerSeq: number | null
  /** Event discriminator, e.g. `create_bond`. */
  eventType: string
  /** Complete, validated event payload. */
  payload: Record<string, unknown>
  /** Deterministic hash of the identity state produced by this event. */
  stateHash: string | null
  createdAt?: Date
}

export interface HorizonEventRecordInput {
  streamName: string
  eventId: string
  pagingToken: string
  ledgerSeq?: number | null
  eventType: string
  payload: Record<string, unknown>
  stateHash?: string | null
}

/** Options for listing ledger records. */
export interface HorizonEventListOptions {
  /** Return at most this many records. */
  limit?: number
  /** Only return records with paging_token > this value (ordered resume). */
  afterPagingToken?: string
}

/**
 * Deterministic canonical JSON encoding of an event payload.
 *
 * Keys are sorted recursively so two payloads that are semantically equal
 * (regardless of insertion order or JSON whitespace) always produce the same
 * string. This is the request fingerprint used to decide whether a replayed
 * Horizon operation id carries the *same* logical operation or a materially
 * different one (issue #1261).
 */
export function canonicalEventPayload(payload: unknown): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonicalize)
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) {
        out[key] = canonicalize(record[key])
      }
      return out
    }
    return value
  }
  return JSON.stringify(canonicalize(payload))
}

/**
 * Raised when a Horizon operation id is replayed with a payload that is
 * materially different from the one already committed for that id.
 *
 * Horizon operation ids are globally unique per chain event, so a committed
 * (stream_name, event_id) row must always describe the same logical
 * operation. Reuse of the key for a different operation is rejected
 * deterministically before any state mutation — the second operation is
 * never applied and the state recorded for the first is never touched.
 */
export class HorizonEventConflictError extends Error {
  public readonly code = 'EVENT_ID_CONFLICT'
  public readonly streamName: string
  public readonly eventId: string

  constructor(params: {
    streamName: string
    eventId: string
    message: string
  }) {
    super(params.message)
    this.name = 'HorizonEventConflictError'
    this.streamName = params.streamName
    this.eventId = params.eventId
  }
}

/** Result of atomically claiming a ledger slot for an operation id. */
export type HorizonEventClaimOutcome = 'inserted' | 'duplicate'

/**
 * Repository over the `horizon_events` table.
 *
 * The ledger is append-only in practice: `record()` is an idempotent
 * INSERT ... ON CONFLICT DO NOTHING keyed on (stream_name, event_id), so
 * at-least-once replays of the same Horizon operation never duplicate rows.
 * `claim()` is the stricter variant used by the ingestion boundary: it
 * reserves the operation id inside the caller's transaction and reports
 * whether the slot was freshly inserted or already committed, rejecting
 * conflicting reuse deterministically (see `claim`).
 *
 * A `PoolClient` may be passed to `record()`/`claim()` so the ledger write
 * happens in the same transaction as the state mutation and cursor
 * checkpoint — a rolled-back transition leaves no record behind (no partial
 * state).
 */
export class HorizonEventLedger {
  private readonly db: Queryable

  constructor(db: Pool | PoolClient | Queryable) {
    // Pool/PoolClient satisfy Queryable's `query(text, params)` shape; the
    // narrowed interface keeps overload resolution simple at call sites.
    this.db = db as Queryable
  }

  /**
   * Persist a committed transition record inside the caller's transaction
   * (pass `client`) or standalone (omit `client`).
   *
   * Idempotent: if a record for (streamName, eventId) already exists the
   * insert is a no-op and `false` is returned — the caller must not treat a
   * replayed event as a new committed transition.
   *
   * @returns `true` when a new record was inserted, `false` when the event
   *          had already been recorded.
   */
  async record(input: HorizonEventRecordInput, client?: PoolClient): Promise<boolean> {
    if (!input.streamName?.trim() || !input.eventId?.trim()) {
      throw new Error('HorizonEventLedger.record requires streamName and eventId')
    }
    if (!/^\d+$/.test(input.pagingToken) && input.pagingToken !== 'now') {
      throw new Error(
        `Invalid paging_token: ${input.pagingToken}. Expected numeric string or 'now'.`
      )
    }

    const db = client ?? this.db
    const result = await db.query(
      `INSERT INTO horizon_events
         (stream_name, event_id, paging_token, ledger_seq, event_type, payload, state_hash)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (stream_name, event_id) DO NOTHING`,
      [
        input.streamName,
        input.eventId,
        input.pagingToken,
        input.ledgerSeq ?? null,
        input.eventType,
        JSON.stringify(input.payload),
        input.stateHash ?? null,
      ]
    )
    // `result` may be undefined for mock/doubled query implementations; treat
    // that as "row inserted" (the call succeeded) rather than throwing.
    return (result?.rowCount ?? 0) > 0 || result === undefined
  }

  /**
   * Claim the ledger slot for `(streamName, eventId)` inside the caller's
   * transaction.
   *
   * The UNIQUE (stream_name, event_id) index makes this the concurrency-safe
   * gate for ingestion: at most one transaction can insert the row, so two
   * overlapping deliveries of the same Horizon operation can never both be
   * treated as first processing.
   *
   * Outcomes (all inside the caller's transaction — rollback undoes the
   * claim):
   *
   *  - `inserted`  — this transaction won the slot; the caller must apply the
   *                  business effect and commit.
   *  - `duplicate` — a committed record already exists for this operation id
   *                  with an identical payload. The caller must treat the
   *                  event as already handled: no business effect may be
   *                  applied a second time.
   *
   * @throws `HorizonEventConflictError` when a committed record exists for the
   *         same operation id but with a materially different payload — the
   *         deterministic conflicting-reuse rejection. The second operation is
   *         never applied and the first record is left untouched.
   */
  async claim(
    input: HorizonEventRecordInput,
    client?: PoolClient,
  ): Promise<HorizonEventClaimOutcome> {
    if (!input.streamName?.trim() || !input.eventId?.trim()) {
      throw new Error('HorizonEventLedger.claim requires streamName and eventId')
    }
    if (!/^\d+$/.test(input.pagingToken) && input.pagingToken !== 'now') {
      throw new Error(
        `Invalid paging_token: ${input.pagingToken}. Expected numeric string or 'now'.`
      )
    }

    const db = client ?? this.db

    // 1. Committed record present → decide duplicate vs conflict without
    //    touching the write path. This is also the deterministic decision for
    //    sequential replays (the overwhelmingly common at-least-once case).
    const existing = await this.findByStreamAndEvent(input.streamName, input.eventId, db)
    if (existing !== null) {
      return this.compareCommitted(input, existing)
    }

    // 2. No committed record → attempt the INSERT. Under the UNIQUE index this
    //    is the critical section for concurrent first deliveries: exactly one
    //    transaction succeeds (rowCount 1); any other transaction's INSERT is
    //    a no-op (rowCount 0) and must then defer to the winner's row.
    const result = await db.query(
      `INSERT INTO horizon_events
         (stream_name, event_id, paging_token, ledger_seq, event_type, payload, state_hash)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (stream_name, event_id) DO NOTHING`,
      [
        input.streamName,
        input.eventId,
        input.pagingToken,
        input.ledgerSeq ?? null,
        input.eventType,
        JSON.stringify(input.payload),
        input.stateHash ?? null,
      ]
    )
    // Doubles may resolve `undefined` (treated as success, mirroring record())
    // or omit `rowCount`; only an explicit rowCount of 0 means the INSERT was
    // skipped because a concurrent transaction won the slot.
    const rowCount = (result as { rowCount?: number } | undefined)?.rowCount
    if (rowCount === undefined || rowCount > 0) {
      return 'inserted'
    }

    // 3. A concurrent transaction inserted the row between our read and write:
    //    re-read the winner's record and decide duplicate vs conflict.
    const winner = await this.findByStreamAndEvent(input.streamName, input.eventId, db)
    if (winner === null) {
      // The winning transaction rolled back; our INSERT was skipped against a
      // row that no longer exists. Treating the event as inserted keeps
      // at-least-once semantics correct — the caller's transaction re-applies.
      return 'inserted'
    }
    return this.compareCommitted(input, winner)
  }

  /**
   * Deterministic duplicate-vs-conflict decision against a committed record.
   *
   * Returns `'duplicate'` when the incoming payload is identical to the
   * committed one; throws `HorizonEventConflictError` when the same request
   * key is reused for a materially different operation. Never writes.
   */
  compareCommitted(
    input: HorizonEventRecordInput,
    committed: HorizonEventRecord,
  ): HorizonEventClaimOutcome {
    const incomingFingerprint = canonicalEventPayload(input.payload)
    const existingFingerprint = canonicalEventPayload(committed.payload)
    if (incomingFingerprint === existingFingerprint) {
      return 'duplicate'
    }

    throw new HorizonEventConflictError({
      streamName: input.streamName,
      eventId: input.eventId,
      message:
        `Horizon operation ${input.eventId} on stream ${input.streamName} is already committed ` +
        `with a different payload. Reusing the operation id for a materially different ` +
        `operation is rejected; the committed record and its state were left untouched.`,
    })
  }

  /** Look up a single record by its correlation identifier. */
  async findByStreamAndEvent(
    streamName: string,
    eventId: string,
    db?: Queryable
  ): Promise<HorizonEventRecord | null> {
    const source = db ?? this.db
    const result = await source.query<Record<string, unknown>>(
      `SELECT id, stream_name, event_id, paging_token, ledger_seq, event_type, payload, state_hash, created_at
         FROM horizon_events
        WHERE stream_name = $1 AND event_id = $2
        LIMIT 1`,
      [streamName, eventId]
    )
    // Doubles may resolve `undefined` for query results; treat as "no row".
    const rows = (result as { rows?: Record<string, unknown>[] } | undefined)?.rows ?? []
    return rows.length ? this.map(rows[0]) : null
  }

  /**
   * List committed records for a stream in documented ordering
   * (ascending paging_token, then insertion order).
   */
  async list(
    streamName: string,
    options: HorizonEventListOptions = {}
  ): Promise<HorizonEventRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000)
    const params: unknown[] = [streamName]
    let cursorClause = ''
    if (options.afterPagingToken) {
      params.push(options.afterPagingToken)
      cursorClause = 'AND paging_token > $2'
    }
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, stream_name, event_id, paging_token, ledger_seq, event_type, payload, state_hash, created_at
         FROM horizon_events
        WHERE stream_name = $1 ${cursorClause}
        ORDER BY paging_token ASC, id ASC
        LIMIT ${limit}`,
      params
    )
    return rows.map((row) => this.map(row))
  }

  /** Total committed records (optionally for one stream). */
  async count(streamName?: string): Promise<number> {
    const params: unknown[] = []
    let where = ''
    if (streamName) {
      params.push(streamName)
      where = 'WHERE stream_name = $1'
    }
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM horizon_events ${where}`,
      params
    )
    return Number(rows[0]?.count ?? 0)
  }

  private map(row: Record<string, unknown>): HorizonEventRecord {
    return {
      id: row.id as number | string | undefined,
      streamName: row.stream_name as string,
      eventId: row.event_id as string,
      pagingToken: row.paging_token as string,
      ledgerSeq:
        row.ledger_seq === null || row.ledger_seq === undefined
          ? null
          : Number(row.ledger_seq),
      eventType: row.event_type as string,
      payload:
        typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>),
      stateHash: (row.state_hash as string | null) ?? null,
      createdAt: row.created_at ? new Date(row.created_at as string) : undefined,
    }
  }
}
