import { randomBytes } from 'crypto'
import { MOCK_USERS } from '../../middleware/auth.js'
import { AuditLogService, AuditAction, auditLogService } from '../audit/index.js'
import type {
  ImpersonationToken,
  IssueImpersonationTokenRequest,
  IssueImpersonationTokenResponse,
} from './types.js'

export type { ImpersonationToken, IssueImpersonationTokenRequest, IssueImpersonationTokenResponse }

/** Default TTL: 15 minutes. Hard cap: 1 hour. */
const DEFAULT_TTL_SECONDS = 900
const MAX_TTL_SECONDS = 3600

/**
 * In-memory store for active impersonation tokens.
 * Replace with a DB-backed store (with TTL index) in production.
 */
const tokenStore = new Map<string, ImpersonationToken>()

export class ImpersonationService {
  private auditLog: AuditLogService

  constructor(auditLog: AuditLogService) {
    this.auditLog = auditLog
  }

  /**
   * Issue a short-lived impersonation token.
   *
   * Rules enforced:
   * - Caller must be admin (enforced at route level via middleware).
   * - Target user must exist.
   * - Nested impersonation is forbidden (checked by the route handler).
   * - `reason` is mandatory and non-empty.
   * - TTL is capped at MAX_TTL_SECONDS.
   */
  issueToken(
    adminId: string,
    adminEmail: string,
    request: IssueImpersonationTokenRequest,
    ipAddress?: string,
  ): IssueImpersonationTokenResponse {
    const { targetUserId, reason, ttlSeconds } = request

    if (!reason || reason.trim().length === 0) {
      void this.auditLog.logAction({
        actorId: adminId,
        actorEmail: adminEmail,
        action: AuditAction.ISSUE_IMPERSONATION_TOKEN,
        resourceType: 'user',
        resourceId: targetUserId,
        details: { reason },
        status: 'failure',
        errorMessage: 'reason is required',
        ipAddress,
      })
      throw new Error('reason is required and must not be empty')
    }

    const target = MOCK_USERS[targetUserId]
    if (!target) {
      void this.auditLog.logAction({
        actorId: adminId,
        actorEmail: adminEmail,
        action: AuditAction.ISSUE_IMPERSONATION_TOKEN,
        resourceType: 'user',
        resourceId: targetUserId,
        details: { reason },
        status: 'failure',
        errorMessage: 'target user not found',
        ipAddress,
      })
      throw new Error(`User not found: ${targetUserId}`)
    }

    const ttl = Math.min(ttlSeconds ?? DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttl * 1000)
    const tokenId = randomBytes(32).toString('hex')

    const record: ImpersonationToken = {
      tokenId,
      issuedBy: adminId,
      issuedByEmail: adminEmail,
      targetUserId,
      targetUserEmail: target.email,
      reason: reason.trim(),
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revoked: false,
    }

    tokenStore.set(tokenId, record)

    void this.auditLog.logAction({
      actorId: adminId,
      actorEmail: adminEmail,
      action: AuditAction.ISSUE_IMPERSONATION_TOKEN,
      resourceType: 'user',
      resourceId: targetUserId,
      details: {
        targetUserEmail: target.email,
        tokenId,
        reason: reason.trim(),
        ttlSeconds: ttl,
        expiresAt: expiresAt.toISOString(),
      },
      status: 'success',
      ipAddress,
    })

    return { tokenId, targetUserId, targetUserEmail: target.email, expiresAt: expiresAt.toISOString(), ttlSeconds: ttl }
  }

  /**
   * Revoke an impersonation token before it expires.
   */
  revokeToken(
    adminId: string,
    adminEmail: string,
    tokenId: string,
    ipAddress?: string,
  ): void {
    const record = tokenStore.get(tokenId)

    if (!record) {
      throw new Error(`Token not found: ${tokenId}`)
    }

    if (record.revoked) {
      throw new Error(`Token already revoked: ${tokenId}`)
    }

    record.revoked = true
    record.revokedAt = new Date().toISOString()
    record.revokedBy = adminId

    void this.auditLog.logAction({
      actorId: adminId,
      actorEmail: adminEmail,
      action: AuditAction.REVOKE_IMPERSONATION_TOKEN,
      resourceType: 'user',
      resourceId: record.targetUserId,
      details: {
        targetUserEmail: record.targetUserEmail,
        tokenId,
        originalIssuedBy: record.issuedBy,
      },
      status: 'success',
      ipAddress,
    })
  }

  /**
   * Validate a token and return the record it represents.
   * Returns null if the token is missing, expired, or revoked.
   */
  validateToken(tokenId: string): ImpersonationToken | null {
    const record = tokenStore.get(tokenId)
    if (!record) return null
    if (record.revoked) return null
    if (new Date() > new Date(record.expiresAt)) return null
    return record
  }

  /** For testing only — clears all stored tokens. */
  _reset(): void {
    tokenStore.clear()
  }
}

/** Singleton instance shared across the app. */
export const impersonationService = new ImpersonationService(auditLogService)
