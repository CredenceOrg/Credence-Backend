import { z } from 'zod'
import { UserRole } from '../middleware/auth.js'
import type { MemberRole } from '../services/members/types.js'

/**
 * Request body schema for assigning a role to a user
 * POST /api/admin/roles/assign
 */
export const assignRoleBodySchema = z
  .object({
    userId: z.string().min(1, 'userId is required'),
    role: z.nativeEnum(UserRole, {
      errorMap: () => ({ message: 'role must be a valid UserRole' }),
    }),
  })
  .strict()

/**
 * Request body schema for revoking an API key
 * POST /api/admin/keys/revoke
 */
export const revokeApiKeyBodySchema = z
  .object({
    userId: z.string().min(1, 'userId is required'),
    apiKey: z.string().min(1, 'apiKey is required'),
  })
  .strict()

/**
 * Request body schema for issuing an impersonation token
 * POST /api/admin/impersonate
 */
export const issueImpersonationTokenBodySchema = z
  .object({
    targetUserId: z.string().min(1, 'targetUserId is required'),
    reason: z.string().min(1, 'reason is required'),
    ttlSeconds: z
      .number()
      .int()
      .min(1, 'ttlSeconds must be at least 1')
      .max(3600, 'ttlSeconds must not exceed 3600 (1 hour)')
      .optional(),
  })
  .strict()

/**
 * Request body schema for inviting a member to an organization
 * POST /api/admin/orgs/:orgId/members
 */
export const inviteMemberBodySchema = z
  .object({
    userId: z.string().min(1, 'userId is required'),
    email: z.string().email('email must be a valid email address'),
    role: z
      .enum(['owner', 'admin', 'member'] as const)
      .optional(),
  })
  .strict()

/**
 * Request body schema for updating a member's role
 * PATCH /api/admin/orgs/:orgId/members/:memberId
 */
export const updateMemberRoleBodySchema = z
  .object({
    role: z.enum(['owner', 'admin', 'member'] as const, {
      errorMap: () => ({ message: 'role must be one of: owner, admin, member' }),
    }),
  })
  .strict()

export type AssignRoleBody = z.infer<typeof assignRoleBodySchema>
export type RevokeApiKeyBody = z.infer<typeof revokeApiKeyBodySchema>
export type IssueImpersonationTokenBody = z.infer<typeof issueImpersonationTokenBodySchema>
export type InviteMemberBody = z.infer<typeof inviteMemberBodySchema>
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleBodySchema>
