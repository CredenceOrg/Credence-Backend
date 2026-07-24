import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import createRateLimitOverridesAdminRouter from './rateLimitOverrides.js'
import { RateLimitOverrideService } from '../../services/rateLimitOverride/service.js'
import { InMemoryTenantRateLimitOverridesRepository } from '../../db/repositories/tenantRateLimitOverridesRepository.js'
import { AuditLogService } from '../../services/audit/index.js'
import { errorHandler } from '../../middleware/errorHandler.js'

vi.mock('../../middleware/auth.js', () => ({
  requireUserAuth: (req: Request, _res: Response, next: NextFunction) => {
    ;(req as any).user = { id: 'admin-1', email: 'admin@test.com', role: 'admin', tenantId: 'tenant-admin' }
    next()
  },
  requireAdminRole: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

function setupApp(service: RateLimitOverrideService) {
  const app = express()
  app.use(express.json())
  app.use('/api/admin/rate-limits/overrides', createRateLimitOverridesAdminRouter(service))
  app.use(errorHandler)
  return app
}

describe('Admin Rate Limit Overrides Routes', () => {
  let repository: InMemoryTenantRateLimitOverridesRepository
  let auditLogService: AuditLogService
  let service: RateLimitOverrideService
  let app: express.Application

  beforeEach(() => {
    repository = new InMemoryTenantRateLimitOverridesRepository()
    auditLogService = new AuditLogService()
    service = new RateLimitOverrideService(repository, auditLogService)
    app = setupApp(service)
  })

  describe('GET /api/admin/rate-limits/overrides', () => {
    it('returns empty list initially', async () => {
      const res = await request(app).get('/api/admin/rate-limits/overrides')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toEqual([])
    })
  })

  describe('POST /api/admin/rate-limits/overrides', () => {
    it('sets a rate limit override and returns 201', async () => {
      const res = await request(app)
        .post('/api/admin/rate-limits/overrides')
        .send({
          tenantId: 'tenant-partner-a',
          rateLimit: 8000,
          windowSize: 60,
          reason: 'Custom SLA agreement for enterprise partner',
        })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(res.body.data.tenantId).toBe('tenant-partner-a')
      expect(res.body.data.rateLimit).toBe(8000)

      const stored = await repository.findByTenantId('tenant-partner-a')
      expect(stored?.rateLimit).toBe(8000)
    })

    it('negative test: rejects request when reason is missing and returns 400 with typed error', async () => {
      const res = await request(app)
        .post('/api/admin/rate-limits/overrides')
        .send({
          tenantId: 'tenant-partner-a',
          rateLimit: 8000,
          windowSize: 60,
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Validation failed')
    })
  })

  describe('DELETE /api/admin/rate-limits/overrides/:tenantId', () => {
    it('removes a rate limit override and returns 200', async () => {
      await service.setOverride('tenant-partner-a', 8000, 60, 'Initial set', {
        id: 'admin-1',
        email: 'admin@test.com',
        tenantId: 'tenant-admin',
      })

      const res = await request(app)
        .delete('/api/admin/rate-limits/overrides/tenant-partner-a')
        .send({
          reason: 'Custom SLA expired',
        })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)

      const stored = await repository.findByTenantId('tenant-partner-a')
      expect(stored).toBeNull()
    })

    it('negative test: returns 404 when removing non-existent override', async () => {
      const res = await request(app)
        .delete('/api/admin/rate-limits/overrides/tenant-unknown')
        .send({
          reason: 'Attempt cleanup',
        })

      expect(res.status).toBe(404)
      expect(res.body.error).toContain('not found')
    })
  })
})
