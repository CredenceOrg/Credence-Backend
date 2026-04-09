/**
 * @file src/services/members/service.ts
 *
 * Business logic for organisation member management.  All mutations are
 * audit-logged and enforce the soft-delete contract:
 *
 *  - Deletion sets `deleted_at` / `deleted_by` rather than removing the row.
 *  - List queries exclude deleted members by default.
 *  - Restore re-activates a deleted member, but only if no active membership
 *    already exists for that (org, user) pair.
 *  - Invite is blocked if an active membership already exists; after
 *    soft-delete the partial unique index allows a fresh invite.
 */

import type { AuditLogService } from '../audit/index.js'
import { AuditAction } from '../audit/index.js'
// toMemberView lives with MemberRepository in the repositories layer
import { toMemberView } from '../../repositories/member.repository.js'
import type { MemberRepository } from '../../repositories/member.repository.js'
import type {
  InviteMemberRequest,
  InviteMemberResponse,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
  DeleteMemberRequest,
  DeleteMemberResponse,
  RestoreMemberRequest,
  RestoreMemberResponse,
  ListMembersResponse,
  MemberRole,
  PaginationOptions,
} from './types.js'

export class MemberService {
  constructor(
    private readonly repo: MemberRepository,
    private readonly auditLog: AuditLogService,
  ) {}

  // ── Invite ────────────────────────────────────────────────────────────────

  /**
   * Invite a user to an organisation.
   *
   * Blocked if an **active** membership already exists for (orgId, userId).
   * Allowed after a previous membership was soft-deleted.
   */
  async inviteMember(
    adminId: string,
    adminEmail: string,
    request: InviteMemberRequest,
  ): Promise<InviteMemberResponse> {
    const { orgId, userId, email, role = 'member' } = request

    const existing = await this.repo.findActiveByOrgAndUser(orgId, userId)
    if (existing) {
      this.auditLog.logAction(
        adminId, adminEmail,
        AuditAction.INVITE_MEMBER,
        userId, email,
        { orgId, role },
        'failure',
        'Member already active in this organisation',
      )
      throw new Error('Member is already active in this organisation')
    }

    const member = await this.repo.insert(orgId, userId, email, role as MemberRole)

    this.auditLog.logAction(
      adminId, adminEmail,
      AuditAction.INVITE_MEMBER,
      userId, email,
      { orgId, role: member.role, memberId: member.id },
      'success',
    )

    return {
      success: true,
      member: toMemberView(member),
      message: `${email} invited as ${member.role}`,
    }
  }

  // ── List ──────────────────────────────────────────────────────────────────

  /**
   * List members for an organisation.
   * Active members only by default; pass `includeDeleted: true` to include
   * soft-deleted rows.
   */
  async listMembers(
    adminId: string,
    adminEmail: string,
    orgId: string,
    pagination: PaginationOptions = {},
    includeDeleted: boolean = false,
  ): Promise<ListMembersResponse> {
    const page   = pagination.page   ?? 1
    const limit  = pagination.limit  ?? 50
    const offset = pagination.offset ?? 0

    this.auditLog.logAction(
      adminId, adminEmail,
      AuditAction.LIST_MEMBERS,
      adminId, adminEmail,
      { orgId, limit, offset, includeDeleted },
    )

    const { members, total } = await this.repo.listByOrg(orgId, includeDeleted, limit, offset)

    return {
      members: members.map(toMemberView),
      total,
      page,
      limit,
      hasNext: offset + members.length < total,
      offset,
    }
  }

  // ── Update role ───────────────────────────────────────────────────────────

  async updateMemberRole(
    adminId: string,
    adminEmail: string,
    request: UpdateMemberRoleRequest,
  ): Promise<UpdateMemberRoleResponse> {
    const { memberId, role } = request

    const existing = await this.repo.findActiveById(memberId)
    if (!existing) {
      throw new Error(`Member not found or has been removed: ${memberId}`)
    }

    const oldRole = existing.role
    const updated = await this.repo.updateRole(memberId, role)
    if (!updated) throw new Error('Failed to update member role')

    this.auditLog.logAction(
      adminId, adminEmail,
      AuditAction.UPDATE_MEMBER_ROLE,
      existing.userId, existing.email,
      { memberId, oldRole, newRole: role, orgId: existing.orgId },
      'success',
    )

    return {
      success: true,
      member: toMemberView(updated),
      message: `Role updated from ${oldRole} to ${role}`,
    }
  }

  // ── Soft-delete ───────────────────────────────────────────────────────────

  /**
   * Soft-delete a member.  Sets `deleted_at = now()` and `deleted_by = adminId`.
   * The row is retained for audit history and can be restored.
   */
  async deleteMember(
    adminId: string,
    adminEmail: string,
    request: DeleteMemberRequest,
  ): Promise<DeleteMemberResponse> {
    const { memberId } = request

    const existing = await this.repo.findActiveById(memberId)
    if (!existing) {
      this.auditLog.logAction(
        adminId, adminEmail,
        AuditAction.DELETE_MEMBER,
        memberId, 'unknown',
        { memberId },
        'failure',
        'Member not found or already deleted',
      )
      throw new Error(`Member not found or already deleted: ${memberId}`)
    }

    const deleted = await this.repo.softDelete(memberId, adminId)
    if (!deleted) throw new Error('Soft-delete failed unexpectedly')

    this.auditLog.logAction(
      adminId, adminEmail,
      AuditAction.DELETE_MEMBER,
      existing.userId, existing.email,
      { memberId, orgId: existing.orgId, deletedAt: deleted.deletedAt },
      'success',
    )

    return { success: true, message: `Member ${existing.email} has been removed` }
  }

  // ── Restore ───────────────────────────────────────────────────────────────

  /**
   * Restore a soft-deleted member.  Clears `deleted_at` and `deleted_by`.
   *
   * Blocked if another active membership exists for the same (org, user) pair.
   */
  async restoreMember(
    adminId: string,
    adminEmail: string,
    request: RestoreMemberRequest,
  ): Promise<RestoreMemberResponse> {
    const { memberId } = request

    const existing = await this.repo.findById(memberId)
    if (!existing) throw new Error(`Member not found: ${memberId}`)
    if (!existing.deletedAt) {
      throw new Error(`Member ${memberId} is already active — nothing to restore`)
    }

    const conflict = await this.repo.findActiveByOrgAndUser(existing.orgId, existing.userId)
    if (conflict) {
      this.auditLog.logAction(
        adminId, adminEmail,
        AuditAction.RESTORE_MEMBER,
        existing.userId, existing.email,
        { memberId, conflictingMemberId: conflict.id, orgId: existing.orgId },
        'failure',
        'An active membership already exists for this user in this organisation',
      )
      throw new Error(
        'Cannot restore: an active membership already exists for this user in this organisation',
      )
    }

    const restored = await this.repo.restore(memberId)
    if (!restored) throw new Error('Restore failed unexpectedly')

    this.auditLog.logAction(
      adminId, adminEmail,
      AuditAction.RESTORE_MEMBER,
      existing.userId, existing.email,
      { memberId, orgId: existing.orgId },
      'success',
    )

    return {
      success: true,
      member: toMemberView(restored),
      message: `Member ${restored.email} has been restored`,
    }
  }
}