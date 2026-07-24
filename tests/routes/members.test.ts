import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { createMembersRouter } from '../../src/routes/admin/member.js'

// ---- Mock middleware ----
vi.mock('../../src/middleware/auth.ts', () => ({
  requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: 'admin-1', email: 'admin@test.com', tenantId: 'tenant-1' }
    next()
  },
  requireAdminRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

// ---- Mock MemberService ----
const mockService = {
  listMembers: vi.fn(),
  inviteMember: vi.fn(),
  updateMemberRole: vi.fn(),
  deleteMember: vi.fn(),
  restoreMember: vi.fn(),
}

vi.mock('../../src/services/members/service.ts', () => ({
  MemberService: vi.fn().mockImplementation(function() { return mockService }),
}))

// ---- Mock pagination ----
vi.mock('../../src/lib/pagination.ts', () => ({
  parsePaginationParams: vi.fn().mockReturnValue({ page: 1, limit: 10, offset: 0 }),
  buildPaginationMeta: vi.fn().mockReturnValue({ totalPages: 1 }),
  PaginationValidationError: class extends Error {
    details = { limit: 'invalid' }
  },
}))

function setup() {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/orgs/:orgId/members', createMembersRouter())
  return app
}

describe('Members Router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─────────────────────────────────────────────
  // GET /members
  // ─────────────────────────────────────────────
  it('should list members successfully', async () => {
    mockService.listMembers.mockResolvedValue({
      members: [],
      total: 0,
      page: 1,
      limit: 10,
      offset: 0,
      hasNext: false,
    })

    const res = await request(setup()).get('/api/admin/orgs/org-1/members')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('should include deleted members when requested', async () => {
    mockService.listMembers.mockResolvedValue({
      members: [{ id: 'm1', email: 'test@test.com', deletedAt: '2023-01-01T00:00:00Z' }],
      total: 1,
      page: 1,
      limit: 10,
      offset: 0,
      hasNext: false,
    })

    const res = await request(setup())
      .get('/api/admin/orgs/org-1/members')
      .query({ includeDeleted: 'true' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(mockService.listMembers).toHaveBeenCalledWith(
      'tenant-1',
      'admin-1',
      'admin@test.com',
      'org-1',
      { page: 1, limit: 10, offset: 0 },
      true
    )
  })

  it('should return 400 for invalid pagination', async () => {
    const { parsePaginationParams, PaginationValidationError } = await import('../../src/lib/pagination.ts')
    ;(parsePaginationParams as any).mockImplementationOnce(() => {
      const err = new PaginationValidationError('Invalid')
      err.details = {} as any
      throw err
    })

    const res = await request(setup()).get('/api/admin/orgs/org-1/members')

    expect(res.status).toBe(400)
  })

  it('should handle internal errors on list', async () => {
    mockService.listMembers.mockRejectedValue(new Error('boom'))

    const res = await request(setup()).get('/api/admin/orgs/org-1/members')

    expect(res.status).toBe(500)
  })

  // ─────────────────────────────────────────────
  // POST /members
  // ─────────────────────────────────────────────
  it('should invite member successfully', async () => {
    mockService.inviteMember.mockResolvedValue({
      member: { id: 'm1' },
      message: 'invited',
    })

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members')
      .send({ userId: 'u1', email: 'test@test.com' })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
  })

  it('should return 400 if missing fields', async () => {
    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members')
      .send({})

    expect(res.status).toBe(400)
  })

  it('should return 400 for invalid role', async () => {
    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members')
      .send({ userId: 'u1', email: 'a@test.com', role: 'invalid' })

    expect(res.status).toBe(400)
  })

  it('should return 400 for unknown fields in invite request', async () => {
    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members')
      .send({ userId: 'u1', email: 'a@test.com', role: 'admin', maliciousField: 'attack' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_failed')
  })

  it('should return 409 if member already exists', async () => {
    mockService.inviteMember.mockRejectedValue(
      new Error('already active')
    )

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members')
      .send({ userId: 'u1', email: 'a@test.com' })

    expect(res.status).toBe(409)
  })

  // ─────────────────────────────────────────────
  // PATCH /members/:memberId
  // ─────────────────────────────────────────────
  it('should update member role', async () => {
    mockService.updateMemberRole.mockResolvedValue({
      member: { id: 'm1' },
      message: 'updated',
    })

    const res = await request(setup())
      .patch('/api/admin/orgs/org-1/members/m1')
      .send({ role: 'admin' })

    expect(res.status).toBe(200)
  })

  it('should return 400 for invalid role update', async () => {
    const res = await request(setup())
      .patch('/api/admin/orgs/org-1/members/m1')
      .send({ role: 'invalid' })

    expect(res.status).toBe(400)
  })

  it('should return 400 for unknown fields in update role request', async () => {
    const res = await request(setup())
      .patch('/api/admin/orgs/org-1/members/m1')
      .send({ role: 'admin', maliciousField: 'attack' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('validation_failed')
  })

  it('should return 404 if member not found on update', async () => {
    mockService.updateMemberRole.mockRejectedValue(
      new Error('not found')
    )

    const res = await request(setup())
      .patch('/api/admin/orgs/org-1/members/m1')
      .send({ role: 'admin' })

    expect(res.status).toBe(404)
  })

  // ─────────────────────────────────────────────
  // DELETE /members/:memberId
  // ─────────────────────────────────────────────
  it('should delete member', async () => {
    mockService.deleteMember.mockResolvedValue({
      message: 'deleted',
    })

    const res = await request(setup())
      .delete('/api/admin/orgs/org-1/members/m1')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.message).toBe('deleted')
  })

  it('should return 404 if member not found on delete', async () => {
    mockService.deleteMember.mockRejectedValue(
      new Error('not found')
    )

    const res = await request(setup())
      .delete('/api/admin/orgs/org-1/members/m1')

    expect(res.status).toBe(404)
  })

  it('should return 404 if member already deleted', async () => {
    mockService.deleteMember.mockRejectedValue(
      new Error('already deleted')
    )

    const res = await request(setup())
      .delete('/api/admin/orgs/org-1/members/m1')

    expect(res.status).toBe(404)
  })

  // ─────────────────────────────────────────────
  // POST /restore
  // ─────────────────────────────────────────────
  it('should restore member', async () => {
    mockService.restoreMember.mockResolvedValue({
      member: { id: 'm1', email: 'restored@test.com' },
      message: 'restored',
    })

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members/m1/restore')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.id).toBe('m1')
    expect(res.body.message).toBe('restored')
  })

  it('should return 409 on restore conflict', async () => {
    mockService.restoreMember.mockRejectedValue(
      new Error('already exists')
    )

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members/m1/restore')

    expect(res.status).toBe(409)
  })

  it('should return 404 if restore target not found', async () => {
    mockService.restoreMember.mockRejectedValue(
      new Error('not found')
    )

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members/m1/restore')

    expect(res.status).toBe(404)
  })

  it('should return 404 if member already active on restore', async () => {
    mockService.restoreMember.mockRejectedValue(
      new Error('already active')
    )

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members/m1/restore')

    expect(res.status).toBe(404)
  })

  it('should return 500 for unexpected restore error', async () => {
    mockService.restoreMember.mockRejectedValue(
      new Error('weird error')
    )

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members/m1/restore')

    expect(res.status).toBe(500)
  })

  // ─────────────────────────────────────────────
  // Soft-delete specific tests
  // ─────────────────────────────────────────────
  it('should audit log soft-delete operations', async () => {
    mockService.deleteMember.mockResolvedValue({
      message: 'Member test@test.com has been removed',
    })

    await request(setup())
      .delete('/api/admin/orgs/org-1/members/m1')

    expect(mockService.deleteMember).toHaveBeenCalledWith(
      'tenant-1',
      'admin-1',
      'admin@test.com',
      { memberId: 'm1' }
    )
  })

  it('should audit log restore operations', async () => {
    mockService.restoreMember.mockResolvedValue({
      member: { id: 'm1', email: 'restored@test.com' },
      message: 'Member restored@test.com has been restored',
    })

    await request(setup())
      .post('/api/admin/orgs/org-1/members/m1/restore')

    expect(mockService.restoreMember).toHaveBeenCalledWith(
      'tenant-1',
      'admin-1',
      'admin@test.com',
      { memberId: 'm1' }
    )
  })

  it('should allow re-inviting after soft-delete', async () => {
    // First delete
    mockService.deleteMember.mockResolvedValue({
      message: 'Member test@test.com has been removed',
    })

    await request(setup())
      .delete('/api/admin/orgs/org-1/members/m1')

    // Then invite again (should succeed)
    mockService.inviteMember.mockResolvedValue({
      member: { id: 'm2', email: 'test@test.com' },
      message: 'test@test.com invited as member',
    })

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members')
      .send({ userId: 'u1', email: 'test@test.com' })

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
  })
})
