import type { Queryable } from './queryable.js'

export interface IdempotencyRecord {
  key: string
  actorId: string
  requestHash: string
  responseCode: number
  responseBody: any
  ttlSeconds: number
  expiresAt: Date
  createdAt: Date
}

export interface CreateIdempotencyInput {
  key: string
  actorId: string
  requestHash: string
  responseCode: number
  responseBody: any
  /** Time-to-live in seconds; persisted to the `ttl_seconds` column. */
  ttlSeconds: number
  /**
   * Optional override for the absolute-expiry computation. Defaults to
   * `ttlSeconds` when omitted. Both fields express the same TTL; this is kept
   * for backward compatibility with callers that set it explicitly.
   */
  expiresInSeconds?: number
}

export class IdempotencyRepository {
  constructor(private readonly db: Queryable) {}

  async findByKey(key: string): Promise<IdempotencyRecord | null> {
    const result = await this.db.query<any>(
      `
      SELECT key, actor_id, request_hash, response_code, response_body, ttl_seconds, expires_at, created_at
      FROM idempotency_keys
      WHERE key = $1 AND expires_at > NOW()
      `,
      [key]
    )

    const row = result.rows[0]
    if (!row) return null

    return {
      key: row.key,
      actorId: row.actor_id,
      requestHash: row.request_hash,
      responseCode: row.response_code,
      responseBody: typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body,
      ttlSeconds: row.ttl_seconds,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
    }
  }

  async save(input: CreateIdempotencyInput): Promise<void> {
    const ttlSeconds = input.expiresInSeconds ?? input.ttlSeconds
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

    await this.db.query(
      `
      INSERT INTO idempotency_keys (key, actor_id, request_hash, response_code, response_body, ttl_seconds, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (key) DO UPDATE SET
        actor_id     = EXCLUDED.actor_id,
        request_hash = EXCLUDED.request_hash,
        response_code = EXCLUDED.response_code,
        response_body = EXCLUDED.response_body,
        ttl_seconds  = EXCLUDED.ttl_seconds,
        expires_at   = EXCLUDED.expires_at,
        created_at   = NOW()
      `,
      [
        input.key,
        input.actorId,
        input.requestHash,
        input.responseCode,
        JSON.stringify(input.responseBody),
        input.ttlSeconds,
        expiresAt,
      ]
    )
  }

  async deleteExpired(): Promise<number> {
    const result = await this.db.query(
      `
      DELETE FROM idempotency_keys
      WHERE expires_at <= NOW()
      `
    )
    return result.rowCount ?? 0
  }
}
