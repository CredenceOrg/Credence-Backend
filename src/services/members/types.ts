import type { PaginationOptions } from '../admin/types.ts'

// Re-export for convenience so callers can import everything from one place.
export type { PaginationOptions }

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Roles a member may hold within an organisation. */
export type MemberRole = 'owner' | 'admin' | 'member'

/**
 * A single organisation member row as returned from the database.
 * `deleted_at` and `deleted_by` are included so callers that explicitly
 * request deleted records (e.g. audit exports) can inspect them.
 */
export interface Member {
  id: string
  orgId: string
  userId: string
  email: string
  role: MemberRole
  createdAt: string
  updatedAt: string
  /** ISO timestamp set on soft-delete; null means the member is active. */
  deletedAt: string | null
  /** ID of the admin who performed the soft-delete; null if not deleted. */
  deletedBy: string | null
}

/**
 * The public-facing member shape returned from API endpoints.
 * Omits internal soft-delete columns — callers should not rely on them
 * unless they are specifically using the restore or audit endpoints.
 */
export type MemberView = Omit<Member, 'deletedAt' | 'deletedBy'>

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

export interface InviteMemberRequest {
  orgId: string
  userId: string
  email: string
  role?: MemberRole
}

export interface UpdateMemberRoleRequest {
  /** Org whose member list contains the row. Validated by the service. */
  orgId: string
  memberId: string
  role: MemberRole
}

/**
 * Soft-delete request. `orgId` MUST match the URL `:orgId` parameter —
 * the service refuses cross-organisation deletes by mapping the audit
 * `status = failure` and returning NOT_FOUND. Including it explicitly in
 * the request type makes the contract surface clear at every call site.
 */
export interface DeleteMemberRequest {
  orgId: string
  memberId: string
}

/**
 * Restore request. Same ownership invariant as delete: the row's
 * `org_id` must equal the URL `:orgId`. The service also refuses to
 * restore if doing so would exceed the unique-active-membership cap
 * (partial unique index `uq_org_members_active`).
 */
export interface RestoreMemberRequest {
  orgId: string
  memberId: string
}

export interface ListMembersRequest {
  orgId: string
  includeDeleted?: boolean
}

export interface InviteMemberResponse {
  success: boolean
  member: MemberView
  message: string
}

export interface UpdateMemberRoleResponse {
  success: boolean
  member: MemberView
  message: string
}

export interface DeleteMemberResponse {
  success: boolean
  message: string
}

export interface RestoreMemberResponse {
  success: boolean
  member: MemberView
  message: string
}

export interface ListMembersResponse {
  members: MemberView[]
  total: number
  page: number
  limit: number
  hasNext: boolean
  offset: number
}