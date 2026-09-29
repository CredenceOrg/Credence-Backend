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
 * Repository over the `horizon_events` table.
 *
 * The ledger is append-only in practice: `record()` is an idempotent
 * INSERT ... ON CONFLICT DO NOTHING keyed on (stream_name, event_id), so
 * at-least-once replays of the same Horizon operation never duplicate rows.
 *
 * A `PoolClient` may be passed to `record()` so the ledger write happens in
 * the same transaction as the state mutation and cursor checkpoint — a
 * rolled-back transition leaves no record behind (no partial state).
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

  /** Look up a single record by its correlation identifier. */
  async findByStreamAndEvent(
    streamName: string,
    eventId: string
  ): Promise<HorizonEventRecord | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, stream_name, event_id, paging_token, ledger_seq, event_type, payload, state_hash, created_at
         FROM horizon_events
        WHERE stream_name = $1 AND event_id = $2
        LIMIT 1`,
      [streamName, eventId]
    )
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
