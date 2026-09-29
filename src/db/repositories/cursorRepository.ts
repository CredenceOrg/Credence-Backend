import { createHash } from 'crypto'

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
 * Options for retry behaviour on transient database failures.
 */
export interface CursorRetryOptions {
  /** Maximum number of attempts (including the first). Defaults to 3. */
  maxAttempts?: number
  /** Base delay in milliseconds between attempts. Defaults to 50. */
  baseDelayMs?: number
  /** Maximum delay in milliseconds between attempts. Defaults to 500. */
  maxDelayMs?: number
}

const DEFAULT_RETRY: Required<CursorRetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 500,
}

/**
 * Repository for the `horizon_cursors` table.
 * Provides durable checkpoint storage for Horizon event streams.
 */
export class CursorRepository {
  constructor(private readonly db: Pool | PoolClient) {}

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

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
   * Determines whether an error is safe to retry.
   * Only transient connection/serialization errors are retried; validation
   * and constraint errors are surfaced immediately to avoid masking bugs.
   */
  private isRetryableError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false
    const code = (err as { code?: string }).code
    if (!code) return false
    // Postgres transient error classes:
    // 40001 serialization_failure, 40P01 deadlock_detected,
    // 08000/08003/08006 connection exceptions, 53300 too_many_connections,
    // 57P03 cannot_connect_now.
    return (
      code === '40001' ||
      code === '40P01' ||
      code === '08000' ||
      code === '08003' ||
      code === '08006' ||
      code === '53300' ||
      code === '57P03'
    )
  }

  /**
   * Runs `fn` with bounded exponential backoff for transient failures.
   * The final error is always rethrown so callers observe the real cause.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    options?: CursorRetryOptions
  ): Promise<T> {
    const { maxAttempts, baseDelayMs, maxDelayMs } = {
      ...DEFAULT_RETRY,
      ...(options ?? {}),
    }
    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastError = err
        if (attempt >= maxAttempts || !this.isRetryableError(err)) {
          throw err
        }
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    // Unreachable, but keeps TypeScript satisfied.
    throw lastError
  }

  /**
   * Validates a stream name. Stream names must be non-empty and reasonably
   * bounded to prevent accidental unbounded keys or injection attempts.
   */
  private assertValidStreamName(streamName: string): void {
    if (typeof streamName !== 'string' || streamName.length === 0) {
      throw new Error('Invalid streamName: must be a non-empty string')
    }
    if (streamName.length > 255) {
      throw new Error('Invalid streamName: exceeds maximum length of 255')
    }
  }

  /**
   * Redacts a paging token for logging so secrets/identifiers are not leaked.
   */
  private redactToken(token: string): string {
    if (token.length <= 4) return '***'
    return `***${token.slice(-4)}`
  }

  /**
   * Stable fingerprint of a stream name for structured logging.
   */
  private streamFingerprint(streamName: string): string {
    return createHash('sha256').update(streamName).digest('hex').slice(0, 12)
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Returns the cursor for the given stream name, or `null` if not found.
   * @param streamName - The unique stream identifier (e.g., 'bond_creation')
   */
  async findByStreamName(streamName: string): Promise<HorizonCursor | null> {
    this.assertValidStreamName(streamName)
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

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Upserts a cursor checkpoint for the given stream.
   * - If the stream already exists, updates paging_token and last_checkpoint.
   * - If it does not exist, inserts a new row.
   * 
   * Security: Validates paging_token format before persisting.
   * 
   * @param input - Stream name and paging token to checkpoint
   * @returns The upserted cursor record
   * @throws Error if paging_token format is invalid
   */
  async upsert(input: UpsertCursorInput): Promise<HorizonCursor> {
    this.assertValidStreamName(input.streamName)
    // Validate paging_token format (Horizon tokens are numeric strings or 'now')
    if (!this.isValidPagingToken(input.pagingToken)) {
      throw new Error(
        `Invalid paging_token format: ${input.pagingToken}. ` +
        `Expected numeric string or 'now'.`
      )
    }

    return this.withRetry(async () => {
      const { rows } = await this.db.query(
        `INSERT INTO horizon_cursors (stream_name, paging_token, last_checkpoint, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (stream_name)
         DO UPDATE SET 
           paging_token = EXCLUDED.paging_token,
           last_checkpoint = NOW(),
           updated_at = NOW()
         RETURNING stream_name, paging_token, last_checkpoint, created_at, updated_at`,
        [input.streamName, input.pagingToken]
      )
      if (!rows.length) {
        throw new Error(
          `Cursor upsert returned no row for stream fingerprint ${this.streamFingerprint(
            input.streamName
          )}`
        )
      }
      return this.map(rows[0])
    })
  }

  /**
   * Deletes the cursor for the given stream name.
   * Returns `true` if a row was deleted, `false` if not found.
   * 
   * @param streamName - The stream identifier to delete
   */
  async delete(streamName: string): Promise<boolean> {
    this.assertValidStreamName(streamName)
    const { rowCount } = await this.db.query(
      `DELETE FROM horizon_cursors WHERE stream_name = $1`,
      [streamName]
    )
    return (rowCount ?? 0) > 0
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Validates paging_token format.
   * Horizon paging tokens are either:
   * - 'now' (special cursor for current time)
   * - Numeric strings (e.g., '12345678901234')
   * 
   * @param token - The paging token to validate
   * @returns true if valid, false otherwise
   */
  private isValidPagingToken(token: string): boolean {
    if (typeof token !== 'string' || token.length === 0) {
      return false
    }
    if (token === 'now') {
      return true
    }
    // Horizon paging tokens are numeric strings
    return /^\d+$/.test(token)
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  /**
   * Calculate cursor lag in seconds for a given stream.
   * Returns the time elapsed since the last checkpoint.
   * 
   * @param streamName - The stream identifier
   * @returns Lag in seconds, or null if cursor not found
   */
  async getCursorLag(streamName: string): Promise<number | null> {
    this.assertValidStreamName(streamName)
    const cursor = await this.findByStreamName(streamName)
    if (!cursor) {
      return null
    }
    const now = new Date()
    const lagMs = now.getTime() - cursor.lastCheckpoint.getTime()
    return Math.floor(lagMs / 1000)
  }
}
