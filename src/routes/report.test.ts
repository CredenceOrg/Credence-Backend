import { describe, it, expect, vi, beforeEach } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import reportRouter from './report.js'
import { auditLogService } from '../services/audit/index.js'
import { errorHandler } from '../middleware/errorHandler.js'

vi.mock('../middleware/auth.js', () => ({
  requireApiKey: () => (req: Request, _res: Response, next: NextFunction) => {
    ;(req as any).apiKey = { tenantId: 'test-tenant', scope: 'enterprise' }
    next()
  },
  ApiScope: {
    ENTERPRISE: 'enterprise',
  },
}))

vi.mock('../services/audit/index.js', () => ({
  auditLogService: {
    getTopTalkers: vi.fn(),
  },
}))

vi.mock('../services/reportService.js', () => ({
  ReportService: class {
    startReportGeneration = vi.fn().mockResolvedValue({
      id: 'job-123',
      status: 'queued',
      type: 'top_talkers',
      createdAt: new Date().toISOString(),
    })
    getReportStatus = vi.fn().mockResolvedValue({
      id: 'job-123',
      status: 'completed',
      type: 'top_talkers',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    getSignedDownloadUrl = vi.fn().mockReturnValue('https://example.com/download/key?expires=123&signature=abc')
  },
}))

function setupApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/reports', reportRouter)
  app.use(errorHandler)
  return app
}

describe('Reports Router - Top Talkers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /api/reports/top-talkers', () => {
    it('returns top talkers report data successfully', async () => {
      vi.mocked(auditLogService.getTopTalkers).mockResolvedValueOnce({
        windowStart: '2026-07-24T17:45:00.000Z',
        windowEnd: '2026-07-24T18:45:00.000Z',
        windowMinutes: 60,
        totalRequests: 100,
        topTalkers: [
          { tenantId: 'tenant-a', requestCount: 70, percentage: 70, lastRequestAt: '2026-07-24T18:44:00.000Z' },
          { tenantId: 'tenant-b', requestCount: 30, percentage: 30, lastRequestAt: '2026-07-24T18:42:00.000Z' },
        ],
      })

      const res = await request(setupApp()).get('/api/reports/top-talkers?limit=5&windowMinutes=30')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.totalRequests).toBe(100)
      expect(res.body.data.topTalkers).toHaveLength(2)
      expect(res.body.data.topTalkers[0].tenantId).toBe('tenant-a')
      expect(auditLogService.getTopTalkers).toHaveBeenCalledWith(5, 30)
    })
  })

  describe('POST /api/reports with top_talkers type', () => {
    it('starts an asynchronous top talkers report generation job', async () => {
      const res = await request(setupApp())
        .post('/api/reports')
        .send({ type: 'top_talkers' })

      expect(res.status).toBe(202)
      expect(res.body.type).toBe('top_talkers')
      expect(res.body.jobId).toBe('job-123')
    })
  })

  describe('POST /api/reports — type validation', () => {
    it('returns 400 for an unknown report type', async () => {
      const res = await request(setupApp())
        .post('/api/reports')
        .send({ type: 'nonexistent_report' })

      expect(res.status).toBe(400)
      expect(res.body.details).toBeDefined()
    })

    it('returns 400 when type is missing', async () => {
      const res = await request(setupApp())
        .post('/api/reports')
        .send({})

      expect(res.status).toBe(400)
    })

    it('returns 400 when body is empty', async () => {
      const res = await request(setupApp())
        .post('/api/reports')
        .send()

      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /api/reports/:jobId', () => {
    it('cancels a report job', async () => {
      const { ReportService } = await import('../services/reportService.js')
      const mockCancel = vi.fn().mockResolvedValue({
        id: 'job-123',
        status: 'cancelled',
        type: 'top_talkers',
        failureReason: 'Cancelled by user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      ReportService.prototype.cancelReportJob = mockCancel

      const res = await request(setupApp()).delete('/api/reports/job-123')

      expect(res.status).toBe(200)
      expect(res.body.jobId).toBe('job-123')
      expect(res.body.status).toBe('cancelled')
      expect(res.body.failureReason).toBe('Cancelled by user')
      expect(mockCancel).toHaveBeenCalledWith('job-123')
    })
  })
})
