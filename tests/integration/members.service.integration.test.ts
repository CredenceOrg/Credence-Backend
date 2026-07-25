import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { createSchema, resetDatabase } from '../../src/db/schema.js'
import { MemberService } from '../../src/services/members/service.js'
import { MemberRepository } from '../../src/repositories/member.repository.js'
import { AuditLogService } from '../../src/services/audit/index.js'
import { PostgresAuditLogsRepository } from '../../src/db/repositories/auditLogsRepository.js'
import { AuditAction } from '../../src/services/audit/types.js'

let testDb: TestDatabase
let pool: Pool
let memberService: MemberService
let auditLogService: AuditLogService
let memberRepository: MemberRepository

function isRealPostgres(db: TestDatabase): boolean {
  return !db.connectionString.startsWith('pg-mem://')
}

beforeAll(async () => {
  testDb = await createTestDatabase()

  if (!isRealPostgres(testDb)) {
    return
  }

  pool = testDb.pool
  await createSchema(pool)
}, 60_000)

beforeEach(async () => {
  if (!isRealPostgres(testDb)) return

  await resetDatabase(pool)

  memberRepository = new MemberRepository(pool)
  auditLogService = new AuditLogService(new PostgresAuditLogsRepository(pool))
  memberService = new MemberService(memberRepository, auditLogService)
})

afterAll(async () => {
  await testDb.close()
})

describe('MemberService - Integration Tests', () => {
  it('should complete the full lifecycle: invite → list → update role → soft delete → restore', async () => {
    if (!isRealPostgres(testDb)) return

    const tenantId = 'test-tenant-id'
    const adminId = '00000000-0000-0000-0000-000000000001'
    const adminEmail = 'admin@test.com'
    const orgId = '11111111-1111-1111-1111-111111111111'
    const userId = '22222222-2222-2222-2222-222222222222'
    const userEmail = 'user@test.com'

    // Step 1: Invite
    const inviteResult = await memberService.inviteMember(
      tenantId,
      adminId,
      adminEmail,
      { orgId, userId, email: userEmail, role: 'member' }
    )
    expect(inviteResult.success).toBe(true)
    expect(inviteResult.member.role).toBe('member')

    // Step 2: List members (should include the new member)
    const listAfterInvite = await memberService.listMembers(
      tenantId,
      adminId,
      adminEmail,
      orgId
    )
    expect(listAfterInvite.members.length).toBe(1)
    expect(listAfterInvite.members[0].id).toBe(inviteResult.member.id)
    expect(listAfterInvite.total).toBe(1)

    // Step 3: Update role to admin
    const updateResult = await memberService.updateMemberRole(
      tenantId,
      adminId,
      adminEmail,
      { memberId: inviteResult.member.id, role: 'admin' }
    )
    expect(updateResult.success).toBe(true)
    expect(updateResult.member.role).toBe('admin')

    // Step 4: Soft delete
    const deleteResult = await memberService.deleteMember(
      tenantId,
      adminId,
      adminEmail,
      { memberId: inviteResult.member.id }
    )
    expect(deleteResult.success).toBe(true)

    // Step 5: List members again (should exclude soft deleted)
    const listAfterDelete = await memberService.listMembers(
      tenantId,
      adminId,
      adminEmail,
      orgId
    )
    expect(listAfterDelete.members.length).toBe(0)
    expect(listAfterDelete.total).toBe(0)

    // Step 6: Restore
    const restoreResult = await memberService.restoreMember(
      tenantId,
      adminId,
      adminEmail,
      { memberId: inviteResult.member.id }
    )
    expect(restoreResult.success).toBe(true)
    expect(restoreResult.member.role).toBe('admin')

    // Step 7: List members after restore (should include with correct role)
    const listAfterRestore = await memberService.listMembers(
      tenantId,
      adminId,
      adminEmail,
      orgId
    )
    expect(listAfterRestore.members.length).toBe(1)
    expect(listAfterRestore.members[0].role).toBe('admin')
  })

  it('should throw error when restoring a never-deleted member', async () => {
    if (!isRealPostgres(testDb)) return

    const tenantId = 'test-tenant-id'
    const adminId = '00000000-0000-0000-0000-000000000001'
    const adminEmail = 'admin@test.com'
    const orgId = '11111111-1111-1111-1111-111111111111'
    const userId = '22222222-2222-2222-2222-222222222222'
    const userEmail = 'user@test.com'

    const inviteResult = await memberService.inviteMember(
      tenantId,
      adminId,
      adminEmail,
      { orgId, userId, email: userEmail, role: 'member' }
    )

    await expect(
      memberService.restoreMember(tenantId, adminId, adminEmail, { memberId: inviteResult.member.id })
    ).rejects.toThrow()
  })

  it('should emit audit logs for each mutating operation', async () => {
    if (!isRealPostgres(testDb)) return

    const tenantId = 'test-tenant-id'
    const adminId = '00000000-0000-0000-0000-000000000001'
    const adminEmail = 'admin@test.com'
    const orgId = '11111111-1111-1111-1111-111111111111'
    const userId = '22222222-2222-2222-2222-222222222222'
    const userEmail = 'user@test.com'

    // Invite
    const inviteResult = await memberService.inviteMember(
      tenantId,
      adminId,
      adminEmail,
      { orgId, userId, email: userEmail, role: 'member' }
    )

    // Update role
    await memberService.updateMemberRole(
      tenantId,
      adminId,
      adminEmail,
      { memberId: inviteResult.member.id, role: 'admin' }
    )

    // Delete
    await memberService.deleteMember(
      tenantId,
      adminId,
      adminEmail,
      { memberId: inviteResult.member.id }
    )

    // Restore
    await memberService.restoreMember(
      tenantId,
      adminId,
      adminEmail,
      { memberId: inviteResult.member.id }
    )

    // List (should also emit audit log)
    await memberService.listMembers(
      tenantId,
      adminId,
      adminEmail,
      orgId
    )

    const auditLogs = await auditLogService.getAllLogs()
    const actions = auditLogs.map(log => log.action)
    expect(actions).toContain(AuditAction.INVITE_MEMBER)
    expect(actions).toContain(AuditAction.UPDATE_MEMBER_ROLE)
    expect(actions).toContain(AuditAction.DELETE_MEMBER)
    expect(actions).toContain(AuditAction.RESTORE_MEMBER)
    expect(actions).toContain(AuditAction.LIST_MEMBERS)
  })
})
