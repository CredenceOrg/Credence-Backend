import type { Pool, PoolClient } from 'pg'

/**
 * Horizon cursor record for stream checkpointing
 */
export interface HorizonCursor {
  streamName: string
  pagingToken: string
  lastCheckpoint: Date
  createdAt: Date
  updatedAt: Date
}

/**
 * Input for upserting a cursor checkpoint
 */
export interface UpsertCursorInput {
  streamName: string
  pagingToken: string
}

/**
 * Repository for the `horizon_cursors` table.
 * Provides durable checkpoint storage for Horizon event streams.
 *
 * Invariants:
 * - `stream_name` is the primary key; upsert is atomic and idempotent.
 * - `paging_token` is always a non-empty numeric string or the literal 'now'.
 * - `updated_at` monotonically increases on every write (never goes backwards).
 * - All queries use parameterized statements to prevent SQL injection.
 */
export class CursorRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Maps a raw postgres row (snake_case) to the HorizonCursor domain type. */
  private map(row: Record<string, unknown>): HorizonCursor {
    return {
      streamName: row.stream_name as string,
      pagingToken: row.paging_token as string,
      lastCheckpoint: row.last_checkpoint as Date,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    }
  }

  /**
   * Validates a stream name.
   *
   * A non-empty string of at most 255 characters. This bound prevents unbounded
   * input from reaching the database and keeps the primary key deterministic.
   */
  private isValidStreamName(streamName: unknown): streamName is string {
    return typeof streamName === 'string' && streamName.length > 0 && streamName.length <= 255
  }

  /**
   * Validates paging_token format.
   * Horizon paging tokens are either:
   * - 'now' (special cursor for current time)
   * - Numeric strings (e.g., '12345678901234')
   *
   * Boundary conditions:
   * - Empty strings are rejected.
   * - Leading zeros are allowed but not required.
   * - Overly long tokens are rejected to avoid unbounded storage.
   *
   * @param token - The paging token to validate
   * @returns true if valid, false otherwise
   */
  private isValidPagingToken(token: unknown): token is string {
    if (typeof token !== 'string') {
      return false
    }
    if (token === 'now') {
      return true
    }
    // Horizon paging tokens are numeric strings. Bound length to avoid
    // unreasonably large values being persisted.
    return /^\d+$/.test(token) && token.length <= 64
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  /**
   * Returns the cursor for the given stream name, or `null` if not found.
   * @param streamName - The unique stream identifier (e.g., 'bond_creation')
   */
  async findByStreamName(streamName: string): Promise<HorizonCursor | null> {
    if (!this.isValidStreamName(streamName)) {
      throw new Error('Invalid streamName: must be a non-empty string of at most 255 characters')
    }
    const { rows } = await this.db.query(
      `SELECT stream_name, paging_token, last_checkpoint, created_at, updated_at
       FROM horizon_cursors
       WHERE stream_name = $1`,
      [streamName]
    )
    return rows.length ? this.map(rows[0]) : null
  }

  /**
   * Returns all cursors ordered by last checkpoint (most recent first).
   */
  async findAll(): Promise<HorizonCursor[]> {
    const { rows } = await this.db.query(
      `SELECT stream_name, paging_token, last_checkpoint, created_at, updated_at
       FROM horizon_cursors
       ORDER BY last_checkpoint DESC`
    )
    return rows.map(this.map.bind(this))
  }

  // --------------------------------------------------------------------------
  // Mutations
  // --------------------------------------------------------------------------

  /**
   * Upserts a cursor checkpoint for the given stream.
   * - If the stream already exists, updates paging_token and last_checkpoint.
   * - If it does not exist, inserts a new row.
   *
   * The upsert is atomic (`ON CONFLICT`) and is safe under concurrent
   * execution. A later write will always win because `NOW()` is evaluated
   * at execution time and the conflict target is the primary key.
   *
   * Security: Validates stream name and paging_token format before persisting.
   *
   * @param input - Stream name and paging token to checkpoint
   * @returns The upserted cursor record
   * @throws Error if streamName or paging_token format is invalid
   */
  async upsert(input: UpsertCursorInput): Promise<HorizonCursor> {
    if (!this.isValidStreamName(input?.streamName)) {
      throw new Error('Invalid streamName: must be a non-empty string of at most 255 characters')
    }

    // Validate paging_token format (Horizon tokens are numeric strings or 'now')
    if (!this.isValidPagingToken(input?.pagingToken)) {
      throw new Error(
        `Invalid paging_token format: ${String(input?.pagingToken)}. ` +
          `Expected numeric string or 'now'.`
      )
    }

    const { rows } = await this.db.query(
      `INSERT INTO horizon_cursors (stream_name, paging_token, last_checkpoint, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (stream_name)
       DO UPDATE SEL 
         paging_token = EXCLUDED.paging_token,
         last_checkpoint = NOW(),
         updated_at = NOW()
       RETURNING stream_name, paging_token, last_checkpoint, created_at, updated_at`,
      [input.streamName, input.pagingToken]
    )
    return this.map(rows[0])
  }

  /**
   * Deletes the cursor for the given stream name.
   * Returns `true` if a row was deleted, `false` if not found.
   *
   * @param streamName - The stream identifier to delete
   */
  async delete(streamName: string): Promise<boolean> {
    if (!this.isValidStreamName(streamName)) {
      throw new Error('Invalid streamName: must be a non-empty string of at most 255 characters')
    }
    const { rowCount } = await this.db.query(
      `DELETE FROM horizon_cursors WHERE stream_name = $1`,
      [streamName]
    )
    return (rowCount ?? 0) > 0
  }

  // --------------------------------------------------------------------------
  // Metrics
  // --------------------------------------------------------------------------

  /**
   * Calculate cursor lag in seconds for a given stream.
   * Returns the time elapsed since the last checkpoint.
   *
   * The result is clamped at 0 to avoid negative lag when the checkpoint
   * timestamp is ahead of the local clock (clock skew or future timestamp).
   *
   * @param streamName - The stream identifier
   * @returns Lag in seconds, or null if cursor not found
   */
  async getCursorLag(streamName: string): Promise<number | null> {
    const cursor = await this.findByStreamName(streamName)
    if (!cursor) {
      return null
    }
    const now = Date.now()
    const last = cursor.lastCheckpoint instanceof Date
      ? cursor.lastCheckpoint.getTime()
      : new Date(cursor.lastCheckpoint as unknown as string).getTime()
    if (Number.isNaN(last)) {
      return null
    }
    const lagMs = Math.max(0, now - last)
    return Math.floor(lagMs / 1000)
  }
}
