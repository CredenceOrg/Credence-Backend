import { BaseRepository } from '../db/repositories/baseRepository.js'
import type { Queryable } from '../db/repositories/queryable.js'
import type { ImpersonationToken } from '../services/impersonation/types.js'

export class ImpersonationTokenRepository extends BaseRepository {
  constructor(db: Queryable) {
    // Optionally skip tenant tests for this table if it's purely global administrative
    super(db, { skipTenantCheck: true })
  }

  async create(token: ImpersonationToken): Promise<void> {
    await this.db.query(
      `INSERT INTO impersonation_tokens (
        token_id,
        issued_by,
        issued_by_email,
        target_user_id,
        target_user_email,
        reason,
        issued_at,
        expires_at,
        revoked,
        revoked_at,
        revoked_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        token.tokenId,
        token.issuedBy,
        token.issuedByEmail,
        token.targetUserId,
        token.targetUserEmail,
        token.reason,
        token.issuedAt,
        token.expiresAt,
        token.revoked,
        token.revokedAt ?? null,
        token.revokedBy ?? null,
      ]
    )
  }

  async findValid(tokenId: string): Promise<ImpersonationToken | null> {
    const res = await this.db.query<any>(
      `SELECT
        token_id,
        issued_by,
        issued_by_email,
        target_user_id,
        target_user_email,
        reason,
        issued_at,
        expires_at,
        revoked,
        revoked_at,
        revoked_by
       FROM impersonation_tokens
       WHERE token_id = $1 AND revoked = false AND expires_at > current_timestamp`,
      [tokenId]
    )
    if (res.rowCount === 0) return null

    const row = res.rows[0]
    return {
      tokenId: row.token_id,
      issuedBy: row.issued_by,
      issuedByEmail: row.issued_by_email,
      targetUserId: row.target_user_id,
      targetUserEmail: row.target_user_email,
      reason: row.reason,
      issuedAt: new Date(row.issued_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      revoked: row.revoked,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
      revokedBy: row.revoked_by ?? undefined,
    }
  }
  
  async findById(tokenId: string): Promise<ImpersonationToken | null> {
    const res = await this.db.query<any>(
      `SELECT
        token_id,
        issued_by,
        issued_by_email,
        target_user_id,
        target_user_email,
        reason,
        issued_at,
        expires_at,
        revoked,
        revoked_at,
        revoked_by
       FROM impersonation_tokens
       WHERE token_id = $1`,
      [tokenId]
    )
    if (res.rowCount === 0) return null

    const row = res.rows[0]
    return {
      tokenId: row.token_id,
      issuedBy: row.issued_by,
      issuedByEmail: row.issued_by_email,
      targetUserId: row.target_user_id,
      targetUserEmail: row.target_user_email,
      reason: row.reason,
      issuedAt: new Date(row.issued_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      revoked: row.revoked,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
      revokedBy: row.revoked_by ?? undefined,
    }
  }

  async revoke(tokenId: string, revokedBy: string): Promise<boolean> {
    const res = await this.db.query(
      `UPDATE impersonation_tokens
       SET revoked = true, revoked_at = current_timestamp, revoked_by = $2
       WHERE token_id = $1 AND revoked = false
       RETURNING token_id`,
      [tokenId, revokedBy]
    )
    return res.rowCount !== null && res.rowCount > 0
  }

  async deleteExpired(): Promise<number> {
    const res = await this.db.query(
      `DELETE FROM impersonation_tokens WHERE expires_at <= current_timestamp`
    )
    return res.rowCount ?? 0
  }

  // Testing purposes
  async _reset(): Promise<void> {
    await this.db.query(`TRUNCATE TABLE impersonation_tokens`)
  }
}
