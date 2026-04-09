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
  memberId: string
  role: MemberRole
}

export interface DeleteMemberRequest {
  memberId: string
}

export interface RestoreMemberRequest {
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