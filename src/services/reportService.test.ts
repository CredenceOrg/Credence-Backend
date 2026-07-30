import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReportService } from './reportService.js'
import { ReportRepository } from '../db/repositories/reportRepository.js'
import { ReportJobStatus } from '../jobs/types.js'
import { cache } from '../cache/redis.js'
import { ReportStorageService } from './reportStorage.js'

vi.mock('../cache/redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }
}))

vi.mock('../cache/invalidation.js', async () => {
  const actual = await vi.importActual('../cache/invalidation.js')
  return {
    ...actual,
    invalidateCache: vi.fn()
  }
})

describe('ReportService', () => {
  let reportService: ReportService
  let mockReportRepository: any

  beforeEach(() => {
    vi.clearAllMocks()
    ReportStorageService.reset()

    mockReportRepository = {
      create: vi.fn(),
      findById: vi.fn(),
      updateStatus: vi.fn(),
    }

    process.env.REPORT_STORAGE_SIGNING_SECRET = 'test-report-signing-secret-32chr'
    process.env.REPORT_DOWNLOAD_BASE_URL = 'https://credence.example.com'

    const storage = new ReportStorageService()

    reportService = new ReportService(mockReportRepository as unknown as ReportRepository, storage)
  })

  describe('startReportGeneration', () => {
    it('should create a job in queued status and return it', async () => {
      const mockJob = {
        id: 'job-123',
        type: 'test-report',
        status: ReportJobStatus.QUEUED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      mockReportRepository.create.mockResolvedValue(mockJob)

      const job = await reportService.startReportGeneration('test-report')

      expect(job).toEqual(mockJob)
      expect(mockReportRepository.create).toHaveBeenCalledWith('test-report')
    })

    it('should delegate background processing to the worker', async () => {
      const mockJob = {
        id: 'job-123',
        type: 'test-report',
        status: ReportJobStatus.QUEUED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      mockReportRepository.create.mockResolvedValue(mockJob)

      // Spy on the worker's processReport
      const workerSpy = vi.spyOn((reportService as any).worker, 'processReport').mockResolvedValue(undefined)

      await reportService.startReportGeneration('test-report', 'tenant-custom')

      expect(workerSpy).toHaveBeenCalledWith('job-123', 'test-report', 'tenant-custom')
    })
  })

  describe('getReportStatus', () => {
    it('should return cached report if available', async () => {
      const mockJob = {
        id: 'job-123',
        type: 'test-report',
        status: ReportJobStatus.RUNNING,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      vi.mocked(cache.get).mockResolvedValue(mockJob)

      const result = await reportService.getReportStatus('job-123')

      expect(cache.get).toHaveBeenCalledWith('report', 'job-123')
      expect(mockReportRepository.findById).not.toHaveBeenCalled()
      expect(result).toEqual(mockJob)
    })

    it('should fetch from repository and cache if not in cache', async () => {
      const mockJob = {
        id: 'job-123',
        type: 'test-report',
        status: ReportJobStatus.COMPLETED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      vi.mocked(cache.get).mockResolvedValue(null)
      mockReportRepository.findById.mockResolvedValue(mockJob)

      const result = await reportService.getReportStatus('job-123')

      expect(mockReportRepository.findById).toHaveBeenCalledWith('job-123')
      expect(cache.set).toHaveBeenCalledWith('report', 'job-123', mockJob, 300)
      expect(result).toEqual(mockJob)
    })
  })

  describe('getSignedDownloadUrl', () => {
    it('returns a signed URL when storageKey is present', () => {
      const job = {
        id: 'job-123',
        type: 'test-report',
        status: ReportJobStatus.COMPLETED,
        storageKey: 'reports/tenant-1/job-123.pdf',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const url = reportService.getSignedDownloadUrl(job)
      expect(url).toContain('/api/reports/download/')
      expect(url).toContain('expires=')
      expect(url).toContain('signature=')
    })

    it('returns null when storageKey is missing', () => {
      const job = {
        id: 'job-123',
        type: 'test-report',
        status: ReportJobStatus.QUEUED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const url = reportService.getSignedDownloadUrl(job)
      expect(url).toBeNull()
    })
  })
})
