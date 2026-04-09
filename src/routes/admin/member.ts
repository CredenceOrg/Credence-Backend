/**
 * @file src/routes/admin/members.ts
 *
 * Admin endpoints for organisation member management.
 *
 * All routes require admin authentication (requireUserAuth + requireAdminRole).
 *
 * Endpoints
 * ─────────
 *  GET    /api/admin/orgs/:orgId/members            List active members (paginated)
 *  POST   /api/admin/orgs/:orgId/members            Invite a new member
 *  PATCH  /api/admin/orgs/:orgId/members/:memberId  Update member role
 *  DELETE /api/admin/orgs/:orgId/members/:memberId  Soft-delete a member
 *  POST   /api/admin/orgs/:orgId/members/:memberId/restore  Restore a deleted member
 */

import { Router, Request, Response } from 'express'
import {
  AuthenticatedRequest,
  requireUserAuth,
  requireAdminRole,
} from '../../middleware/auth.js'
import {
  parsePaginationParams,
  buildPaginationMeta,
  PaginationValidationError,
} from '../../lib/pagination.js'
import { pool } from '../../db/pool.js'
import { auditLogService } from '../../services/audit/index.js'
import type { MemberRole } from '../../services/members/types.js'
import { MemberService } from '../../services/members/factory.ts'
import { MemberRepository } from '../../repositories/member.repository.ts'

const VALID_MEMBER_ROLES: MemberRole[] = ['owner', 'admin', 'member']

function createMemberService(): MemberService {
  return new MemberService(new MemberRepository(pool), auditLogService)
}

export function createMembersRouter(): Router {
  const router = Router() 
  const memberService = createMemberService()

  // ── GET /api/orgs/:orgId/members ────────────────────────────────────
  /**
   * List organisation members with optional pagination.
   *
   * Query parameters:
   * - limit: results per page (default 50, max 100)
   * - offset: pagination offset (default 0)
   * - includeDeleted: 'true' to include soft-deleted members (default false)
   *
   * @returns {ListMembersResponse}
   *
   * @example
   * ```bash
   * curl -X GET 'http://localhost:3000/api/admin/orgs/org-1/members?limit=20' \
   *   -H "Authorization: Bearer admin-key-12345"
   * ```
   */
  router.get('/', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const { orgId } = req.params

      let pagination
      try {
        pagination = parsePaginationParams(req.query as Record<string, unknown>, { defaultLimit: 50 })
      } catch (err) {
        if (err instanceof PaginationValidationError) {
          res.status(400).json({
            error: 'InvalidRequest',
            message: 'Invalid pagination parameters',
            details: err.details,
          })
          return
        }
        throw err
      }

      const includeDeleted = req.query.includeDeleted === 'true'
      const { page, limit, offset } = pagination

      const result = await memberService.listMembers(
        authReq.user!.id,
        authReq.user!.email,
        orgId,
        { page, limit, offset },
        includeDeleted,
      )

      res.status(200).json({
        success: true,
        data: {
          ...result,
          ...buildPaginationMeta(result.total, page, limit),
        },
      })
    } catch (err) {
      res.status(500).json({
        error: 'InternalError',
        message: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  })

  // ── POST /api/orgs/:orgId/members ───────────────────────────────────
  /**
   * Invite a user to the organisation.
   *
   * Returns 409 if the user is already an active member.
   * After a soft-delete, the same user CAN be re-invited (fresh row).
   *
   * @body {string} userId   - ID of the user to invite
   * @body {string} email    - Email of the user
   * @body {string} [role]   - 'owner' | 'admin' | 'member' (default: 'member')
   *
   * @example
   * ```bash
   * curl -X POST http://localhost:3000/api/admin/orgs/org-1/members \
   *   -H "Authorization: Bearer admin-key-12345" \
   *   -H "Content-Type: application/json" \
   *   -d '{"userId":"user-99","email":"alice@example.com","role":"member"}'
   * ```
   */
  router.post('/', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const { orgId } = req.params
      const { userId, email, role } = req.body as {
        userId?: string
        email?: string
        role?: string
      }

      if (!userId || !email) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: 'Missing required fields: userId, email',
        })
        return
      }

      if (role && !VALID_MEMBER_ROLES.includes(role as MemberRole)) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `Invalid role. Must be one of: ${VALID_MEMBER_ROLES.join(', ')}`,
        })
        return
      }

      const result = await memberService.inviteMember(
        authReq.user!.id,
        authReq.user!.email,
        { orgId, userId, email, role: (role as MemberRole) ?? 'member' },
      )

      res.status(201).json({ success: true, data: result.member, message: result.message })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      const isConflict = message.includes('already active')
      res.status(isConflict ? 409 : 400).json({
        error: isConflict ? 'Conflict' : 'BadRequest',
        message,
      })
    }
  })

  // ── PATCH /api/orgs/:orgId/members/:memberId ────────────────────────
  /**
   * Update a member's role.
   *
   * @body {string} role - New role: 'owner' | 'admin' | 'member'
   */
  router.patch('/:memberId', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const { memberId } = req.params
      const { role } = req.body as { role?: string }

      if (!role || !VALID_MEMBER_ROLES.includes(role as MemberRole)) {
        res.status(400).json({
          error: 'InvalidRequest',
          message: `Invalid or missing role. Must be one of: ${VALID_MEMBER_ROLES.join(', ')}`,
        })
        return
      }

      const result = await memberService.updateMemberRole(
        authReq.user!.id,
        authReq.user!.email,
        { memberId, role: role as MemberRole },
      )

      res.status(200).json({ success: true, data: result.member, message: result.message })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      const isNotFound = message.includes('not found')
      res.status(isNotFound ? 404 : 400).json({
        error: isNotFound ? 'NotFound' : 'BadRequest',
        message,
      })
    }
  })

  // ── DELETE /api/orgs/:orgId/members/:memberId ───────────────────────
  /**
   * Soft-delete a member.
   *
   * The row is NOT removed from the database.  `deleted_at` and `deleted_by`
   * are set.  The member can be restored via the restore endpoint.
   * After deletion the same user can be re-invited (new row, new membership).
   */
  router.delete('/:memberId', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const { memberId } = req.params

      const result = await memberService.deleteMember(
        authReq.user!.id,
        authReq.user!.email,
        { memberId },
      )

      res.status(200).json({ success: true, message: result.message })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      const isNotFound = message.includes('not found') || message.includes('already deleted')
      res.status(isNotFound ? 404 : 400).json({
        error: isNotFound ? 'NotFound' : 'BadRequest',
        message,
      })
    }
  })

  // ── POST /api/orgs/:orgId/members/:memberId/restore ─────────────────
  /**
   * Restore a previously soft-deleted member.
   *
   * Returns 409 if an active membership already exists for the same
   * (org, user) pair — use the existing membership instead.
   * Returns 404 if the member ID is unknown or the member was never deleted.
   */
  router.post('/:memberId/restore', requireUserAuth, requireAdminRole, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest
      const { memberId } = req.params

      const result = await memberService.restoreMember(
        authReq.user!.id,
        authReq.user!.email,
        { memberId },
      )

      res.status(200).json({ success: true, data: result.member, message: result.message })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (message.includes('already exists')) {
        res.status(409).json({ error: 'Conflict', message })
        return
      }
      if (message.includes('not found') || message.includes('already active')) {
        res.status(404).json({ error: 'NotFound', message })
        return
      }
      res.status(500).json({ error: 'InternalError', message })
    }
  })

  return router
}