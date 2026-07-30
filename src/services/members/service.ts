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
 *
 * Failure modes use typed sentinel classes from `./errors.js` so the
 * route layer can map them to the right status code via `instanceof`
 * instead of substring-matching on `err.message`.
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
import { profileInvalidationHook } from '../../cache/invalidationHooks.js'
import { logger } from '../../utils/logger.js'

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
    tenantId: string,
    adminId: string,
    adminEmail: string,
    request: InviteMemberRequest,
    requestId?: string
  ): Promise<InviteMemberResponse> {
    const { orgId, userId, email, role = 'member' } = request

    const existing = await this.repo.findActiveByOrgAndUser(orgId, userId)
    if (existing) {
      this.auditLog.logAction(
        tenantId,
        adminId, adminEmail,
        AuditAction.INVITE_MEMBER,
        userId, email,
        { orgId, role },
        'failure',
        'Member already active in this organisation',
        undefined,
        requestId
      )
      throw new MemberAlreadyActiveError()
    }

    const member = await this.repo.insert(orgId, userId, email, role as MemberRole)

    this.auditLog.logAction(
      tenantId,
      adminId, adminEmail,
      AuditAction.INVITE_MEMBER,
      userId, email,
      { orgId, role: member.role, memberId: member.id },
      'success',
      undefined,
      undefined,
      requestId
    )

    // Post-commit hook: invalidate profile caches
    profileInvalidationHook.execute(orgId, member.id).catch((err) =>
      logger.error({ err, msg: 'Failed to invalidate cache after inviteMember' }),
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
    tenantId: string,
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
      tenantId,
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
    tenantId: string,
    adminId: string,
    adminEmail: string,
    request: UpdateMemberRoleRequest,
  ): Promise<UpdateMemberRoleResponse> {
    const { memberId, role } = request

    const existing = await this.repo.findActiveById(memberId)
    if (!existing) {
      throw new MemberNotFoundError(`Member not found or has been removed: ${memberId}`)
    }

    // Authorisation invariant: the URL :orgId MUST match the row's org.
    // An admin (even with global admin role) cannot mutate members
    // belonging to a different organisation. Surface as NOT_FOUND rather
    // than FORBIDDEN so we don't leak the existence of cross-org IDs.
    if (existing.orgId !== request.orgId) {
      this.auditLog.logAction(
        tenantId,
        adminId, adminEmail,
        AuditAction.UPDATE_MEMBER_ROLE,
        existing.userId, existing.email,
        { memberId, requestedOrgId: request.orgId, rowOrgId: existing.orgId, role },
        'failure',
        'Cross-organisation member operation denied',
      )
      throw new MemberNotFoundError(
        `Member not found in organisation ${request.orgId}: ${memberId}`,
      )
    }

    // Last-owner guard: if we are demoting an owner and they are the last
    // active owner, refuse. Apply this BEFORE the mutation so a partial
    // failure cannot leave the org unmanageable. Promoting to owner is
    // always safe since it strictly increases the owner count.
    if (existing.role === 'owner' && role !== 'owner') {
      const ownerCount = await this.repo.countActiveOwners(request.orgId)
      if (ownerCount <= 1) {
        this.auditLog.logAction(
          tenantId,
          adminId, adminEmail,
          AuditAction.UPDATE_MEMBER_ROLE,
          existing.userId, existing.email,
          { memberId, orgId: existing.orgId, oldRole: existing.role, newRole: role, ownerCount },
          'failure',
          'Cannot demote the last active owner',
        )
        throw new LastOwnerError(
          `Cannot demote the last active owner in organisation ${request.orgId}`,
        )
      }
    }

    const oldRole = existing.role
    const updated = await this.repo.updateRole(memberId, role)

    // Post-condition race re-classification. `updateRole` only filters on
    // `(id, deleted_at IS NULL)` so a 0-row outcome means a concurrent
    // transaction soft-deleted the row between our `findActiveById` and
    // the UPDATE. Re-counting active owners tells us whether we landed in
    // a degraded state (LastOwnerError → 409) or simply lost a race to
    // a peer admin's delete (MemberAlreadyDeletedError → 404). The 409
    // path is what the upstream reviewer surfaced as the missing case
    // — without this, the post-condition null was incorrectly surfaced
    // as a 400 'UPDATE failed unexpectedly'.
    if (!updated) {
      const ownerCount = await this.repo.countActiveOwners(request.orgId)
      if (ownerCount <= 0) {
        this.auditLog.logAction(
          tenantId,
          adminId, adminEmail,
          AuditAction.UPDATE_MEMBER_ROLE,
          existing.userId, existing.email,
            { memberId, orgId: existing.orgId, ownerCount },
          'failure',
          'Concurrent soft-delete left the organisation with no active owners',
        )
        throw new LastOwnerError(
          `Organisation ${request.orgId} has no active owners after a concurrent soft-delete`,
        )
      }
      this.auditLog.logAction(
        tenantId,
        adminId, adminEmail,
        AuditAction.UPDATE_MEMBER_ROLE,
        existing.userId, existing.email,
        { memberId, orgId: existing.orgId },
        'failure',
        'Member was concurrently soft-deleted',
      )
      throw new MemberAlreadyDeletedError(
        `Member ${memberId} was concurrently soft-deleted`,
      )
    }

    this.auditLog.logAction(
      tenantId,
      adminId, adminEmail,
      AuditAction.UPDATE_MEMBER_ROLE,
      existing.userId, existing.email,
      { memberId, oldRole, newRole: role, orgId: existing.orgId },
      'success',
    )

    // Post-commit hook: invalidate profile caches
    profileInvalidationHook.execute(existing.orgId, memberId).catch((err) =>
      logger.error({ err, msg: 'Failed to invalidate cache after updateMemberRole' }),
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
    tenantId: string,
    adminId: string,
    adminEmail: string,
    request: DeleteMemberRequest,
  ): Promise<DeleteMemberResponse> {
    const { memberId } = request

    const existing = await this.repo.findActiveById(memberId)
    if (!existing) {
      this.auditLog.logAction(
        tenantId,
        adminId, adminEmail,
        AuditAction.DELETE_MEMBER,
        memberId, 'unknown',
        { memberId, orgId: request.orgId },
        'failure',
        'Member not found or already deleted',
      )
      throw new MemberAlreadyDeletedError(
        `Member not found or already deleted: ${memberId}`,
      )
    }

    // Authorisation invariant: the URL :orgId MUST match the row's org.
    // Refuse with MemberNotFoundError so cross-org probing does not leak
    // the existence of member IDs in neighbouring organisations.
    if (existing.orgId !== request.orgId) {
      this.auditLog.logAction(
        tenantId,
        adminId, adminEmail,
        AuditAction.DELETE_MEMBER,
        existing.userId, existing.email,
        {
          memberId,
          requestedOrgId: request.orgId,
          rowOrgId: existing.orgId,
        },
        'failure',
        'Cross-organisation member operation denied',
      )
      throw new MemberNotFoundError(
        `Member not found in organisation ${request.orgId}: ${memberId}`,
      )
    }

    // Last-owner guard: refuse to soft-delete the last active owner so
    // the org cannot accidentally be left unmanageable. Audited as a
    // 'failure' so operators can see the attempt in the trail.
    if (existing.role === 'owner') {
      const ownerCount = await this.repo.countActiveOwners(request.orgId)
      if (ownerCount <= 1) {
        this.auditLog.logAction(
          tenantId,
          adminId, adminEmail,
          AuditAction.DELETE_MEMBER,
          existing.userId, existing.email,
          { memberId, orgId: existing.orgId, ownerCount },
          'failure',
          'Cannot remove the last active owner',
        )
        throw new LastOwnerError(
          `Cannot remove the last active owner in organisation ${request.orgId}`,
        )
      }
    }

    const deleted = await this.repo.softDelete(memberId, adminId)

    // Post-condition race re-classification. `softDelete` only filters
    // on `(id, deleted_at IS NULL)` so a 0-row outcome means a peer
    // transaction soft-deleted the row between our `findActiveById` and
    // this UPDATE. Re-counting active owners distinguishes a degraded
    // state (LastOwnerError → 409) from a benign lost-race
    // (MemberAlreadyDeletedError → 404). See `updateMemberRole` for the
    // mirror instance of this branch.
    if (!deleted) {
      const ownerCount = await this.repo.countActiveOwners(request.orgId)
      if (ownerCount <= 0) {
        this.auditLog.logAction(
          tenantId,
          adminId, adminEmail,
          AuditAction.DELETE_MEMBER,
          existing.userId, existing.email,
          { memberId, orgId: existing.orgId, ownerCount },
          'failure',
          'Concurrent soft-delete left the organisation with no active owners',
        )
        throw new LastOwnerError(
          `Organisation ${request.orgId} has no active owners after a concurrent soft-delete`,
        )
      }
      this.auditLog.logAction(
        tenantId,
        adminId, adminEmail,
        AuditAction.DELETE_MEMBER,
        existing.userId, existing.email,
        { memberId, orgId: existing.orgId },
        'failure',
        'Member was concurrently soft-deleted',
      )
      throw new MemberAlreadyDeletedError(
        `Member ${memberId} was concurrently soft-deleted`,
      )
    }

    this.auditLog.logAction(
      tenantId,
      adminId, adminEmail,
      AuditAction.DELETE_MEMBER,
      existing.userId, existing.email,
      {
        memberId,
        orgId: existing.orgId,
        deletedAt: deleted.deletedAt,
        deletedBy: adminId,
      },
      'success',
    )

    // Post-commit hook: invalidate profile caches
    profileInvalidationHook.execute(existing.orgId, memberId).catch((err) =>
      logger.error({ err, msg: 'Failed to invalidate cache after deleteMember' }),
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
    tenantId: string,
    adminId: string,
    adminEmail: string,
    request: RestoreMemberRequest,
  ): Promise<RestoreMemberResponse> {
    const { memberId } = request

    const existing = await this.repo.findById(memberId)
    if (!existing) {
      this.auditLog.logAction(
        tenantId,
        adminId, adminEmail,
        AuditAction.RESTORE_MEMBER,
        memberId, 'unknown',
        { memberId, orgId: request.orgId },
        'failure',
        'Member not found',
      )
      throw new MemberNotFoundError(`Member not found: ${memberId}`)
    }
    if (!existing.deletedAt) {
      throw new MemberAlreadyDeletedError(
        `Member ${memberId} is already active — nothing to restore`,
      )
    }

    // Authorisation invariant: same as delete — the URL :orgId MUST match
    // the row's org. Refuses cross-org restores as MemberNotFoundError so
    // the existence of a deleted-but-restoreable member ID in a neighbour
    // org cannot be probed.
    if (existing.orgId !== request.orgId) {
      this.auditLog.logAction(
        tenantId,
        adminId, adminEmail,
        AuditAction.RESTORE_MEMBER,
        existing.userId, existing.email,
        {
          memberId,
          requestedOrgId: request.orgId,
          rowOrgId: existing.orgId,
        },
        'failure',
        'Cross-organisation member operation denied',
      )
      throw new MemberNotFoundError(
        `Member not found in organisation ${request.orgId}: ${memberId}`,
      )
    }

    const conflict = await this.repo.findActiveByOrgAndUser(existing.orgId, existing.userId)
    if (conflict) {
      this.auditLog.logAction(
        tenantId,
        adminId, adminEmail,
        AuditAction.RESTORE_MEMBER,
        existing.userId, existing.email,
        { memberId, conflictingMemberId: conflict.id, orgId: existing.orgId },
        'failure',
        'An active membership already exists for this user in this organisation',
      )
      throw new ActiveMembershipExistsError()
    }

    // Forensic snapshot: the audit trail needs to retain *who* deleted
    // the member and *when*, even after the row is re-activated. The
    // soft-delete cleared the row's deleted_at/deleted_by columns on
    // restore, so we capture them here BEFORE applying the change.
    const previousDeletedBy = existing.deletedBy
    const previousDeletedAt = existing.deletedAt
    const deletedForSeconds = previousDeletedAt
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - new Date(previousDeletedAt).getTime()) / 1000,
          ),
        )
      : null

    const restored = await this.repo.restore(memberId)
    if (!restored) throw new MemberAlreadyDeletedError(`Member ${memberId} was concurrently hard-deleted before restore`)

    this.auditLog.logAction(
      tenantId,
      adminId, adminEmail,
      AuditAction.RESTORE_MEMBER,
      existing.userId, existing.email,
      {
        memberId,
        orgId: existing.orgId,
        previousDeletedBy,
        previousDeletedAt,
        deletedForSeconds,
      },
      'success',
    )

    // Post-commit hook: invalidate profile caches
    profileInvalidationHook.execute(existing.orgId, memberId).catch((err) =>
      logger.error({ err, msg: 'Failed to invalidate cache after restoreMember' }),
    )

    return {
      success: true,
      member: toMemberView(restored),
      message: `Member ${restored.email} has been restored`,
    }
  }
}
