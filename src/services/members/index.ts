/**
 * @file src/services/members/index.ts
 *
 * Public surface for the members service module.
 *
 * Consumers should import from here rather than from individual files
 * so that internal reorganisation doesn't break callers.
 */

export { MemberService } from './service.js'
export { createMemberService } from './factory.js'
export type {
  Member,
  MemberView,
  MemberRole,
  InviteMemberRequest,
  InviteMemberResponse,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
  DeleteMemberRequest,
  DeleteMemberResponse,
  RestoreMemberRequest,
  RestoreMemberResponse,
  ListMembersRequest,
  ListMembersResponse,
} from './types.js'