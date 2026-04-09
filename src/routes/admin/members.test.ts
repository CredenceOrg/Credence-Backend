import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import { createMembersRouter } from './member.ts'

// ---- Mock middleware ----
vi.mock('../../middleware/auth.ts', () => ({
  requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: 'admin-1', email: 'admin@test.com' }
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

vi.mock('../../services/members/service.ts', () => ({
  MemberService: vi.fn().mockImplementation(() => mockService),
}))

// ---- Mock pagination ----
vi.mock('../../lib/pagination.ts', () => ({
  parsePaginationParams: vi.fn().mockReturnValue({ page: 1, limit: 10, offset: 0 }),
  buildPaginationMeta: vi.fn().mockReturnValue({ totalPages: 1 }),
  PaginationValidationError: class extends Error {
    details = { limit: 'invalid' }
  },
}))

function setup() {
  const app = express()
  app.use(express.json())
  app.use('/api/orgs/:orgId/members', createMembersRouter())
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

  it('should return 400 for invalid pagination', async () => {
    const { parsePaginationParams } = await import('../../lib/pagination.ts')
    ;(parsePaginationParams as any).mockImplementationOnce(() => {
      throw new (class extends Error {
        details = {}
      })()
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
  })

  it('should return 404 if member not found on delete', async () => {
    mockService.deleteMember.mockRejectedValue(
      new Error('not found')
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
      member: { id: 'm1' },
      message: 'restored',
    })

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members/m1/restore')

    expect(res.status).toBe(200)
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

  it('should return 500 for unexpected restore error', async () => {
    mockService.restoreMember.mockRejectedValue(
      new Error('weird error')
    )

    const res = await request(setup())
      .post('/api/admin/orgs/org-1/members/m1/restore')

    expect(res.status).toBe(500)
  })
})