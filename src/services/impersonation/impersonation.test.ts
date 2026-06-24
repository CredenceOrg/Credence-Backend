/**
 * Unit tests for ImpersonationService.
 *
 * Strategy
 * ────────
 * • The service is constructed with a **stub repository** (in-memory Map) and a
 *   **spy AuditLogService** so that no database or HTTP connection is required.
 * • `vi.useFakeTimers()` controls `Date.now()` / `new Date()` so that token
 *   expiry can be tested without real sleeps.
 * • `_reset()` on the service clears the in-memory store between tests.
 *
 * Coverage targets
 * ─────────────────
 * issueToken  – success, TTL default, TTL clamp, whitespace-only reason,
 *               empty reason, unknown target, ipAddress passthrough
 * validateToken – valid, expired (fake clock), revoked
 * revokeToken – success, unknown token, double-revoke, ipAddress passthrough
 * cleanupExpiredTokens – delegates to repo.deleteExpired()
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ImpersonationService } from './index.js'
import { AuditLogService, AuditAction } from '../audit/index.js'
import type { ImpersonationToken } from './types.js'
import type { ImpersonationTokenRepository } from '../../repositories/impersonationTokenRepository.js'

// ---------------------------------------------------------------------------
// In-memory stub repository
// ---------------------------------------------------------------------------

/**
 * A fully in-memory stub that satisfies the ImpersonationTokenRepository
 * interface without touching a real database.
 */
class StubTokenRepository {
  private store = new Map<string, ImpersonationToken>()

  async create(token: ImpersonationToken): Promise<void> {
    this.store.set(token.tokenId, { ...token })
  }

  async findValid(tokenId: string): Promise<ImpersonationToken | null> {
    const record = this.store.get(tokenId)
    if (!record) return null
    if (record.revoked) return null
    if (new Date() > new Date(record.expiresAt)) return null
    return { ...record }
  }

  async findById(tokenId: string): Promise<ImpersonationToken | null> {
    const record = this.store.get(tokenId)
    return record ? { ...record } : null
  }

  async revoke(tokenId: string, revokedBy: string): Promise<boolean> {
    const record = this.store.get(tokenId)
    if (!record) return false
    record.revoked = true
    record.revokedAt = new Date().toISOString()
    record.revokedBy = revokedBy
    return true
  }

  async deleteExpired(): Promise<number> {
    const now = new Date()
    let count = 0
    for (const [id, token] of this.store) {
      if (new Date(token.expiresAt) <= now) {
        this.store.delete(id)
        count++
      }
    }
    return count
  }

  async _reset(): Promise<void> {
    this.store.clear()
  }
}

// ---------------------------------------------------------------------------
// Test constants  (matches MOCK_USERS in src/middleware/auth.ts)
// ---------------------------------------------------------------------------

const ADMIN_ID = 'admin-user-1'
const ADMIN_EMAIL = 'admin@credence.org'
const TENANT_ID = 'tenant-admin'

/** Valid target — exists in MOCK_USERS */
const TARGET_ID = 'verifier-user-1'
const TARGET_EMAIL = 'verifier@credence.org'

/** Non-existent target — NOT in MOCK_USERS */
const UNKNOWN_TARGET = 'ghost-user-999'

const REASON = 'Investigating support ticket #42'
const IP = '10.0.0.1'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a service wired to a fresh stub repo and a spy audit service. */
function buildService() {
  const repo = new StubTokenRepository() as unknown as ImpersonationTokenRepository
  const audit = new AuditLogService()
  const logSpy = vi.spyOn(audit, 'logAction')
  const svc = new ImpersonationService(audit, repo)
  return { svc, repo: repo as unknown as StubTokenRepository, audit, logSpy }
}

/** Issue a token with sensible defaults, returning the full response. */
async function issueDefault(
  svc: ImpersonationService,
  overrides: Partial<{
    targetUserId: string
    reason: string
    ttlSeconds: number
    ip: string
  }> = {},
) {
  return svc.issueToken(
    ADMIN_ID,
    ADMIN_EMAIL,
    TENANT_ID,
    {
      targetUserId: overrides.targetUserId ?? TARGET_ID,
      reason: overrides.reason ?? REASON,
      ttlSeconds: overrides.ttlSeconds,
    },
    overrides.ip ?? IP,
  )
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ImpersonationService', () => {
  let svc: ImpersonationService
  let repo: StubTokenRepository
  let logSpy: MockInstance

  beforeEach(() => {
    vi.useFakeTimers()
    const built = buildService()
    svc = built.svc
    repo = built.repo
    logSpy = built.logSpy
  })

  afterEach(async () => {
    vi.useRealTimers()
    await svc._reset()
  })

  // ─── issueToken ────────────────────────────────────────────────────────────

  describe('issueToken()', () => {
    it('returns a token with correct fields', async () => {
      const result = await issueDefault(svc)

      expect(result.tokenId).toMatch(/^[0-9a-f]{64}$/)
      expect(result.targetUserId).toBe(TARGET_ID)
      expect(result.targetUserEmail).toBe(TARGET_EMAIL)
      expect(result.ttlSeconds).toBe(900) // default TTL
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now())
    })

    it('applies the default TTL of 900 s when ttlSeconds is omitted', async () => {
      const before = Date.now()
      const result = await issueDefault(svc)
      const expectedExpiry = before + 900 * 1000

      expect(new Date(result.expiresAt).getTime()).toBeCloseTo(expectedExpiry, -3)
    })

    it('passes through a custom TTL below the cap', async () => {
      const result = await issueDefault(svc, { ttlSeconds: 600 })
      expect(result.ttlSeconds).toBe(600)
    })

    it('clamps TTL to MAX_TTL_SECONDS (3600) when exceeded', async () => {
      const result = await issueDefault(svc, { ttlSeconds: 9999 })
      expect(result.ttlSeconds).toBe(3600)

      const expectedExpiry = Date.now() + 3600 * 1000
      expect(new Date(result.expiresAt).getTime()).toBeCloseTo(expectedExpiry, -3)
    })

    it('trims leading/trailing whitespace from reason before storing', async () => {
      const result = await issueDefault(svc, { reason: '  trimmed  ' })
      expect(result.tokenId).toBeDefined()

      // Confirm the stored record has the trimmed reason
      const record = await repo.findById(result.tokenId)
      expect(record?.reason).toBe('trimmed')
    })

    it('emits a success audit record with correct fields', async () => {
      const result = await issueDefault(svc, { ip: '192.168.1.1' })



      const calls = logSpy.mock.calls
      const successCall = calls.find((args) => args[7] === 'success')
      expect(successCall).toBeDefined()

      // Verify key audit fields
      expect(successCall![0]).toBe(TENANT_ID)
      expect(successCall![1]).toBe(ADMIN_ID)
      expect(successCall![2]).toBe(ADMIN_EMAIL)
      expect(successCall![3]).toBe(AuditAction.ISSUE_IMPERSONATION_TOKEN)
      expect(successCall![4]).toBe(TARGET_ID)
      expect(successCall![5]).toBe(TARGET_EMAIL)
      expect(successCall![6]).toMatchObject({ tokenId: result.tokenId, reason: REASON })
      expect(successCall![9]).toBe('192.168.1.1') // ipAddress
    })

    it('throws and emits a FAILURE audit log when reason is empty', async () => {
      await expect(issueDefault(svc, { reason: '' })).rejects.toThrow(
        'reason is required and must not be empty',
      )



      const failureCall = logSpy.mock.calls.find((args) => args[7] === 'failure')
      expect(failureCall).toBeDefined()
      expect(failureCall![3]).toBe(AuditAction.ISSUE_IMPERSONATION_TOKEN)
      expect(failureCall![8]).toMatch(/reason is required/)
    })

    it('throws and emits a FAILURE audit log when reason is whitespace-only', async () => {
      await expect(issueDefault(svc, { reason: '   ' })).rejects.toThrow(
        'reason is required and must not be empty',
      )



      const failureCall = logSpy.mock.calls.find((args) => args[7] === 'failure')
      expect(failureCall).toBeDefined()
    })

    it('throws and emits a failure audit log when targetUserId is unknown', async () => {
      await expect(
        issueDefault(svc, { targetUserId: UNKNOWN_TARGET }),
      ).rejects.toThrow(`User not found: ${UNKNOWN_TARGET}`)



      const failureCall = logSpy.mock.calls.find((args) => args[7] === 'failure')
      expect(failureCall).toBeDefined()
      expect(failureCall![4]).toBe(UNKNOWN_TARGET)
      expect(failureCall![8]).toMatch(/target user not found/)
    })

    it('passes ipAddress through to the audit log on failure', async () => {
      await expect(issueDefault(svc, { reason: '', ip: '9.9.9.9' })).rejects.toThrow()



      const failureCall = logSpy.mock.calls.find((args) => args[7] === 'failure')
      expect(failureCall![9]).toBe('9.9.9.9')
    })
  })

  // ─── validateToken ─────────────────────────────────────────────────────────

  describe('validateToken()', () => {
    it('returns the token record while the token is valid', async () => {
      const { tokenId } = await issueDefault(svc)
      const result = await svc.validateToken(tokenId)

      expect(result).not.toBeNull()
      expect(result!.tokenId).toBe(tokenId)
      expect(result!.targetUserId).toBe(TARGET_ID)
    })

    it('returns null for a completely unknown token ID', async () => {
      const result = await svc.validateToken('00000000000000000000000000000000')
      expect(result).toBeNull()
    })

    it('returns null when the token has been explicitly revoked', async () => {
      const { tokenId } = await issueDefault(svc)
      await svc.revokeToken(ADMIN_ID, ADMIN_EMAIL, TENANT_ID, tokenId)

      const result = await svc.validateToken(tokenId)
      expect(result).toBeNull()
    })

    it('returns null after the token has expired (fake clock)', async () => {
      const { tokenId } = await issueDefault(svc, { ttlSeconds: 100 })

      // Advance the fake clock past the expiry
      vi.advanceTimersByTime(101 * 1000)

      const result = await svc.validateToken(tokenId)
      expect(result).toBeNull()
    })

    it('returns the record for a token that is at exactly expiry minus 1 ms', async () => {
      const { tokenId } = await issueDefault(svc, { ttlSeconds: 100 })

      // Advance to 1 ms before expiry
      vi.advanceTimersByTime(99_999)

      const result = await svc.validateToken(tokenId)
      expect(result).not.toBeNull()
    })
  })

  // ─── revokeToken ───────────────────────────────────────────────────────────

  describe('revokeToken()', () => {
    it('revokes a valid token and subsequent validation returns null', async () => {
      const { tokenId } = await issueDefault(svc)
      await svc.revokeToken(ADMIN_ID, ADMIN_EMAIL, TENANT_ID, tokenId, IP)

      expect(await svc.validateToken(tokenId)).toBeNull()
    })

    it('emits a success audit record on revoke with correct audit fields', async () => {
      const { tokenId } = await issueDefault(svc)
      logSpy.mockClear()

      await svc.revokeToken(ADMIN_ID, ADMIN_EMAIL, TENANT_ID, tokenId, '5.5.5.5')


      const successCall = logSpy.mock.calls.find((args) => args[7] === 'success')
      expect(successCall).toBeDefined()
      expect(successCall![3]).toBe(AuditAction.REVOKE_IMPERSONATION_TOKEN)
      expect(successCall![4]).toBe(TARGET_ID)
      expect(successCall![5]).toBe(TARGET_EMAIL)
      expect(successCall![6]).toMatchObject({ tokenId, originalIssuedBy: ADMIN_ID })
      expect(successCall![9]).toBe('5.5.5.5')
    })

    it('throws "Token not found" for an unknown tokenId', async () => {
      await expect(
        svc.revokeToken(ADMIN_ID, ADMIN_EMAIL, TENANT_ID, 'no-such-token'),
      ).rejects.toThrow('Token not found: no-such-token')
    })

    it('throws "Token already revoked" on a double-revoke attempt', async () => {
      const { tokenId } = await issueDefault(svc)
      await svc.revokeToken(ADMIN_ID, ADMIN_EMAIL, TENANT_ID, tokenId)

      await expect(
        svc.revokeToken(ADMIN_ID, ADMIN_EMAIL, TENANT_ID, tokenId),
      ).rejects.toThrow(`Token already revoked: ${tokenId}`)
    })

    it('passes ipAddress through on revoke success audit', async () => {
      const { tokenId } = await issueDefault(svc)
      logSpy.mockClear()

      await svc.revokeToken(ADMIN_ID, ADMIN_EMAIL, TENANT_ID, tokenId, '8.8.8.8')


      const call = logSpy.mock.calls[0]
      expect(call[9]).toBe('8.8.8.8')
    })
  })

  // ─── cleanupExpiredTokens ──────────────────────────────────────────────────

  describe('cleanupExpiredTokens()', () => {
    it('removes expired tokens and returns the count', async () => {
      // Issue two tokens with short TTLs and one with a long TTL
      const { tokenId: t1 } = await issueDefault(svc, { ttlSeconds: 30 })
      const { tokenId: t2 } = await issueDefault(svc, { ttlSeconds: 30 })
      const { tokenId: t3 } = await issueDefault(svc, { ttlSeconds: 3600 })

      // Advance clock past the short TTLs
      vi.advanceTimersByTime(31 * 1000)

      const removed = await svc.cleanupExpiredTokens()
      expect(removed).toBe(2)

      // Expired tokens should be gone
      expect(await repo.findById(t1)).toBeNull()
      expect(await repo.findById(t2)).toBeNull()

      // Long-TTL token should still exist
      expect(await repo.findById(t3)).not.toBeNull()
    })

    it('returns 0 when there are no expired tokens', async () => {
      await issueDefault(svc, { ttlSeconds: 900 })
      const removed = await svc.cleanupExpiredTokens()
      expect(removed).toBe(0)
    })
  })

  // ─── _reset ────────────────────────────────────────────────────────────────

  describe('_reset()', () => {
    it('clears all tokens from the store', async () => {
      const { tokenId } = await issueDefault(svc)
      await svc._reset()

      expect(await svc.validateToken(tokenId)).toBeNull()
    })
  })
})
