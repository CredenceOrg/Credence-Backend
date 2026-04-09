import type { Queryable } from './queryable.js'

export interface IdempotencyRecord {
  key: string
  requestHash: string
  responseCode: number
  responseBody: any
  expiresAt: Date
  createdAt: Date
}

export interface CreateIdempotencyInput {
  key: string
  requestHash: string
  responseCode: number
  responseBody: any
  expiresInSeconds: number
}

export class IdempotencyRepository {
  constructor(private readonly db: Queryable) {}

  async findByKey(key: string): Promise<IdempotencyRecord | null> {
    const result = await this.db.query<any>(
      `
      SELECT key, request_hash, response_code, response_body, expires_at, created_at
      FROM idempotency_keys
      WHERE key = $1 AND expires_at > NOW()
      `,
      [key]
    )

    const row = result.rows[0]
    if (!row) return null

    return {
      key: row.key,
      requestHash: row.request_hash,
      responseCode: row.response_code,
      responseBody: row.response_body,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
    }
  }

  async save(input: CreateIdempotencyInput): Promise<void> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000)

    await this.db.query(
      `
      INSERT INTO idempotency_keys (key, request_hash, response_code, response_body, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (key) DO UPDATE SET
        request_hash  = EXCLUDED.request_hash,
        response_code = EXCLUDED.response_code,
        response_body = EXCLUDED.response_body,
        expires_at    = EXCLUDED.expires_at,
        created_at    = NOW()
      `,
      [
        input.key,
        input.requestHash,
        input.responseCode,
        JSON.stringify(input.responseBody),
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
