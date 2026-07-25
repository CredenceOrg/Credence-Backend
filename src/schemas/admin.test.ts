import { describe, it, expect } from 'vitest'
import {
  assignRoleBodySchema,
  revokeApiKeyBodySchema,
  issueImpersonationTokenBodySchema,
  inviteMemberBodySchema,
  updateMemberRoleBodySchema,
} from './admin.js'

describe('Admin Schemas - Strict Validation', () => {
  describe('assignRoleBodySchema', () => {
    it('should accept valid assign role request', () => {
      const result = assignRoleBodySchema.safeParse({
        userId: 'user-123',
        role: 'admin',
      })
      expect(result.success).toBe(true)
    })

    it('should reject unknown fields', () => {
      const result = assignRoleBodySchema.safeParse({
        userId: 'user-123',
        role: 'admin',
        maliciousField: 'attack',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Unrecognized key')
      }
    })

    it('should reject missing required fields', () => {
      const result = assignRoleBodySchema.safeParse({
        userId: 'user-123',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('revokeApiKeyBodySchema', () => {
    it('should accept valid revoke API key request', () => {
      const result = revokeApiKeyBodySchema.safeParse({
        userId: 'user-123',
        apiKey: 'key-123',
      })
      expect(result.success).toBe(true)
    })

    it('should reject unknown fields', () => {
      const result = revokeApiKeyBodySchema.safeParse({
        userId: 'user-123',
        apiKey: 'key-123',
        maliciousField: 'attack',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Unrecognized key')
      }
    })

    it('should reject missing required fields', () => {
      const result = revokeApiKeyBodySchema.safeParse({
        userId: 'user-123',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('issueImpersonationTokenBodySchema', () => {
    it('should accept valid impersonate request', () => {
      const result = issueImpersonationTokenBodySchema.safeParse({
        targetUserId: 'user-123',
        reason: 'debug issue',
      })
      expect(result.success).toBe(true)
    })

    it('should accept valid impersonate request with TTL', () => {
      const result = issueImpersonationTokenBodySchema.safeParse({
        targetUserId: 'user-123',
        reason: 'debug issue',
        ttlSeconds: 600,
      })
      expect(result.success).toBe(true)
    })

    it('should reject unknown fields', () => {
      const result = issueImpersonationTokenBodySchema.safeParse({
        targetUserId: 'user-123',
        reason: 'debug issue',
        maliciousField: 'attack',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Unrecognized key')
      }
    })

    it('should reject TTL exceeding maximum', () => {
      const result = issueImpersonationTokenBodySchema.safeParse({
        targetUserId: 'user-123',
        reason: 'debug issue',
        ttlSeconds: 4000,
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing required fields', () => {
      const result = issueImpersonationTokenBodySchema.safeParse({
        targetUserId: 'user-123',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('inviteMemberBodySchema', () => {
    it('should accept valid invite member request', () => {
      const result = inviteMemberBodySchema.safeParse({
        userId: 'user-123',
        email: 'user@example.com',
      })
      expect(result.success).toBe(true)
    })

    it('should accept valid invite member request with role', () => {
      const result = inviteMemberBodySchema.safeParse({
        userId: 'user-123',
        email: 'user@example.com',
        role: 'admin',
      })
      expect(result.success).toBe(true)
    })

    it('should reject unknown fields', () => {
      const result = inviteMemberBodySchema.safeParse({
        userId: 'user-123',
        email: 'user@example.com',
        maliciousField: 'attack',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Unrecognized key')
      }
    })

    it('should reject invalid email', () => {
      const result = inviteMemberBodySchema.safeParse({
        userId: 'user-123',
        email: 'not-an-email',
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing required fields', () => {
      const result = inviteMemberBodySchema.safeParse({
        userId: 'user-123',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('updateMemberRoleBodySchema', () => {
    it('should accept valid update member role request', () => {
      const result = updateMemberRoleBodySchema.safeParse({
        role: 'admin',
      })
      expect(result.success).toBe(true)
    })

    it('should reject unknown fields', () => {
      const result = updateMemberRoleBodySchema.safeParse({
        role: 'admin',
        maliciousField: 'attack',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Unrecognized key')
      }
    })

    it('should reject invalid role', () => {
      const result = updateMemberRoleBodySchema.safeParse({
        role: 'invalid-role',
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing required fields', () => {
      const result = updateMemberRoleBodySchema.safeParse({})
      expect(result.success).toBe(false)
    })
  })
})
